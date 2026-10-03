import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { DecorItem, LightingPreset } from '@agent-hq/protocol';
import { catalogItem, type CatalogItem } from '@agent-hq/protocol/catalog';
import type { ModelName } from '../models.tsx';
import { DECOR_GLTF, itemModel } from './items.ts';
import { LIGHTING } from './lighting.tsx';
import { GLOW_MATERIALS, placement, type ItemModel } from './parts.ts';

// Renders a floor's decorations: one InstancedMesh per item type and
// material, so a hundred plants cost the same draw calls as one. Lamps add a
// few real point lights; clocks tell the real time.

const url = (name: ModelName) => `${import.meta.env.BASE_URL}models/${name}.glb`;
export const NO_RAYCAST = () => null;
/** Lights are expensive in forward rendering: the nearest lamps get a real light, the rest just glow. */
const MAX_LAMP_LIGHTS = 4;
const WHITE = new THREE.Color('#ffffff');

/** Loads the glTF models decorations reuse and returns a lookup for item builders. */
export function useDecorModels() {
  const gltfs = useGLTF(DECOR_GLTF.map(url)) as unknown as Array<{ scene: THREE.Object3D }>;
  const gltf = useCallback((name: ModelName) => gltfs[DECOR_GLTF.indexOf(name)]?.scene ?? new THREE.Group(), [gltfs]);
  return useCallback((itemId: string) => itemModel(itemId, gltf), [gltf]);
}

export const itemColor = (entry: CatalogItem | undefined, item: { color: string | null }) => item.color ?? entry?.tint ?? '#ffffff';

const tinted = new Map<string, THREE.Material>();
/** A tintable material colored for one non-instanced copy (ghost, thumbnail). */
function tintedMaterial(material: THREE.Material, color: string) {
  const key = `${material.uuid}:${color}`;
  let m = tinted.get(key);
  if (!m) {
    m = material.clone();
    (m as THREE.MeshStandardMaterial).color?.set(color);
    tinted.set(key, m);
  }
  return m;
}

/** One copy of an item as plain meshes: previews, thumbnails and the item being dragged. */
export function ItemMesh({ model, color, override }: { model: ItemModel; color: string; override?: THREE.Material }) {
  return (
    <group>
      {model.parts.map((p, i) => (
        <mesh
          key={i}
          geometry={p.geometry}
          material={override ?? (p.tint ? tintedMaterial(p.material, color) : p.material)}
          castShadow={!override && p.castShadow}
          receiveShadow={!override}
          raycast={NO_RAYCAST}
        />
      ))}
    </group>
  );
}

function capacityFor(n: number) {
  let c = 8;
  while (c < n) c *= 2;
  return c;
}

const m4 = new THREE.Matrix4();
const color = new THREE.Color();

function ItemInstances(props: { model: ItemModel; entry: CatalogItem | undefined; items: DecorItem[]; editing: boolean; onPick?: (id: string, e: ThreeEvent<PointerEvent>) => void }) {
  const { model, items } = props;
  const capacity = capacityFor(items.length);
  const meshes = useRef<Array<THREE.InstancedMesh | null>>([]);

  useLayoutEffect(() => {
    model.parts.forEach((part, pi) => {
      const mesh = meshes.current[pi];
      if (!mesh) return;
      items.forEach((item, i) => {
        mesh.setMatrixAt(i, m4.multiplyMatrices(placement(item.x, item.z, item.rotation), part.matrix));
        mesh.setColorAt(i, part.tint ? color.set(itemColor(props.entry, item)) : WHITE);
      });
      mesh.count = items.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
  }, [model, items, capacity, props.entry]);

  const pick = props.onPick;
  return (
    <>
      {model.parts.map((part, pi) => (
        <instancedMesh
          // A new capacity needs a new mesh (and a new instance buffer).
          key={`${pi}:${capacity}`}
          ref={(m) => { meshes.current[pi] = m; }}
          args={[part.geometry, part.material, capacity]}
          castShadow={part.castShadow}
          receiveShadow
          frustumCulled
          raycast={props.editing ? THREE.InstancedMesh.prototype.raycast : NO_RAYCAST}
          onPointerDown={pick ? (e) => {
            if (e.instanceId == null || !items[e.instanceId]) return;
            e.stopPropagation();
            pick(items[e.instanceId].id, e);
          } : undefined}
        />
      ))}
    </>
  );
}

/** A few pooled point lights for the lamps on this floor. */
function LampLights({ items, preset }: { items: DecorItem[]; preset: LightingPreset }) {
  const lamps = useMemo(() => items.map((i) => ({ item: i, entry: catalogItem(i.itemId) })).filter((l) => l.entry?.light).slice(0, MAX_LAMP_LIGHTS), [items]);
  const factor = (LIGHTING[preset] ?? LIGHTING.daylight).lamps;
  if (!lamps.length) return null;
  return (
    <>
      {/* A fixed pool: changing the number of lights would recompile every material. */}
      {Array.from({ length: MAX_LAMP_LIGHTS }, (_, i) => {
        const lamp = lamps[i];
        const light = lamp?.entry?.light;
        const pos = lamp ? new THREE.Vector3(0, light!.y, 0.25).applyMatrix4(placement(lamp.item.x, lamp.item.z, lamp.item.rotation)) : new THREE.Vector3(0, -10, 0);
        return (
          <pointLight
            key={i}
            position={pos}
            color={lamp ? (lamp.item.itemId === 'neon_sign' ? itemColor(lamp.entry, lamp.item) : light!.color) : '#000000'}
            intensity={lamp ? light!.intensity * factor * 1.6 : 0}
            distance={light?.distance ?? 1}
            decay={1.6}
          />
        );
      })}
    </>
  );
}

/** Clock hands showing the local time. */
function ClockHands({ item }: { item: DecorItem }) {
  const hour = useRef<THREE.Group>(null);
  const minute = useRef<THREE.Group>(null);
  const h = catalogItem('clock')?.height ?? 2;
  useFrame(() => {
    const d = new Date();
    const m = d.getMinutes() + d.getSeconds() / 60;
    if (minute.current) minute.current.rotation.z = -(m / 60) * Math.PI * 2;
    if (hour.current) hour.current.rotation.z = -(((d.getHours() % 12) + m / 60) / 12) * Math.PI * 2;
  });
  const matrix = useMemo(() => placement(item.x, item.z, item.rotation).clone(), [item.x, item.z, item.rotation]);
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      <group position={[0, h, 0.058]}>
        {/* each hand pivots at the clock's center */}
        <group ref={hour}>
          <mesh raycast={NO_RAYCAST} position={[0, 0.06, 0]}>
            <boxGeometry args={[0.022, 0.14, 0.006]} />
            <meshStandardMaterial color="#1c2026" />
          </mesh>
        </group>
        <group ref={minute} position={[0, 0, 0.004]}>
          <mesh raycast={NO_RAYCAST} position={[0, 0.085, 0]}>
            <boxGeometry args={[0.014, 0.2, 0.006]} />
            <meshStandardMaterial color="#1c2026" />
          </mesh>
        </group>
      </group>
    </group>
  );
}

export function Decorations(props: {
  items: DecorItem[];
  preset: LightingPreset;
  editing: boolean;
  /** Being moved: drawn by the editor instead. */
  hiddenId?: string | null;
  onPick?: (id: string, e: ThreeEvent<PointerEvent>) => void;
}) {
  const modelOf = useDecorModels();
  const groups = useMemo(() => {
    const map = new Map<string, DecorItem[]>();
    for (const item of props.items) {
      if (item.id === props.hiddenId) continue;
      const list = map.get(item.itemId) ?? [];
      list.push(item);
      map.set(item.itemId, list);
    }
    return map;
  }, [props.items, props.hiddenId]);

  // Lamp shades and bulbs glow brighter after dark.
  useEffect(() => {
    const factor = (LIGHTING[props.preset] ?? LIGHTING.daylight).lamps;
    for (const m of GLOW_MATERIALS) m.emissiveIntensity = (m.userData.baseGlow ?? 1) * factor;
  }, [props.preset]);

  return (
    <group>
      {[...groups].map(([itemId, list]) => {
        const model = modelOf(itemId);
        return model && <ItemInstances key={itemId} model={model} entry={catalogItem(itemId)} items={list} editing={props.editing} onPick={props.onPick} />;
      })}
      <LampLights items={props.items} preset={props.preset} />
      {props.items.filter((i) => i.itemId === 'clock' && i.id !== props.hiddenId).map((i) => <ClockHands key={i.id} item={i} />)}
    </group>
  );
}

