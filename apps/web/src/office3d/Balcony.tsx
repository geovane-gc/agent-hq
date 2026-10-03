import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Agent, ID, Task } from '@agent-hq/protocol';
import { hash01 } from '../agentUtil.ts';
import type { Interactable } from './interact.ts';
import { Label } from './Label.tsx';
import { balconyRoute, type Balcony as BalconyLayout, type Slot, type Vec3 } from './layout.ts';
import { Character, EMBER_MATERIAL, Model } from './models.tsx';
import { Workstation } from './Workstation.tsx';

// The balcony: the project's repo agents (.claude/agents) hang out here
// smoking until someone summons them; then they walk to a hot desk, work, and
// walk back. Positions and walking routes come from layout.ts; the server
// says where each one is.

/** The lit end of the cigarette, in the character's local space. */
const TIP: Vec3 = [0.038, 1.515, -0.235];

function Smoke() {
  const puffs = useMemo(
    () => [0, 1, 2].map(() => new THREE.MeshBasicMaterial({ color: '#d9dde3', transparent: true, depthWrite: false })),
    [],
  );
  const refs = useRef<Array<THREE.Mesh | null>>([]);
  useFrame(({ clock }) => {
    puffs.forEach((material, i) => {
      const mesh = refs.current[i];
      if (!mesh) return;
      const t = (clock.elapsedTime * 0.45 + i / 3) % 1;
      mesh.position.set(TIP[0] + Math.sin(t * 5 + i) * 0.03, TIP[1] + t * 0.5, TIP[2] - t * 0.06);
      mesh.scale.setScalar(0.015 + t * 0.07);
      material.opacity = (1 - t) * 0.55;
    });
  });
  return (
    <>
      {puffs.map((material, i) => (
        <mesh key={i} ref={(m) => { refs.current[i] = m; }} material={material} raycast={() => null}>
          <sphereGeometry args={[1, 10, 8]} />
        </mesh>
      ))}
    </>
  );
}

/** A repo agent away from the desks: smoking on the balcony, or walking to or from a hot desk. */
function CrewMember(props: { agent: Agent; layout: BalconyLayout; spot: { position: Vec3; rotation: number }; desk: Slot | null; onSummon: () => void }) {
  const { agent, layout, spot, desk } = props;
  const location = agent.repo?.location ?? 'balcony';
  // Along the aisles between the smoking spot and the hot desk (layout.ts), or just to the spot.
  const route = useMemo(() => {
    if (!desk || (location !== 'to_desk' && location !== 'to_balcony')) return [spot.position];
    const there = balconyRoute(layout, spot.position, desk);
    return location === 'to_desk' ? there : there.reverse();
  }, [layout, spot.position, desk, location]);
  const group = useRef<THREE.Group>(null);
  const start = useRef<Vec3>(route[0]);
  const speed = useRef(1.5);
  const leg = useRef(0);
  const following = useRef<Vec3[] | null>(null);
  const [walking, setWalking] = useState(false);

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    if (following.current !== route) {
      // A new route (or turning around halfway): pick it up at the waypoint after the nearest one.
      following.current = route;
      const near = route.map((p) => Math.hypot(p[0] - g.position.x, p[2] - g.position.z));
      leg.current = Math.min(route.length - 1, near.indexOf(Math.min(...near)) + 1);
      // The server says "arrived" after a fixed walk time, so go fast enough to make it.
      let length = near[leg.current];
      for (let i = leg.current + 1; i < route.length; i++) length += Math.hypot(route[i][0] - route[i - 1][0], route[i][2] - route[i - 1][2]);
      speed.current = Math.max(1.5, length / 2.2);
    }
    let step = speed.current * Math.min(dt, 0.05);
    let heading = spot.rotation;
    let going = false;
    while (step > 0) {
      const to = new THREE.Vector3(...route[leg.current]);
      const delta = to.sub(g.position);
      const distance = delta.length();
      if (distance <= 0.03) {
        if (leg.current >= route.length - 1) break;
        leg.current++;
        continue;
      }
      going = true;
      // The character faces -Z: heading is the angle that turns -Z towards the waypoint.
      heading = Math.atan2(-delta.x, -delta.z);
      g.position.add(delta.normalize().multiplyScalar(Math.min(distance, step)));
      step -= Math.min(distance, step);
    }
    if (going !== walking) setWalking(going);
    let d = heading - g.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    g.rotation.y += d * Math.min(1, dt * 8);
  });

  const idle = location === 'balcony' && !walking;
  const interact: Interactable = { label: idle ? `${agent.name} — summon` : `${agent.name} (busy)`, action: props.onSummon };
  return (
    <group ref={group} position={start.current} rotation={[0, spot.rotation, 0]} userData={{ interact }}>
      <Character
        appearance={agent.appearance}
        clip={walking ? 'Walk' : 'Stand'}
        phase={hash01(agent.id)}
        holding={location === 'balcony' || location === 'to_balcony' ? 'cigarette' : undefined}
      />
      {idle && <Smoke />}
      <Label position={[0, 2.05, 0]} center distanceFactor={14} zIndexRange={[20, 0]}>
        <button className={`tag repo-agent ${idle ? '' : 'busy'}`} onClick={props.onSummon} title={agent.repo?.description}>
          <span className="tag-icon">{idle ? '🚬' : '🚶'}</span>
          <span className="tag-text">
            <strong>{agent.name}</strong>
            <small>{idle ? 'Summon' : agent.activity ?? 'On the way'}</small>
          </span>
        </button>
      </Label>
    </group>
  );
}

function Railing({ from, to }: { from: [number, number]; to: [number, number] }) {
  const [x1, z1] = from;
  const [x2, z2] = to;
  const len = Math.hypot(x2 - x1, z2 - z1);
  const angle = Math.atan2(z2 - z1, x2 - x1);
  const posts = Math.max(1, Math.round(len / 1.4));
  return (
    <group position={[(x1 + x2) / 2, 0, (z1 + z2) / 2]} rotation={[0, -angle, 0]}>
      <mesh position={[0, 0.55, 0]} raycast={() => null}>
        <boxGeometry args={[len, 0.9, 0.03]} />
        <meshPhysicalMaterial color="#bfe3ff" transparent opacity={0.25} roughness={0.05} />
      </mesh>
      <mesh position={[0, 1.04, 0]} castShadow>
        <boxGeometry args={[len + 0.06, 0.06, 0.08]} />
        <meshStandardMaterial color="#4b505a" metalness={0.4} roughness={0.5} />
      </mesh>
      {Array.from({ length: posts + 1 }, (_, i) => (
        <mesh key={i} position={[-len / 2 + (i * len) / posts, 0.52, 0]} castShadow>
          <boxGeometry args={[0.05, 1.04, 0.05]} />
          <meshStandardMaterial color="#4b505a" metalness={0.4} roughness={0.5} />
        </mesh>
      ))}
    </group>
  );
}

function Ashtray({ position }: { position: Vec3 }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.45, 0]} castShadow>
        <cylinderGeometry args={[0.025, 0.04, 0.9, 10]} />
        <meshStandardMaterial color="#5a5f6a" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.92, 0]} castShadow>
        <cylinderGeometry args={[0.13, 0.09, 0.07, 16]} />
        <meshStandardMaterial color="#7d838f" metalness={0.6} roughness={0.35} />
      </mesh>
    </group>
  );
}

/** A park bench looking out over the railing (+Z): wooden slats on two dark metal frames. */
function Bench({ position }: { position: Vec3 }) {
  const wood = <meshStandardMaterial color="#a77b52" roughness={0.8} />;
  const metal = <meshStandardMaterial color="#3f444d" metalness={0.5} roughness={0.45} />;
  return (
    <group position={position}>
      {[-0.13, 0.03, 0.19].map((z) => (
        <mesh key={z} position={[0, 0.45, z]} castShadow receiveShadow>
          <boxGeometry args={[1.5, 0.04, 0.13]} />
          {wood}
        </mesh>
      ))}
      {[0.62, 0.8].map((y) => (
        <mesh key={y} position={[0, y, -0.25]} rotation={[-0.12, 0, 0]} castShadow>
          <boxGeometry args={[1.5, 0.12, 0.035]} />
          {wood}
        </mesh>
      ))}
      {[-0.65, 0.65].map((x) => (
        <group key={x} position={[x, 0, 0]}>
          <mesh position={[0, 0.215, 0.02]} castShadow>
            <boxGeometry args={[0.05, 0.43, 0.42]} />
            {metal}
          </mesh>
          <mesh position={[0, 0.62, -0.25]} castShadow>
            <boxGeometry args={[0.05, 0.36, 0.04]} />
            {metal}
          </mesh>
        </group>
      ))}
    </group>
  );
}

export function Balcony(props: {
  layout: BalconyLayout;
  /** The floor's repo agents, in a stable order (their smoking spot index). */
  crew: Agent[];
  tasks: Task[];
  accent: string;
  focusAgentId: ID | null;
  gamification: boolean;
  onSummon: (agentId: ID) => void;
  onOpenAgent: (agentId: ID) => void;
  /** Explains how to get a crew, when there is none. */
  onEmpty: () => void;
}) {
  const { layout, crew } = props;
  const empty = crew.length === 0;
  const hint: Interactable = { label: 'No balcony agents yet — click to see how to add them', action: props.onEmpty };
  const w = layout.maxX - layout.minX;
  const d = layout.maxZ - layout.minZ;
  const cx = (layout.minX + layout.maxX) / 2;
  const cz = (layout.minZ + layout.maxZ) / 2;
  const atDesk = new Map(crew.filter((a) => a.repo?.location === 'desk' && a.repo.deskIndex !== null).map((a) => [a.repo!.deskIndex!, a]));
  const ashtrays = [
    ...layout.spots.filter((_, i) => i % 3 === 1).map((s): Vec3 => [s.position[0] + 0.5, 0, s.position[2] + 0.25]),
    ...layout.benches.map((b): Vec3 => [b[0] + 1.05, 0, b[2] + 0.05]),
  ];

  useFrame(({ clock }) => {
    EMBER_MATERIAL.color.setHSL(0.04, 1, 0.5 + Math.sin(clock.elapsedTime * 7) * 0.08 + Math.sin(clock.elapsedTime * 2.3) * 0.05);
  });

  return (
    <group userData={empty ? { interact: hint } : undefined}>
      {/* deck and slab */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.004, cz]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color="#9b7a58" roughness={0.9} />
      </mesh>
      <mesh position={[cx, -0.12, cz]} receiveShadow>
        <boxGeometry args={[w, 0.24, d]} />
        <meshStandardMaterial color="#c9ccd2" roughness={0.9} />
      </mesh>
      <Railing from={[layout.minX, layout.maxZ]} to={[layout.maxX, layout.maxZ]} />
      <Railing from={[layout.minX, layout.minZ]} to={[layout.minX, layout.maxZ]} />
      <Railing from={[layout.maxX, layout.minZ]} to={[layout.maxX, layout.maxZ]} />
      {layout.plants.map((p, i) => <Model key={i} name={p.tall ? 'plant_tall' : 'plant'} position={p.position} scale={p.tall ? 0.8 : 1} />)}
      {ashtrays.map((p, i) => <Ashtray key={i} position={p} />)}
      {layout.benches.map((p, i) => <Bench key={i} position={p} />)}
      <Label position={[layout.minX + 0.6, 1.35, layout.maxZ]} center distanceFactor={15} zIndexRange={[10, 0]}>
        {empty ? (
          <button className="tag sign balcony-empty" onClick={props.onEmpty} title="No balcony agents yet. Add agent definitions to .claude/agents/ in this floor's project repo, then re-scan.">
            🚬 Balcony <small>· no agents yet</small>
          </button>
        ) : (
          <span className="tag sign">🚬 Balcony</span>
        )}
      </Label>

      {/* hot desks */}
      {layout.desks.map((desk) => {
        const agent = atDesk.get(desk.index) ?? null;
        return (
          <Workstation
            key={desk.index}
            position={desk.position}
            rotation={desk.rotation}
            accent={props.accent}
            agent={agent}
            task={agent?.currentTaskId ? props.tasks.find((t) => t.id === agent.currentTaskId) : undefined}
            selected={!!agent && agent.id === props.focusAgentId}
            gamification={props.gamification}
            canRecruit={false}
            onSelect={() => agent && props.onOpenAgent(agent.id)}
            onRecruit={() => {}}
          />
        );
      })}

      {/* everyone not sitting at a desk */}
      {crew.map((agent, i) => {
        if (agent.repo?.location === 'desk' || !layout.spots[i]) return null;
        const desk = agent.repo?.deskIndex != null ? layout.desks[agent.repo.deskIndex] ?? null : null;
        return <CrewMember key={agent.id} agent={agent} layout={layout} spot={layout.spots[i]} desk={desk} onSummon={() => props.onSummon(agent.id)} />;
      })}
    </group>
  );
}
