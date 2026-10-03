import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Presence, User } from '@agent-hq/protocol';
import { useClient } from '../api.ts';
import { useVoice } from '../voice/engine.ts';
import type { CameraMode } from './Controls.tsx';
import { Label } from './Label.tsx';
import type { Fixtures, Vec3 } from './layout.ts';
import { Character } from './models.tsx';

/** A player walking around; positions are smoothed between network updates. */
function Walker({ user, position, rotation }: { user: User; position: Vec3; rotation: number }) {
  const group = useRef<THREE.Group>(null);
  const [walking, setWalking] = useState(false);
  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const target = new THREE.Vector3(...position);
    const moving = g.position.distanceTo(target) > 0.04;
    if (moving !== walking) setWalking(moving);
    g.position.lerp(target, Math.min(1, dt * 10));
    // shortest-path turn
    let d = rotation - g.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    g.rotation.y += d * Math.min(1, dt * 10);
  });
  return (
    <group ref={group} position={position} rotation={[0, rotation, 0]}>
      <Character appearance={user.appearance} outfit={user.role === 'owner' ? 'suit' : 'casual'} clip={walking ? 'Walk' : 'Stand'} />
      <NameTag user={user} height={2.05} />
    </group>
  );
}

function NameTag({ user, height }: { user: User; height: number }) {
  // Voice: a ring while they talk, a mic while their mic is live.
  const voice = useVoice();
  const { world } = useClient();
  const speaking = !!voice.speaking[user.id];
  const live = !!world?.voice.some((v) => v.userId === user.id && v.mic);
  return (
    <Label position={[0, height, 0]} center distanceFactor={14} zIndexRange={[20, 0]}>
      <span className={`tag player ${speaking ? 'speaking' : ''}`} style={{ borderColor: user.color }} title={user.role === 'owner' ? 'Boss' : 'Manager'}>
        {speaking ? <span className="speaking-icon" aria-label="talking">🔊</span> : <span className="dot" style={{ background: user.color }} />} {user.name}{user.role === 'owner' ? ' 👑' : ''}
        {live && !speaking && <span className="mic-dot" title="Mic on" aria-label="mic on" />}
      </span>
    </Label>
  );
}

/**
 * Everyone on this floor. Players walking in first person appear where they
 * are; the others are "parked": the boss behind the executive desk, everyone
 * else by the elevator. You see yourself too, except while walking (you're
 * the camera then).
 */
export function Players(props: {
  users: User[];
  presence: Presence[];
  floorId: string;
  youId: string;
  yourMode: CameraMode;
  fixtures: Fixtures;
}) {
  const here = props.presence.filter((p) => p.floorId === props.floorId && Date.now() - p.ts < 10 * 60_000);
  let lobbyIndex = 0;
  return (
    <>
      {here.map((p) => {
        const user = props.users.find((u) => u.id === p.userId);
        if (!user?.online) return null;
        const isYou = user.id === props.youId;
        if (isYou && props.yourMode === 'first') return null;
        if (p.mode === 'walk' && !isYou) return <Walker key={user.id} user={user} position={p.position} rotation={p.rotation} />;
        if (user.role === 'owner') {
          return (
            <group key={user.id} position={props.fixtures.bossSeat} rotation={[0, props.fixtures.bossDeskRotation, 0]}>
              <group position={[0, 0.04, 0.03]}>
                <Character appearance={user.appearance} outfit="suit" clip="SitIdle" phase={0.3} />
              </group>
              <NameTag user={user} height={1.85} />
            </group>
          );
        }
        const spot = props.fixtures.lobby(lobbyIndex++);
        return (
          <group key={user.id} position={spot}>
            <Character appearance={user.appearance} clip="Stand" />
            <NameTag user={user} height={2.05} />
          </group>
        );
      })}
    </>
  );
}
