import { useMemo } from 'react';
import { Label } from './Label.tsx';
import { Model } from './models.tsx';
import type { FloorTheme, Task } from '@agent-hq/protocol';
import { fixtures, meetingRoom, WALL_HEIGHT, windowSpots, type FloorPlan, type Rect } from './layout.ts';
import type { Interactable } from './interact.ts';
import { Backdrop, ceilingColors, StyledFloor, StyledWall, useViewTexture } from './decor/RoomStyle.tsx';
import type * as THREE from 'three';

const WALL_H = WALL_HEIGHT;
const CUTAWAY_H = 0.25;

function Glass(props: { from: [number, number]; to: [number, number] }) {
  const [x1, z1] = props.from;
  const [x2, z2] = props.to;
  const len = Math.hypot(x2 - x1, z2 - z1);
  const angle = Math.atan2(z2 - z1, x2 - x1);
  return (
    <group position={[(x1 + x2) / 2, 0, (z1 + z2) / 2]} rotation={[0, -angle, 0]}>
      <mesh position={[0, 1.25, 0]} raycast={() => null}>
        <boxGeometry args={[len, 2.5, 0.04]} />
        <meshPhysicalMaterial color="#bfe3ff" transparent opacity={0.22} roughness={0.05} />
      </mesh>
      <mesh position={[0, 2.5, 0]}>
        <boxGeometry args={[len, 0.06, 0.08]} />
        <meshStandardMaterial color="#5a5f6a" metalness={0.2} />
      </mesh>
    </group>
  );
}

function Window({ x, z, rotation, view }: { x: number; z: number; rotation: number; view: THREE.Texture }) {
  return (
    <group position={[x, 1.6, z]} rotation={[0, rotation, 0]}>
      <mesh>
        <boxGeometry args={[1.8, 1.4, 0.18]} />
        <meshStandardMaterial color="#d9dde3" />
      </mesh>
      <mesh position={[0, 0, 0.1]}>
        <planeGeometry args={[1.6, 1.2]} />
        <meshBasicMaterial map={view} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, 0.11]}>
        <boxGeometry args={[0.05, 1.2, 0.02]} />
        <meshStandardMaterial color="#d9dde3" />
      </mesh>
    </group>
  );
}

function Plant({ position, scale = 1, tall = false }: { position: [number, number, number]; scale?: number; tall?: boolean }) {
  return <Model name={tall ? 'plant_tall' : 'plant'} position={position} scale={scale} />;
}

function Whiteboard(props: { position: [number, number, number]; tasks: Task[]; interact: Interactable }) {
  const columns: Array<[Task['status'], string]> = [['todo', '#ffd84d'], ['in_progress', '#7cc7ff'], ['review', '#ffa94d'], ['done', '#8ce99a']];
  return (
    <group position={props.position} userData={{ interact: props.interact }}>
      <Model name="whiteboard" />
      {/* one sticky note per task (up to 8 per column) */}
      {columns.map(([status, color], c) => {
        const count = Math.min(8, props.tasks.filter((t) => t.status === status).length);
        return Array.from({ length: count }, (_, i) => (
          <mesh key={`${status}${i}`} position={[-1.35 + c * 0.8 + (i % 2) * 0.3, 2.05 - Math.floor(i / 2) * 0.27, 0.072]} rotation={[0, 0, ((i * 7) % 5 - 2) * 0.04]}>
            <boxGeometry args={[0.24, 0.22, 0.01]} />
            <meshStandardMaterial color={color} />
          </mesh>
        ));
      })}
      <Label position={[0, 2.55, 0.05]} center distanceFactor={15} zIndexRange={[10, 0]}>
        <button className="tag sign" onClick={props.interact.action}>📋 Task board</button>
      </Label>
    </group>
  );
}

function Elevator(props: { position: [number, number, number]; level: number; interact: Interactable }) {
  return (
    <group position={props.position} userData={{ interact: props.interact }}>
      <Model name="elevator" />
      <Label position={[0, 2.62, 0.2]} center distanceFactor={15} zIndexRange={[10, 0]}>
        <button className="tag sign elevator" onClick={props.interact.action}>🛗 {props.level}F</button>
      </Label>
    </group>
  );
}

function Lounge({ position, accent }: { position: [number, number, number]; accent: string }) {
  return (
    <group position={position}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, -0.2]} receiveShadow>
        <circleGeometry args={[1.7, 40]} />
        <meshStandardMaterial color={accent} roughness={1} transparent opacity={0.5} />
      </mesh>
      <Model name="sofa" position={[0, 0, -0.95]} />
      <Model name="coffee_table" position={[0, 0, 0.25]} />
      <Model name="floor_lamp" position={[-1.45, 0, -1.1]} />
      <Model name="coffee_machine" position={[2.2, 0, -1.0]} />
    </group>
  );
}

function BossRoom(props: { plan: FloorPlan; interact: Interactable; cutaway: boolean; unread: number }) {
  const b = props.plan.boss;
  const f = fixtures(props.plan);
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  return (
    <group>
      {/* glass partitions with a door gap */}
      <Glass from={[b.maxX, b.minZ]} to={[b.maxX, b.maxZ - 1.4]} />
      {props.cutaway ? null : <Glass from={[b.minX, b.maxZ]} to={[b.maxX, b.maxZ]} />}
      {props.cutaway && (
        <mesh position={[cx, 0.1, b.maxZ]}>
          <boxGeometry args={[b.maxX - b.minX, 0.2, 0.06]} />
          <meshStandardMaterial color="#5a5f6a" />
        </mesh>
      )}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.006, cz]} receiveShadow>
        <planeGeometry args={[b.maxX - b.minX - 0.6, b.maxZ - b.minZ - 0.6]} />
        <meshStandardMaterial color="#3a2f2a" roughness={1} />
      </mesh>
      {/* executive desk, the boss facing the door */}
      <group position={f.bossDesk} rotation={[0, f.bossDeskRotation, 0]} userData={{ interact: props.interact }}>
        <Model name="boss_desk" position={[0, 0, -0.55]} />
        {[-0.42, 0.42].map((x) => (
          <Model key={x} name="monitor" position={[x, 0.795, -0.8]} rotation={[0, x * -0.6, 0]} />
        ))}
        <Model name="keyboard" position={[0, 0.795, -0.38]} />
        <Model name="boss_chair" position={[0, 0, 0.2]} />
        <Label position={[0, 1.32, -1.05]} center distanceFactor={15} zIndexRange={[10, 0]}>
          <button className="tag sign boss" onClick={props.interact.action}>
            👑 Boss computer{props.unread ? <span className="mail-badge">📧 {props.unread}</span> : null}
          </button>
        </Label>
      </group>
      <Plant position={f.bossPlant} scale={1.1} tall />
      <Model name="floor_lamp" position={f.bossLamp} />
    </group>
  );
}

/** A ceiling with light panels over the desks, for the first-person view. */
function Ceiling({ plan, panel, ceiling }: { plan: FloorPlan; panel: string; ceiling: string }) {
  const w = plan.maxX - plan.minX;
  const d = plan.maxZ - plan.minZ;
  const panels: Array<[number, number]> = [];
  for (let x = plan.minX + 2; x < plan.maxX - 1; x += 3) {
    for (let z = plan.minZ + 1.6; z < plan.maxZ - 1; z += 3) panels.push([x, z]);
  }
  return (
    <group>
      <mesh position={[plan.minX + w / 2, WALL_H, plan.minZ + d / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w, d]} />
        <meshBasicMaterial color={ceiling} />
      </mesh>
      {panels.map(([x, z]) => (
        <mesh key={`${x},${z}`} position={[x, WALL_H - 0.02, z]} rotation={[Math.PI / 2, 0, 0]}>
          <planeGeometry args={[1.2, 0.6]} />
          <meshBasicMaterial color={panel} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

export function Room(props: {
  plan: FloorPlan;
  theme: FloorTheme;
  level: number;
  tasks: Task[];
  cutaway: boolean;
  onBoard: () => void;
  onElevator: () => void;
  onTerminal: (() => void) | null;
  /** Unread reports in your inbox, shown on the boss computer. */
  unread?: number;
  /** The balcony outside the front wall: that stretch of wall is glass. */
  balcony: Rect;
}) {
  const { plan, theme, balcony } = props;
  const f = fixtures(plan);
  const sideH = props.cutaway ? CUTAWAY_H : WALL_H;
  const glass = theme.wall === 'glass';
  const view = useViewTexture(theme);
  // Glass walls have no windows: the whole wall is one.
  const windows = useMemo(() => (glass ? { back: [], left: [] } : windowSpots(plan)), [plan, glass]);
  // The meeting room's wall screen hangs on the left wall: glass walls stay solid behind it (windowSpots skips it too).
  const meeting = useMemo(() => meetingRoom(plan), [plan]);
  const solidTheme = useMemo(() => (glass ? { ...theme, wall: 'paint' as const } : theme), [theme, glass]);

  const terminal: Interactable = props.onTerminal
    ? { label: 'Boss computer — mail', action: props.onTerminal }
    : { label: 'Boss computer', action: () => {} };

  return (
    <group>
      <StyledFloor plan={plan} theme={theme} />
      {!props.cutaway && <Ceiling plan={plan} {...ceilingColors(theme)} />}
      {glass && <Backdrop plan={plan} theme={theme} cutaway={props.cutaway} />}
      {/* back and left walls are always full height; front and right are cut away in the overview */}
      <StyledWall from={[plan.minX, plan.minZ]} to={[plan.maxX, plan.minZ]} height={WALL_H} theme={theme} />
      <StyledWall from={[plan.minX, plan.minZ]} to={[plan.minX, meeting.minZ]} height={WALL_H} theme={theme} />
      <StyledWall from={[plan.minX, meeting.minZ]} to={[plan.minX, meeting.maxZ]} height={WALL_H} theme={solidTheme} />
      {meeting.maxZ < plan.maxZ - 0.01 && <StyledWall from={[plan.minX, meeting.maxZ]} to={[plan.minX, plan.maxZ]} height={WALL_H} theme={theme} />}
      <StyledWall from={[plan.maxX, plan.minZ]} to={[plan.maxX, plan.maxZ]} height={sideH} theme={theme} />
      {!props.cutaway ? (
        <>
          <StyledWall from={[plan.minX, plan.maxZ]} to={[balcony.minX, plan.maxZ]} height={sideH} theme={theme} />
          <Glass from={[balcony.minX, plan.maxZ]} to={[balcony.maxX, plan.maxZ]} />
          <StyledWall from={[balcony.minX, plan.maxZ]} to={[balcony.maxX, plan.maxZ]} height={WALL_H - 2.5} theme={theme} y={2.5} />
          <StyledWall from={[balcony.maxX, plan.maxZ]} to={[plan.maxX, plan.maxZ]} height={sideH} theme={theme} />
        </>
      ) : (
        <StyledWall from={[plan.minX, plan.maxZ]} to={[plan.maxX, plan.maxZ]} height={sideH} theme={theme} />
      )}
      {/* accent stripe */}
      {!glass && <mesh position={[(plan.minX + plan.maxX) / 2, 0.9, plan.minZ + 0.08]}>
        <boxGeometry args={[plan.maxX - plan.minX, 0.12, 0.02]} />
        <meshStandardMaterial color={theme.accentColor} />
      </mesh>}
      {windows.back.map((x) => <Window key={x} x={x} z={plan.minZ + 0.06} rotation={0} view={view} />)}
      {windows.left.map((z) => <Window key={z} x={plan.minX + 0.06} z={z} rotation={Math.PI / 2} view={view} />)}

      <Whiteboard position={f.whiteboard} tasks={props.tasks} interact={{ label: 'Task board', action: props.onBoard }} />
      <Elevator position={f.elevator} level={props.level} interact={{ label: 'Elevator — next floor', action: props.onElevator }} />
      <BossRoom plan={plan} interact={terminal} cutaway={props.cutaway} unread={props.unread ?? 0} />

      {theme.lounge && <Lounge position={f.lounge} accent={theme.accentColor} />}
      {theme.plants && f.plants.map((p, i) => <Plant key={i} position={p.position} scale={p.scale} tall={p.tall} />)}
    </group>
  );
}
