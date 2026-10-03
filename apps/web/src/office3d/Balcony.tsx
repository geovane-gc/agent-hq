import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Agent, ID, Task } from '@agent-hq/protocol';
import { hash01 } from '../agentUtil.ts';
import type { Interactable } from './interact.ts';
import { Label } from './Label.tsx';
import type { Balcony as BalconyLayout, Slot, Vec3 } from './layout.ts';
import { Character, EMBER_MATERIAL, Model } from './models.tsx';
import { Workstation } from './Workstation.tsx';

// The balcony: the project's repo agents (.claude/agents) hang out here
// smoking until someone summons them; then they walk to a hot desk, work, and
// walk back. Positions come from layout.ts; the server says where each one is.

/** Where a repo agent sits at a hot desk (the Workstation's chair). */
const chairOf = (desk: Slot): Vec3 => [desk.position[0], 0, desk.position[2] + 0.08];
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
function CrewMember(props: { agent: Agent; spot: { position: Vec3; rotation: number }; desk: Slot | null; onSummon: () => void }) {
  const { agent, spot, desk } = props;
  const location = agent.repo?.location ?? 'balcony';
  const target: Vec3 = location === 'to_desk' && desk ? chairOf(desk) : spot.position;
  const group = useRef<THREE.Group>(null);
  const start = useRef<Vec3>(location === 'to_balcony' && desk ? chairOf(desk) : location === 'to_desk' ? spot.position : target);
  const speed = useRef(1.5);
  const walkingTo = useRef('');
  const [walking, setWalking] = useState(false);

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const to = new THREE.Vector3(...target);
    if (walkingTo.current !== target.join()) {
      // The server says "arrived" after a fixed walk time, so go fast enough to make it.
      walkingTo.current = target.join();
      speed.current = Math.max(1.5, g.position.distanceTo(to) / 2.2);
    }
    const delta = to.clone().sub(g.position);
    const distance = delta.length();
    const moving = distance > 0.03;
    if (moving !== walking) setWalking(moving);
    let heading = spot.rotation;
    if (moving) {
      g.position.add(delta.normalize().multiplyScalar(Math.min(distance, speed.current * Math.min(dt, 0.05))));
      // The character faces -Z: heading is the angle that turns -Z towards the target.
      heading = Math.atan2(-(to.x - g.position.x), -(to.z - g.position.z));
    }
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
}) {
  const { layout, crew } = props;
  const w = layout.maxX - layout.minX;
  const d = layout.maxZ - layout.minZ;
  const cx = (layout.minX + layout.maxX) / 2;
  const cz = (layout.minZ + layout.maxZ) / 2;
  const atDesk = new Map(crew.filter((a) => a.repo?.location === 'desk' && a.repo.deskIndex !== null).map((a) => [a.repo!.deskIndex!, a]));
  const ashtrays = layout.spots.filter((_, i) => i % 3 === 1).map((s): Vec3 => [s.position[0] + 0.5, 0, s.position[2] + 0.25]);

  useFrame(({ clock }) => {
    EMBER_MATERIAL.color.setHSL(0.04, 1, 0.5 + Math.sin(clock.elapsedTime * 7) * 0.08 + Math.sin(clock.elapsedTime * 2.3) * 0.05);
  });

  return (
    <group>
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
      <Model name="plant" position={[layout.minX + 0.4, 0, layout.maxZ - 0.4]} />
      <Model name="plant_tall" position={[layout.maxX - 0.35, 0, layout.minZ + 0.35]} scale={0.8} />
      {ashtrays.map((p, i) => <Ashtray key={i} position={p} />)}
      <Label position={[layout.minX + 0.6, 1.35, layout.maxZ]} center distanceFactor={15} zIndexRange={[10, 0]}>
        <span className="tag sign">🚬 Balcony</span>
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
        return <CrewMember key={agent.id} agent={agent} spot={layout.spots[i]} desk={desk} onSummon={() => props.onSummon(agent.id)} />;
      })}
    </group>
  );
}
