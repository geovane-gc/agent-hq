import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { FloorTheme } from '@agent-hq/protocol';
import { WALL_HEIGHT, type FloorPlan } from '../layout.ts';
import { LIGHTING } from './lighting.tsx';
import { floorLook, tiled, timeOfDay, viewTexture, wallLook } from './textures.ts';

// Room style pieces used by Room.tsx: the floor surface, styled walls (paint,
// brick, wood panels, concrete or glass), the view behind windows and glass.

export function StyledFloor({ plan, theme }: { plan: FloorPlan; theme: FloorTheme }) {
  const w = plan.maxX - plan.minX;
  const d = plan.maxZ - plan.minZ;
  const look = floorLook(theme.floor) ?? floorLook('wood');
  const texture = useMemo(() => (look.texture ? tiled(look.texture, look.tile, w, d) : null), [look.texture, look.tile, w, d]);
  useEffect(() => () => texture?.dispose(), [texture]);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[plan.minX + w / 2, 0, plan.minZ + d / 2]} receiveShadow>
      <planeGeometry args={[w, d]} />
      <meshStandardMaterial map={texture} color={look.color} roughness={look.roughness} />
    </mesh>
  );
}

/** A wall in the floor's finish. Full-height walls become curtain glass with the glass finish. */
export function StyledWall(props: { from: [number, number]; to: [number, number]; height: number; theme: FloorTheme; y?: number }) {
  const [x1, z1] = props.from;
  const [x2, z2] = props.to;
  const len = Math.hypot(x2 - x1, z2 - z1);
  const angle = Math.atan2(z2 - z1, x2 - x1);
  const glass = props.theme.wall === 'glass' && props.height >= WALL_HEIGHT - 0.01;
  // Short walls (cut away in the overview) keep a solid finish: glass would vanish.
  const finish = props.theme.wall === 'glass' ? 'paint' : props.theme.wall;
  const look = wallLook(finish);
  const texture = useMemo(() => (look.texture ? tiled(look.texture, look.tile, len, props.height) : null), [look.texture, look.tile, len, props.height]);
  useEffect(() => () => texture?.dispose(), [texture]);
  const position: [number, number, number] = [(x1 + x2) / 2, (props.y ?? 0) + props.height / 2, (z1 + z2) / 2];
  if (glass) {
    const mullions = Math.max(1, Math.round(len / 1.6));
    return (
      <group position={[(x1 + x2) / 2, props.y ?? 0, (z1 + z2) / 2]} rotation={[0, -angle, 0]}>
        <mesh position={[0, props.height / 2, 0]} raycast={() => null}>
          <boxGeometry args={[len, props.height, 0.04]} />
          <meshPhysicalMaterial color="#cfe8ff" transparent opacity={0.16} roughness={0.05} depthWrite={false} />
        </mesh>
        {Array.from({ length: mullions + 1 }, (_, i) => (
          <mesh key={i} position={[-len / 2 + (i * len) / mullions, props.height / 2, 0]}>
            <boxGeometry args={[0.06, props.height, 0.1]} />
            <meshStandardMaterial color="#4a505c" metalness={0.4} roughness={0.4} />
          </mesh>
        ))}
        {[0.03, props.height - 0.03].map((y) => (
          <mesh key={y} position={[0, y, 0]}>
            <boxGeometry args={[len, 0.06, 0.12]} />
            <meshStandardMaterial color="#4a505c" metalness={0.4} roughness={0.4} />
          </mesh>
        ))}
      </group>
    );
  }
  return (
    <mesh position={position} rotation={[0, -angle, 0]} castShadow receiveShadow>
      <boxGeometry args={[len, props.height, 0.15]} />
      <meshStandardMaterial color={props.theme.wallColor} map={texture} roughness={look.roughness} />
    </mesh>
  );
}

/** What windows show: the floor's view, at the time of day its lighting suggests. */
export function useViewTexture(theme: FloorTheme) {
  return viewTexture(theme.view ?? 'city', timeOfDay(theme.lighting ?? 'daylight'));
}

/**
 * The outside, seen through glass walls: big painted backdrops around the
 * room. In the overview only behind the back and left walls (the camera
 * looks in from the front and right).
 */
export function Backdrop({ plan, theme, cutaway }: { plan: FloorPlan; theme: FloorTheme; cutaway: boolean }) {
  const view = useViewTexture(theme);
  const cx = (plan.minX + plan.maxX) / 2;
  const cz = (plan.minZ + plan.maxZ) / 2;
  const far = 24;
  const w = plan.maxX - plan.minX + far * 2;
  const d = plan.maxZ - plan.minZ + far * 2;
  // The painted view repeats along the horizon: about one picture every 16 m.
  const map = useMemo(() => {
    const t = view.clone();
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(Math.max(1, Math.round(Math.max(w, d) / 16)), 1);
    t.needsUpdate = true;
    return t;
  }, [view, w, d]);
  useEffect(() => () => map.dispose(), [map]);
  const sides: Array<{ position: [number, number, number]; rotation: number; size: number }> = [
    { position: [cx, 3, plan.minZ - far], rotation: 0, size: w },
    { position: [plan.minX - far, 3, cz], rotation: Math.PI / 2, size: d },
    ...(cutaway ? [] : [
      { position: [cx, 3, plan.maxZ + far] as [number, number, number], rotation: Math.PI, size: w },
      { position: [plan.maxX + far, 3, cz] as [number, number, number], rotation: -Math.PI / 2, size: d },
    ]),
  ];
  return (
    <group>
      {sides.map((s, i) => (
        <mesh key={i} position={s.position} rotation={[0, s.rotation, 0]} raycast={() => null}>
          <planeGeometry args={[s.size, 12]} />
          <meshBasicMaterial map={map} toneMapped={false} fog={false} />
        </mesh>
      ))}
    </group>
  );
}

/** Ceiling and ceiling panel colors for the lighting preset. */
export const ceilingColors = (theme: FloorTheme) => {
  const l = LIGHTING[theme.lighting] ?? LIGHTING.daylight;
  return { panel: l.panel, ceiling: l.ceiling };
};

