import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { DECOR_CATALOG } from '@agent-hq/protocol/catalog';
import { ItemMesh, useDecorModels } from './Decorations.tsx';

// Catalog thumbnails, rendered from the real 3D items: one small offscreen
// canvas draws each item once, saves a PNG and moves on, then goes away (and
// with it its WebGL context). Kept for the rest of the session.

const thumbs = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function save(id: string, url: string) {
  thumbs.set(id, url);
  version++;
  for (const fn of listeners) fn();
}

/** Re-renders when thumbnails arrive; returns the lookup. */
export function useThumbnails(): (id: string) => string | undefined {
  useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => version);
  return (id) => thumbs.get(id);
}

const SIZE = 112;

function Shot({ id, onDone }: { id: string; onDone: (url: string | null) => void }) {
  const modelOf = useDecorModels();
  const model = modelOf(id);
  const entry = DECOR_CATALOG.find((i) => i.id === id);
  const { camera, gl, scene } = useThree();
  const frames = useRef(0);
  // Frame the item: a three-quarter view from the front right.
  const box = useMemo(() => {
    const b = new THREE.Box3();
    for (const p of model?.parts ?? []) {
      p.geometry.computeBoundingBox();
      b.union(p.geometry.boundingBox!.clone().applyMatrix4(p.matrix));
    }
    return b;
  }, [model]);
  useEffect(() => {
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const cam = camera as THREE.PerspectiveCamera;
    const dist = (size / 2) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * 1.05;
    const wall = entry?.mount === 'wall';
    const dir = wall ? new THREE.Vector3(0.35, 0.15, 1) : new THREE.Vector3(0.85, 0.75, 1);
    cam.position.copy(center).add(dir.normalize().multiplyScalar(dist));
    cam.lookAt(center);
    cam.updateProjectionMatrix();
  }, [box, camera, entry]);
  useFrame(() => {
    frames.current++;
    if (frames.current === 3) {
      gl.render(scene, camera);
      onDone(model ? gl.domElement.toDataURL('image/png') : null);
    }
  });
  return model ? <ItemMesh model={model} color={entry?.tint ?? '#ffffff'} /> : null;
}

/** Mount while the catalog is visible; renders the missing thumbnails, one per few frames. */
export function ThumbnailBaker() {
  const todo = useMemo(() => DECOR_CATALOG.map((i) => i.id).filter((id) => !thumbs.has(id)), []);
  const [index, setIndex] = useState(0);
  if (index >= todo.length) return null;
  const id = todo[index];
  return (
    <div className="decor-baker" aria-hidden>
      <Canvas
        dpr={1}
        style={{ width: SIZE, height: SIZE }}
        gl={{ preserveDrawingBuffer: true, alpha: true, antialias: true }}
        camera={{ fov: 30, near: 0.05, far: 50 }}
      >
        <hemisphereLight args={['#ffffff', '#8a7a66', 1.3]} />
        <directionalLight position={[3, 5, 4]} intensity={1.6} />
        <Suspense fallback={null}>
          <Shot key={id} id={id} onDone={(url) => { if (url) save(id, url); setIndex((i) => i + 1); }} />
        </Suspense>
      </Canvas>
    </div>
  );
}
