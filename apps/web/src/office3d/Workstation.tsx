import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Agent, AgentStatus, Task } from '@agent-hq/protocol';
import { hash01, level, STATUS_LABEL } from '../agentUtil.ts';
import type { Interactable } from './interact.ts';
import { Label } from './Label.tsx';
import { Character, Model, type CharacterClip } from './models.tsx';
import { getCodeTexture } from './textures.ts';

// One desk: table, monitor, keyboard, chair and (if staffed) the agent.
// Modeled with the agent facing -Z; the parent group rotates it into place.

const SCREEN_COLORS = {
  idle: '#24324d',
  working: '#ffffff',
  awaiting_approval: '#ff9f1a',
  error: '#ff3b4f',
  offline: '#0b0d12',
} as const;

const CLIPS: Record<Exclude<AgentStatus, 'offline'>, CharacterClip> = {
  idle: 'SitIdle',
  working: 'SitType',
  awaiting_approval: 'SitWave',
  error: 'SitError',
};

/** The live screen: scrolling code while working, blinking when the agent needs you. */
function useScreenMaterial(status: AgentStatus) {
  const material = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);
  const texture = useMemo(() => {
    const t = getCodeTexture().clone();
    t.needsUpdate = true;
    return t;
  }, []);
  useEffect(() => () => { texture.dispose(); material.dispose(); }, [texture, material]);

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    if (status === 'working') {
      material.map = texture;
      texture.offset.y -= dt * 0.08;
      material.color.set('#ffffff');
    } else {
      material.map = null;
      material.color.set(SCREEN_COLORS[status]);
      if (status === 'awaiting_approval' || status === 'error') {
        material.color.multiplyScalar(Math.sin(t * 6) > 0 ? 1 : 0.45);
      } else if (status === 'idle') {
        material.color.offsetHSL(Math.sin(t * 0.3) * 0.05, 0, 0);
      }
    }
    material.needsUpdate = true;
  });
  return material;
}

function Bubble({ agent, task, gamification, selected, onClick }: {
  agent: Agent; task: Task | undefined; gamification: boolean; selected: boolean; onClick: () => void;
}) {
  const icon = { working: '⌨️', awaiting_approval: '✋', error: '⚠️', idle: '☕', offline: '💤' }[agent.status];
  return (
    <Label position={[0, 1.65, 0]} center distanceFactor={14} zIndexRange={[20, 0]}>
      <button className={`tag status-${agent.status} ${selected ? 'selected' : ''}`} onClick={onClick}>
        <span className={`tag-icon ${agent.status === 'awaiting_approval' ? 'bounce' : ''}`}>{icon}</span>
        <span className="tag-text">
          <strong>{agent.name}</strong>
          {gamification && <em> Lv{level(agent.xp)}</em>}
          {agent.isManager && <em> ★</em>}
          <small>{agent.activity ?? (agent.status === 'offline' ? 'Away' : task?.title ?? STATUS_LABEL[agent.status])}</small>
        </span>
      </button>
    </Label>
  );
}

export function Workstation(props: {
  position: [number, number, number];
  rotation: number;
  accent: string;
  agent: Agent | null;
  task: Task | undefined;
  selected: boolean;
  gamification: boolean;
  canRecruit: boolean;
  onSelect: () => void;
  onRecruit: () => void;
}) {
  const { agent } = props;
  const status = agent?.status ?? 'offline';
  const screen = useScreenMaterial(status);
  const screenReplace = useMemo(() => ({ Screen: screen }), [screen]);
  const interact: Interactable | undefined = agent
    ? { label: `${agent.name}'s computer`, action: props.onSelect }
    : props.canRecruit ? { label: 'Empty desk — recruit an agent', action: props.onRecruit } : undefined;

  return (
    <group position={props.position} rotation={[0, props.rotation, 0]} userData={{ interact }}>
      <Model name="desk" position={[0, 0, -0.5]} recolor={{ Accent: props.accent }} />
      <Model name="monitor" position={[0, 0.765, -0.72]} replace={screenReplace} />
      <Model name="keyboard" position={[0, 0.765, -0.3]} />
      <Model name="chair" position={[0, 0, 0.05]} recolor={{ Upholstery: agent ? agent.appearance.shirt : '#5b6170' }} />
      {agent && agent.status !== 'offline' && (
        <group position={[0, 0, 0.08]}>
          <Character appearance={agent.appearance} clip={CLIPS[agent.status]} phase={hash01(agent.id)} />
        </group>
      )}
      {props.selected && (
        <mesh position={[0, 0.01, -0.2]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.85, 0.95, 40]} />
          <meshBasicMaterial color={props.accent} />
        </mesh>
      )}
      {agent ? (
        <Bubble agent={agent} task={props.task} gamification={props.gamification} selected={props.selected} onClick={props.onSelect} />
      ) : props.canRecruit ? (
        <Label position={[0, 1.2, 0]} center distanceFactor={14} zIndexRange={[20, 0]}>
          <button className="tag recruit" onClick={props.onRecruit}>＋ Recruit</button>
        </Label>
      ) : null}
    </group>
  );
}
