import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Building } from '@agent-hq/protocol';
import { canvasTexture, DECAL } from '../textures.ts';
import { facadeLook, tiled } from './textures.ts';

// Building exteriors on the campus: the facade material (tinted by the
// building color) and a rooftop sign with the company name.

/** The facade material of one storey (`w` × `h` meters per side). */
export function useFacadeMaterial(building: Building, hovered: boolean, w: number, h: number) {
  const facade = building.facade ?? 'paint';
  const look = facadeLook(facade);
  const texture = useMemo(() => (look.texture ? tiled(look.texture, look.tile, w, h) : null), [look.texture, look.tile, w, h]);
  const material = useMemo(() => {
    const base = new THREE.Color(building.color);
    // Glass: a tinted, reflective curtain wall; the rest: the building color over the material.
    const color = facade === 'glass' ? base.clone().lerp(new THREE.Color('#b9dcf5'), 0.7) : base;
    return new THREE.MeshStandardMaterial({ color, map: texture, roughness: look.roughness, metalness: look.metalness });
  }, [building.color, facade, texture, look.roughness, look.metalness]);
  useEffect(() => {
    material.emissive.set(hovered ? '#ffffff' : '#000000');
    material.emissiveIntensity = hovered ? 0.12 : 0;
  }, [material, hovered]);
  useEffect(() => () => { material.dispose(); texture?.dispose(); }, [material, texture]);
  return material;
}

const signs = new Map<string, THREE.CanvasTexture>();
function signTexture(text: string, color: string) {
  const key = `${text}|${color}`;
  let t = signs.get(key);
  if (!t) {
    t = canvasTexture(512, 96, (ctx) => {
      ctx.fillStyle = '#1c2026';
      ctx.fillRect(0, 0, 512, 96);
      ctx.fillStyle = color;
      ctx.fillRect(0, 86, 512, 10);
      ctx.fillStyle = '#ffffff';
      let size = 56;
      ctx.font = `800 ${size}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
      while (ctx.measureText(text).width > 480 && size > 18) {
        size -= 2;
        ctx.font = `800 ${size}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 256, 46);
    });
    signs.set(key, t);
  }
  return t;
}

/** A lit sign on the roof, facing the campus camera (+Z). */
export function RooftopSign({ text, color, y }: { text: string; color: string; y: number }) {
  const map = signTexture(text.trim() || 'Agent HQ', color);
  return (
    <group position={[0, y, 0.8]}>
      {[-1.4, 1.4].map((x) => (
        <mesh key={x} position={[x, 0.25, 0]}>
          <boxGeometry args={[0.08, 0.5, 0.08]} />
          <meshStandardMaterial color="#3a3f4b" metalness={0.5} roughness={0.4} />
        </mesh>
      ))}
      <mesh position={[0, 0.72, 0]} castShadow>
        <boxGeometry args={[3.7, 0.7, 0.1]} />
        <meshStandardMaterial color="#1c2026" />
      </mesh>
      <mesh position={[0, 0.72, 0.051]}>
        <planeGeometry args={[3.6, 0.66]} />
        <meshBasicMaterial map={map} toneMapped={false} {...DECAL} />
      </mesh>
    </group>
  );
}
