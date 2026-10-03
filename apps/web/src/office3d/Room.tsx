import { useMemo } from 'react';
import { Label } from './Label.tsx';
import { Model } from './models.tsx';
import type { FloorTheme, Task } from '@agent-hq/protocol';
import { fixtures, WALL_HEIGHT, type FloorPlan, type Rect } from './layout.ts';
import type { Interactable } from './interact.ts';
import { getCarpetTexture, getFloorTexture, getTilesTexture } from './textures.ts';

const WALL_H = WALL_HEIGHT;
const CUTAWAY_H = 0.25;

function FloorSurface({ plan, theme }: { plan: FloorPlan; theme: FloorTheme }) {
  const w = plan.maxX - plan.minX;
  const d = plan.maxZ - plan.minZ;
  const texture = useMemo(() => {
    const base = theme.floor === 'wood' ? getFloorTexture() : theme.floor === 'carpet' ? getCarpetTexture() : theme.floor === 'tiles' ? getTilesTexture() : null;
    if (!base) return null;
    const t = base.clone();
    t.needsUpdate = true;
    const scale = theme.floor === 'wood' ? 4 : 1.5;
    t.repeat.set(w / scale, d / scale);
    return t;
  }, [theme.floor, w, d]);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[plan.minX + w / 2, 0, plan.minZ + d / 2]} receiveShadow>
      <planeGeometry args={[w, d]} />
      <meshStandardMaterial map={texture} color={texture ? '#ffffff' : '#b7b6b0'} roughness={0.85} />
    </mesh>
  );
}

function Wall(props: { from: [number, number]; to: [number, number]; height: number; color: string; thickness?: number; y?: number }) {
  const [x1, z1] = props.from;
  const [x2, z2] = props.to;
  const len = Math.hypot(x2 - x1, z2 - z1);
  const angle = Math.atan2(z2 - z1, x2 - x1);
  return (
    <mesh position={[(x1 + x2) / 2, (props.y ?? 0) + props.height / 2, (z1 + z2) / 2]} rotation={[0, -angle, 0]} castShadow receiveShadow>
      <boxGeometry args={[len, props.height, props.thickness ?? 0.15]} />
      <meshStandardMaterial color={props.color} roughness={0.95} />
    </mesh>
  );
}

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

function Window({ x, z, rotation }: { x: number; z: number; rotation: number }) {
  return (
    <group position={[x, 1.6, z]} rotation={[0, rotation, 0]}>
      <mesh>
        <boxGeometry args={[1.8, 1.4, 0.18]} />
        <meshStandardMaterial color="#d9dde3" />
      </mesh>
      <mesh position={[0, 0, 0.1]}>
        <planeGeometry args={[1.6, 1.2]} />
        <meshBasicMaterial color="#a8d4ff" toneMapped={false} />
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
function Ceiling({ plan }: { plan: FloorPlan }) {
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
        <meshBasicMaterial color="#dfe3e8" />
      </mesh>
      {panels.map(([x, z]) => (
        <mesh key={`${x},${z}`} position={[x, WALL_H - 0.02, z]} rotation={[Math.PI / 2, 0, 0]}>
          <planeGeometry args={[1.2, 0.6]} />
          <meshBasicMaterial color="#fffdf5" toneMapped={false} />
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
  /** The balcony outside the front wall, if this floor has one: that stretch of wall is glass. */
  balcony?: Rect | null;
}) {
  const { plan, theme, balcony } = props;
  const f = fixtures(plan);
  const sideH = props.cutaway ? CUTAWAY_H : WALL_H;
  const wall = theme.wallColor;
  const windowsBack = useMemo(() => {
    const xs: number[] = [];
    for (let x = plan.boss.maxX + 6.2; x < plan.maxX - 3.4; x += 3.2) xs.push(x);
    return xs;
  }, [plan]);
  const windowsLeft = useMemo(() => {
    const zs: number[] = [];
    for (let z = plan.minZ + 1.5; z < plan.maxZ - 1; z += 3) zs.push(z);
    return zs;
  }, [plan]);

  const terminal: Interactable = props.onTerminal
    ? { label: 'Boss computer — inbox', action: props.onTerminal }
    : { label: 'Boss computer', action: () => {} };

  return (
    <group>
      <FloorSurface plan={plan} theme={theme} />
      {!props.cutaway && <Ceiling plan={plan} />}
      {/* back and left walls are always full height; front and right are cut away in the overview */}
      <Wall from={[plan.minX, plan.minZ]} to={[plan.maxX, plan.minZ]} height={WALL_H} color={wall} />
      <Wall from={[plan.minX, plan.minZ]} to={[plan.minX, plan.maxZ]} height={WALL_H} color={wall} />
      <Wall from={[plan.maxX, plan.minZ]} to={[plan.maxX, plan.maxZ]} height={sideH} color={wall} />
      {balcony && !props.cutaway ? (
        <>
          <Wall from={[plan.minX, plan.maxZ]} to={[balcony.minX, plan.maxZ]} height={sideH} color={wall} />
          <Glass from={[balcony.minX, plan.maxZ]} to={[balcony.maxX, plan.maxZ]} />
          <Wall from={[balcony.minX, plan.maxZ]} to={[balcony.maxX, plan.maxZ]} height={WALL_H - 2.5} color={wall} y={2.5} />
          <Wall from={[balcony.maxX, plan.maxZ]} to={[plan.maxX, plan.maxZ]} height={sideH} color={wall} />
        </>
      ) : (
        <Wall from={[plan.minX, plan.maxZ]} to={[plan.maxX, plan.maxZ]} height={sideH} color={wall} />
      )}
      {/* accent stripe */}
      <mesh position={[(plan.minX + plan.maxX) / 2, 0.9, plan.minZ + 0.08]}>
        <boxGeometry args={[plan.maxX - plan.minX, 0.12, 0.02]} />
        <meshStandardMaterial color={theme.accentColor} />
      </mesh>
      {windowsBack.map((x) => <Window key={x} x={x} z={plan.minZ + 0.06} rotation={0} />)}
      {windowsLeft.map((z) => <Window key={z} x={plan.minX + 0.06} z={z} rotation={Math.PI / 2} />)}

      <Whiteboard position={f.whiteboard} tasks={props.tasks} interact={{ label: 'Task board', action: props.onBoard }} />
      <Elevator position={f.elevator} level={props.level} interact={{ label: 'Elevator — next floor', action: props.onElevator }} />
      <BossRoom plan={plan} interact={terminal} cutaway={props.cutaway} unread={props.unread ?? 0} />

      {theme.lounge && <Lounge position={f.lounge} accent={theme.accentColor} />}
      {theme.plants && f.plants.map((p, i) => <Plant key={i} position={p.position} scale={p.scale} tall={p.tall} />)}
    </group>
  );
}
