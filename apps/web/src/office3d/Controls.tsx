import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { findInteractable } from './interact.ts';
import type { Rect, Vec3 } from './layout.ts';

export type CameraMode = 'iso' | 'first';

const EYE = 1.62;
const WALK_SPEED = 3.2;
const RUN_SPEED = 6;
const ACCEL = 12;
const RADIUS = 0.28;
const MOUSE_SENSITIVITY = 0.0022;
/** Pointer-lock deltas above this are browser glitches (a known Windows issue), not real motion. */
const MAX_MOUSE_DELTA = 220;

/** Keys typed into inputs or terminals must never move the camera. */
function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t?.closest?.('input, textarea, select, [contenteditable="true"], .xterm, [data-captures-keys]');
}

function usePressedKeys() {
  const keys = useRef(new Set<string>());
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (!isTyping(e)) keys.current.add(e.code); };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const blur = () => keys.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
  return keys;
}

/**
 * Elevated orbit camera: drag to rotate, right-drag to pan, wheel to zoom,
 * WASD / arrows to slide around.
 */
export function IsoControls(props: { center: Vec3; span: number; restoreTarget: THREE.Vector3 | null }) {
  const { camera } = useThree();
  const controls = useRef<OrbitControlsImpl>(null);
  const keys = usePressedKeys();
  const target = useMemo(() => props.restoreTarget?.clone() ?? new THREE.Vector3(...props.center), [props.restoreTarget, props.center]);

  useEffect(() => {
    if (props.restoreTarget) return; // coming back from a zoom: keep the camera where it was
    const [cx, , cz] = props.center;
    camera.position.set(cx + props.span * 0.18, props.span * 0.62, cz + props.span * 0.62);
    camera.lookAt(...props.center);
  }, [camera, props.center, props.span, props.restoreTarget]);

  useFrame((_, dt) => {
    const k = keys.current;
    const c = controls.current;
    if (!c || k.size === 0) return;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
    const move = new THREE.Vector3();
    if (k.has('KeyW') || k.has('ArrowUp')) move.add(forward);
    if (k.has('KeyS') || k.has('ArrowDown')) move.sub(forward);
    if (k.has('KeyD') || k.has('ArrowRight')) move.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) move.sub(right);
    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(props.span * 0.6 * Math.min(dt, 0.05));
    camera.position.add(move);
    c.target.add(move);
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      target={target}
      maxPolarAngle={1.25}
      minDistance={4}
      maxDistance={props.span * 2}
      enableDamping
      dampingFactor={0.12}
      rotateSpeed={0.6}
    />
  );
}

function resolveCollisions(pos: THREE.Vector3, bounds: Rect, colliders: Rect[]) {
  pos.x = THREE.MathUtils.clamp(pos.x, bounds.minX + RADIUS + 0.08, bounds.maxX - RADIUS - 0.08);
  pos.z = THREE.MathUtils.clamp(pos.z, bounds.minZ + RADIUS + 0.08, bounds.maxZ - RADIUS - 0.08);
  for (const r of colliders) {
    // closest point on the box to the player's center
    const cx = THREE.MathUtils.clamp(pos.x, r.minX, r.maxX);
    const cz = THREE.MathUtils.clamp(pos.z, r.minZ, r.maxZ);
    const dx = pos.x - cx;
    const dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= RADIUS * RADIUS) continue;
    if (d2 > 1e-8) {
      // push out along the contact normal: slides along walls instead of sticking
      const d = Math.sqrt(d2);
      pos.x = cx + (dx / d) * RADIUS;
      pos.z = cz + (dz / d) * RADIUS;
    } else {
      // center inside the box: leave through the nearest side
      const exits = [pos.x - r.minX, r.maxX - pos.x, pos.z - r.minZ, r.maxZ - pos.z];
      const i = exits.indexOf(Math.min(...exits));
      if (i === 0) pos.x = r.minX - RADIUS;
      else if (i === 1) pos.x = r.maxX + RADIUS;
      else if (i === 2) pos.z = r.minZ - RADIUS;
      else pos.z = r.maxZ + RADIUS;
    }
  }
}

/**
 * First-person walking: WASD (Shift to run), mouse to look, click to use
 * whatever is under the crosshair. Escape releases the mouse.
 */
export function FirstPersonControls(props: {
  bounds: Rect;
  colliders: Rect[];
  spawn: Vec3;
  /** Resume from the current camera pose (after zooming into a monitor). */
  restore: boolean;
  onHover: (label: string | null) => void;
  onLockChange: (locked: boolean) => void;
  onMove?: (position: Vec3, rotation: number) => void;
  /** Receives a function that captures the mouse (call it from a user click). */
  lockRef: { current: (() => void) | null };
}) {
  const { camera, scene, gl } = useThree();
  const keys = usePressedKeys();
  const locked = useRef(false);
  const yaw = useRef(-Math.PI * 0.42);
  const pitch = useRef(0);
  const velocity = useRef(new THREE.Vector3());
  const bob = useRef(0);
  const hovered = useRef<string | null>(null);
  const raycaster = useRef(new THREE.Raycaster());
  const lastSent = useRef(0);
  const ground = useRef(new THREE.Vector3());

  useEffect(() => {
    if (props.restore) {
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      yaw.current = e.y;
      pitch.current = e.x;
      ground.current.set(camera.position.x, 0, camera.position.z);
    } else {
      ground.current.set(props.spawn[0], 0, props.spawn[2]);
      yaw.current = -Math.PI * 0.42; // face the desks
      pitch.current = 0;
    }
    camera.position.set(ground.current.x, EYE, ground.current.z);
    camera.quaternion.setFromEuler(new THREE.Euler(pitch.current, yaw.current, 0, 'YXZ'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  // The mouse listeners are attached once per mount. Re-running them on every
  // render (presence updates re-render the scene several times a second)
  // would tear down the pointer lock right after it is acquired, so the
  // callbacks they need are read from a ref instead.
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    const el = gl.domElement;
    const lockRef = props.lockRef;
    lockRef.current = () => {
      // Raw mouse input avoids OS acceleration and most of Chrome's jump glitches.
      // Not every platform supports it: fall back to a plain lock (still within the click's activation window).
      const req = el.requestPointerLock({ unadjustedMovement: true } as PointerLockOptions) as unknown as Promise<void> | undefined;
      req?.catch?.(() => (el.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}));
    };
    const onLockChange = () => {
      locked.current = document.pointerLockElement === el;
      callbacks.current.onLockChange(locked.current);
      if (!locked.current) callbacks.current.onHover(null);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!locked.current) return;
      if (Math.abs(e.movementX) > MAX_MOUSE_DELTA || Math.abs(e.movementY) > MAX_MOUSE_DELTA) return;
      yaw.current -= e.movementX * MOUSE_SENSITIVITY;
      pitch.current = THREE.MathUtils.clamp(pitch.current - e.movementY * MOUSE_SENSITIVITY, -1.45, 1.45);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!locked.current || e.button !== 0) return;
      const target = pick();
      if (target) {
        document.exitPointerLock();
        target.action();
      }
    };
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      lockRef.current = null;
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mousedown', onMouseDown);
      if (document.pointerLockElement === el) document.exitPointerLock();
      if (locked.current) {
        locked.current = false;
        callbacks.current.onLockChange(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, props.lockRef]);

  function pick() {
    raycaster.current.setFromCamera(new THREE.Vector2(0, 0), camera);
    raycaster.current.far = 4;
    for (const hit of raycaster.current.intersectObjects(scene.children, true)) {
      const i = findInteractable(hit.object);
      if (i) return i;
    }
    return null;
  }

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const k = keys.current;
    camera.quaternion.setFromEuler(new THREE.Euler(pitch.current, yaw.current, 0, 'YXZ'));

    const forward = new THREE.Vector3(-Math.sin(yaw.current), 0, -Math.cos(yaw.current));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const wish = new THREE.Vector3();
    if (locked.current) {
      if (k.has('KeyW') || k.has('ArrowUp')) wish.add(forward);
      if (k.has('KeyS') || k.has('ArrowDown')) wish.sub(forward);
      if (k.has('KeyD') || k.has('ArrowRight')) wish.add(right);
      if (k.has('KeyA') || k.has('ArrowLeft')) wish.sub(right);
    }
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(k.has('ShiftLeft') || k.has('ShiftRight') ? RUN_SPEED : WALK_SPEED);
    // ease towards the wished velocity: no instant starts or stops
    velocity.current.lerp(wish, 1 - Math.exp(-ACCEL * dt));
    if (velocity.current.lengthSq() < 1e-5) velocity.current.set(0, 0, 0);

    const pos = ground.current;
    pos.x += velocity.current.x * dt;
    resolveCollisions(pos, props.bounds, props.colliders);
    pos.z += velocity.current.z * dt;
    resolveCollisions(pos, props.bounds, props.colliders);

    const speed = velocity.current.length();
    bob.current += speed * dt * 2.4;
    camera.position.set(pos.x, EYE + Math.sin(bob.current * Math.PI) * 0.025 * Math.min(1, speed / WALK_SPEED), pos.z);

    if (locked.current) {
      const label = pick()?.label ?? null;
      if (label !== hovered.current) {
        hovered.current = label;
        props.onHover(label);
      }
    }
    const now = performance.now();
    if (props.onMove && now - lastSent.current > 150) {
      lastSent.current = now;
      props.onMove([pos.x, 0, pos.z], yaw.current);
    }
  });

  return null;
}

/**
 * Flies the camera to a pose, either looking at a point or matching an
 * orientation, then calls `onDone`.
 */
export function CameraFly(props: {
  position: THREE.Vector3;
  lookAt?: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  duration?: number;
  onDone: () => void;
}) {
  const { camera } = useThree();
  const start = useRef<{ p: THREE.Vector3; q: THREE.Quaternion } | null>(null);
  const t = useRef(0);
  const done = useRef(false);
  const endQuat = useMemo(() => {
    if (props.quaternion) return props.quaternion.clone();
    const m = new THREE.Matrix4().lookAt(props.position, props.lookAt ?? new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }, [props.position, props.lookAt, props.quaternion]);

  useFrame((_, dt) => {
    start.current ??= { p: camera.position.clone(), q: camera.quaternion.clone() };
    t.current = Math.min(1, t.current + dt / (props.duration ?? 0.9));
    const e = t.current < 0.5 ? 4 * t.current ** 3 : 1 - (-2 * t.current + 2) ** 3 / 2; // ease in-out
    camera.position.lerpVectors(start.current.p, props.position, e);
    camera.quaternion.slerpQuaternions(start.current.q, endQuat, e);
    if (t.current >= 1 && !done.current) {
      done.current = true;
      props.onDone();
    }
  });
  return null;
}
