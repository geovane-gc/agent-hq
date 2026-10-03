import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { DeskItem, DeskModel, DeskStyle } from '@agent-hq/protocol';
import { BASIC_DESK } from '@agent-hq/protocol/catalog';
import { Model, type ModelName } from '../models.tsx';
import { NO_RAYCAST } from './Decorations.tsx';

// A workstation's furniture in its desk style: desk finish, chair, one to
// three monitors and the little things on the desk. Workstation-local
// coordinates: the agent sits at the origin facing -Z, the desk top is at
// y = 0.765.

const TOP = 0.765;
const url = (name: ModelName) => `${import.meta.env.BASE_URL}models/${name}.glb`;

const DESK_FINISH: Record<DeskModel, Record<string, string>> = {
  classic: {},
  walnut: { DeskTop: '#5e3f2a', Metal: '#2b2d33' },
  white: { DeskTop: '#f1efea', Metal: '#dcdcdc' },
  black: { DeskTop: '#2a2c31', Metal: '#16171b' },
};

/** What the desk model ships with that a style can take away. */
const BUILT_IN: Partial<Record<DeskItem, string[]>> = {
  mug: ['Mug', 'Coffee'],
  stationery: ['Notebook', 'PenCup', 'Pen0', 'Pen1', 'Pen2'],
};

function Desk({ model, items, accent }: { model: DeskModel; items: DeskItem[]; accent: string }) {
  const { scene } = useGLTF(url('desk'));
  const hidden = useMemo(() => new Set(Object.entries(BUILT_IN).filter(([id]) => !items.includes(id as DeskItem)).flatMap(([, names]) => names)), [items]);
  const key = `${model}|${[...hidden].join()}|${accent}`;
  const object = useMemo(() => {
    const recolor: Record<string, string> = { Accent: accent, ...DESK_FINISH[model] };
    const root = scene.clone(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = mesh.receiveShadow = true;
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (hidden.has(material.name)) mesh.visible = false;
      else if (recolor[material.name]) {
        const m = material.clone();
        m.color.set(recolor[material.name]);
        mesh.material = m;
      }
    });
    return root;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, key]);
  return <primitive object={object} position={[0, 0, -0.5]} />;
}

function Chair({ style, upholstery, accent }: { style: DeskStyle['chair']; upholstery: string; accent: string }) {
  if (style === 'executive') return <Model name="boss_chair" position={[0, 0, 0.08]} />;
  if (style === 'gaming') {
    return (
      <group position={[0, 0, 0.05]}>
        <Model name="chair" recolor={{ Upholstery: '#1d1f24' }} />
        {/* racing backrest with two stripes in the floor's accent */}
        <mesh position={[0, 0.98, 0.29]} castShadow raycast={NO_RAYCAST}>
          <boxGeometry args={[0.5, 0.62, 0.07]} />
          <meshStandardMaterial color="#1d1f24" roughness={0.6} />
        </mesh>
        {[-0.11, 0.11].map((x) => (
          <mesh key={x} position={[x, 0.98, 0.252]} raycast={NO_RAYCAST}>
            <boxGeometry args={[0.07, 0.6, 0.01]} />
            <meshStandardMaterial color={accent} roughness={0.5} />
          </mesh>
        ))}
      </group>
    );
  }
  return <Model name="chair" position={[0, 0, 0.05]} recolor={{ Upholstery: upholstery }} />;
}

/** Small things on the desk, each in its own spot. */
function Trinket({ id, accent }: { id: DeskItem; accent: string }) {
  switch (id) {
    case 'plant': return (
      <group position={[0.62, TOP, -0.86]}>
        <mesh position={[0, 0.05, 0]} castShadow raycast={NO_RAYCAST}><cylinderGeometry args={[0.055, 0.045, 0.1, 12]} /><meshStandardMaterial color="#c4673f" roughness={0.9} /></mesh>
        <mesh position={[0, 0.15, 0]} castShadow raycast={NO_RAYCAST}><sphereGeometry args={[0.08, 10, 8]} /><meshStandardMaterial color="#3f8a45" roughness={0.8} /></mesh>
      </group>
    );
    case 'lamp': return (
      <group position={[-0.6, TOP, -0.84]}>
        <mesh position={[0, 0.01, 0]} raycast={NO_RAYCAST}><cylinderGeometry args={[0.07, 0.08, 0.02, 14]} /><meshStandardMaterial color="#2b2f36" metalness={0.5} roughness={0.4} /></mesh>
        <mesh position={[0, 0.17, 0.03]} rotation={[0.25, 0, 0]} raycast={NO_RAYCAST}><cylinderGeometry args={[0.01, 0.01, 0.32, 6]} /><meshStandardMaterial color="#2b2f36" metalness={0.5} /></mesh>
        <mesh position={[0, 0.32, 0.1]} rotation={[0.9, 0, 0]} raycast={NO_RAYCAST}><coneGeometry args={[0.07, 0.11, 14, 1, true]} /><meshStandardMaterial color={accent} side={THREE.DoubleSide} /></mesh>
        <mesh position={[0, 0.3, 0.13]} raycast={NO_RAYCAST}><sphereGeometry args={[0.025, 8, 6]} /><meshStandardMaterial color="#fff6e0" emissive="#ffe1a8" emissiveIntensity={1.5} /></mesh>
      </group>
    );
    case 'figure': return (
      <group position={[0.64, TOP, -0.17]} rotation={[0, -0.5, 0]}>
        <mesh position={[0, 0.045, 0]} castShadow raycast={NO_RAYCAST}><sphereGeometry args={[0.04, 10, 8]} /><meshStandardMaterial color="#ffcf33" roughness={0.35} /></mesh>
        <mesh position={[0, 0.1, 0.012]} castShadow raycast={NO_RAYCAST}><sphereGeometry args={[0.026, 10, 8]} /><meshStandardMaterial color="#ffcf33" roughness={0.35} /></mesh>
        <mesh position={[0, 0.097, 0.04]} rotation={[Math.PI / 2, 0, 0]} raycast={NO_RAYCAST}><coneGeometry args={[0.012, 0.025, 8]} /><meshStandardMaterial color="#f76b15" /></mesh>
      </group>
    );
    case 'photo': return (
      <group position={[-0.62, TOP, -0.17]} rotation={[-0.25, 0.45, 0]}>
        <mesh position={[0, 0.07, 0]} castShadow raycast={NO_RAYCAST}><boxGeometry args={[0.13, 0.11, 0.012]} /><meshStandardMaterial color="#2b2f36" /></mesh>
        <mesh position={[0, 0.07, 0.007]} raycast={NO_RAYCAST}><planeGeometry args={[0.11, 0.09]} /><meshStandardMaterial color="#8fc1e8" /></mesh>
      </group>
    );
    case 'books': return (
      <group position={[-0.62, TOP, -0.55]}>
        {['#3d63dd', '#e5484d', '#30a46c'].map((c, i) => (
          <mesh key={c} position={[0, 0.012 + i * 0.024, 0]} rotation={[0, i * 0.25, 0]} castShadow raycast={NO_RAYCAST}>
            <boxGeometry args={[0.16, 0.022, 0.22]} />
            <meshStandardMaterial color={c} roughness={0.8} />
          </mesh>
        ))}
      </group>
    );
    default: return null; // mug and stationery come with the desk model
  }
}

/** Monitors: the main one always centered (the camera zooms into it), extras angled at the sides. */
const MONITORS: Record<1 | 2 | 3, Array<{ x: number; z: number; turn: number }>> = {
  1: [{ x: 0, z: -0.72, turn: 0 }],
  2: [{ x: 0, z: -0.74, turn: 0 }, { x: 0.62, z: -0.62, turn: -0.55 }],
  3: [{ x: 0, z: -0.74, turn: 0 }, { x: -0.62, z: -0.62, turn: 0.55 }, { x: 0.62, z: -0.62, turn: -0.55 }],
};

export function DeskSet(props: { style: DeskStyle | null; accent: string; upholstery: string; screen: Record<string, THREE.Material> }) {
  const style = props.style ?? BASIC_DESK;
  return (
    <>
      <Desk model={style.desk} items={style.items} accent={props.accent} />
      {MONITORS[style.monitors].map((m, i) => (
        <Model key={i} name="monitor" position={[m.x, TOP, m.z]} rotation={[0, m.turn, 0]} replace={props.screen} />
      ))}
      <Model name="keyboard" position={[0, TOP, -0.3]} />
      <Chair style={style.chair} upholstery={props.upholstery} accent={props.accent} />
      {style.items.map((id) => <Trinket key={id} id={id} accent={props.accent} />)}
    </>
  );
}
