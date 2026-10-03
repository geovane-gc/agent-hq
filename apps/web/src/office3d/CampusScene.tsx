import { Suspense, useMemo, useRef, useState } from 'react';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { HtmlLayer, Label } from './Label.tsx';
import { Model } from './models.tsx';
import { RooftopSign, useFacadeMaterial } from './decor/Exterior.tsx';
import type { Building, Floor, ID, Snapshot } from '@agent-hq/protocol';
import { BUILDING_ICONS } from '@agent-hq/protocol/catalog';

// Outside view: one tower per building, one storey per floor. Lit windows
// show how many agents on that floor are working; a waving hand means someone
// there needs approval.

const STOREY = 1.1;
const SPACING = 7;
const ICON = BUILDING_ICONS;

function Storey(props: { building: Building; floor: Floor; world: Snapshot; index: number; onEnter: () => void; hovered: boolean; onHover: (h: boolean) => void }) {
  const agents = props.world.agents.filter((a) => a.floorId === props.floor.id);
  const working = agents.filter((a) => a.status === 'working' || a.status === 'awaiting_approval').length;
  const waiting = agents.some((a) => a.status === 'awaiting_approval');
  const facade = useFacadeMaterial(props.building, props.hovered, 4, STOREY);
  const windows = 6;
  return (
    <group
      position={[0, props.index * STOREY + STOREY / 2, 0]}
      onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); props.onEnter(); }}
      onPointerOver={(e) => { e.stopPropagation(); props.onHover(true); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { props.onHover(false); document.body.style.cursor = ''; }}
    >
      <mesh castShadow receiveShadow material={facade}>
        <boxGeometry args={[4, STOREY - 0.06, 4]} />
      </mesh>
      {[0, Math.PI / 2, Math.PI, -Math.PI / 2].map((rot) => (
        <group key={rot} rotation={[0, rot, 0]}>
          {Array.from({ length: windows }, (_, i) => {
            const lit = i < Math.round((working / Math.max(1, agents.length)) * windows) || (agents.length > 0 && i === 0);
            return (
              <mesh key={i} position={[-1.6 + i * 0.64, 0, 2.005]}>
                <planeGeometry args={[0.42, STOREY * 0.5]} />
                <meshBasicMaterial color={lit ? (waiting && i === 0 ? '#ffb347' : '#ffe9a8') : '#33435c'} toneMapped={false} />
              </mesh>
            );
          })}
        </group>
      ))}
      {(props.hovered || waiting) && (
        <Label position={[2.3, 0, 2.3]} center distanceFactor={14} zIndexRange={[20, 0]}>
          <button className="tag sign" onClick={props.onEnter}>
            {waiting ? '✋ ' : ''}{props.floor.level}F · {props.floor.name} · {agents.length} agents
          </button>
        </Label>
      )}
    </group>
  );
}

function Tower(props: { building: Building; world: Snapshot; position: [number, number, number]; onEnter: (floorId: ID) => void }) {
  // The rooftop sign shows the company (office) name unless the building has its own.
  const sign = props.building.sign || props.world.office?.name || props.building.name;
  const floors = props.world.floors.filter((f) => f.buildingId === props.building.id).sort((a, b) => a.level - b.level);
  const [hover, setHover] = useState<ID | null>(null);
  const height = floors.length * STOREY;
  return (
    <group position={props.position}>
      {/* plaza */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]} receiveShadow>
        <planeGeometry args={[5.6, 5.6]} />
        <meshStandardMaterial color="#c9c5bb" />
      </mesh>
      {floors.map((f, i) => (
        <Storey
          key={f.id}
          building={props.building}
          floor={f}
          world={props.world}
          index={i}
          hovered={hover === f.id}
          onHover={(h) => setHover(h ? f.id : null)}
          onEnter={() => props.onEnter(f.id)}
        />
      ))}
      <mesh position={[0, height + 0.1, 0]} castShadow>
        <boxGeometry args={[4.2, 0.2, 4.2]} />
        <meshStandardMaterial color="#4a4f5a" />
      </mesh>
      <RooftopSign text={sign} color={props.building.color} y={height + 0.2} />
    </group>
  );
}

function Tree({ position, round }: { position: [number, number, number]; round: boolean }) {
  return <Model name={round ? 'tree_round' : 'tree'} position={position} scale={round ? 1.1 : 1} />;
}

export function CampusScene(props: { world: Snapshot; onEnterFloor: (id: ID) => void; onNewBuilding: (() => void) | null }) {
  const buildings = [...props.world.buildings].sort((a, b) => a.createdAt - b.createdAt);
  const cols = Math.max(1, Math.ceil(Math.sqrt(buildings.length + 1)));
  const positions = buildings.map((_, i) => [((i % cols) - (cols - 1) / 2) * SPACING, 0, Math.floor(i / cols) * SPACING] as [number, number, number]);
  const next = buildings.length;
  const plot: [number, number, number] = [((next % cols) - (cols - 1) / 2) * SPACING, 0, Math.floor(next / cols) * SPACING];
  const size = (cols + 1) * SPACING;
  const htmlLayer = useRef<HTMLDivElement>(null);
  const trees = useMemo(() => Array.from({ length: 18 }, (_, i) => {
    const a = (i / 18) * Math.PI * 2;
    const r = size * 0.62 + (i % 3);
    return [Math.cos(a) * r, 0, Math.sin(a) * r + size * 0.2] as [number, number, number];
  }), [size]);

  return (
    <div className="scene">
      <HtmlLayer.Provider value={htmlLayer}>
      <Canvas shadows dpr={[1, 2]} camera={{ position: [size * 0.7, size * 0.6, size * 0.9], fov: 40 }}>
        <color attach="background" args={['#bcd7ef']} />
        <fog attach="fog" args={['#bcd7ef', size * 1.5, size * 3]} />
        <hemisphereLight args={['#ffffff', '#6b8f5a', 1]} />
        <directionalLight position={[20, 30, 15]} intensity={1.5} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.04}
          shadow-camera-left={-size} shadow-camera-right={size} shadow-camera-top={size} shadow-camera-bottom={-size} />
        <Suspense fallback={null}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <circleGeometry args={[size * 1.2, 48]} />
          <meshStandardMaterial color="#86b86b" />
        </mesh>
        {buildings.map((b, i) => (
          <Tower key={b.id} building={b} world={props.world} position={positions[i]} onEnter={props.onEnterFloor} />
        ))}
        {buildings.map((b, i) => {
          const storeys = props.world.floors.filter((f) => f.buildingId === b.id).length;
          return (
            <Label key={`sign-${b.id}`} position={[positions[i][0], storeys * STOREY + 1.9, positions[i][2]]} center distanceFactor={16} zIndexRange={[20, 0]}>
              <div className="tag building-sign" style={{ borderColor: b.color }}>
                {ICON[b.kind]} <strong>{b.name}</strong>
              </div>
            </Label>
          );
        })}
        {props.onNewBuilding && (
          <group position={plot}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
              <planeGeometry args={[4.6, 4.6]} />
              <meshStandardMaterial color="#d9cfa8" />
            </mesh>
            <Label position={[0, 0.6, 0]} center distanceFactor={14}>
              <button className="tag recruit" onClick={props.onNewBuilding}>＋ Build</button>
            </Label>
          </group>
        )}
        {trees.map((p, i) => <Tree key={i} position={p} round={i % 3 === 0} />)}
        </Suspense>
        <OrbitControls makeDefault target={[0, 1.5, size * 0.15]} maxPolarAngle={1.3} minDistance={6} maxDistance={size * 3} enableDamping />
      </Canvas>
      </HtmlLayer.Provider>
      <div ref={htmlLayer} className="html-layer" />
    </div>
  );
}
