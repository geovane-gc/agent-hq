import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { Floor, ID, Snapshot } from '@agent-hq/protocol';
import { client } from '../api.ts';
import { floorSpot, meetingSpot } from '../whiteboards.ts';
import { CameraFly, FirstPersonControls, IsoControls, type CameraMode } from './Controls.tsx';
import { findInteractable } from './interact.ts';
import { HtmlLayer, LabelScale } from './Label.tsx';
import { Balcony } from './Balcony.tsx';
import { DecorLayer } from './decor/DecorEditor.tsx';
import { SceneLighting } from './decor/lighting.tsx';
import { decorColliders } from './decor/placement.ts';
import { balconyColliders, balconyLayout, colliders, fixtures, floorPlan, meetingRoom, toWorld, type FloorPlan, type Rect, type Vec3 } from './layout.ts';
import { MeetingRoom } from './MeetingRoom.tsx';
import { Players } from './Players.tsx';
import { Room } from './Room.tsx';
import { easelPlacement, whiteboardCollider, WhiteboardStand } from './WhiteboardStand.tsx';
import { Workstation } from './Workstation.tsx';

/** Camera pose that fills the view with an agent's monitor (workstation-local coordinates). */
const MONITOR_EYE: Vec3 = [0, 1.16, -0.28];
const MONITOR_SCREEN: Vec3 = [0, 1.15, -0.72];

type Phase = 'free' | 'zoom-in' | 'focused' | 'zoom-out';

/**
 * Owns the camera: normal controls while you play, and a smooth flight into
 * an agent's monitor (and back to exactly where you were) when you open it.
 */
function CameraDirector(props: {
  mode: CameraMode;
  plan: FloorPlan;
  span: number;
  /** Where the first-person player can go: the floor and the balcony. */
  bounds: Rect;
  colliders: Rect[];
  spawn: Vec3;
  focus: { eye: THREE.Vector3; screen: THREE.Vector3 } | null;
  onFocused: () => void;
  onHover: (label: string | null) => void;
  onLockChange: (locked: boolean) => void;
  lockRef: { current: (() => void) | null };
  onMove: (position: Vec3, rotation: number) => void;
}) {
  const { camera, controls } = useThree();
  const [phase, setPhase] = useState<Phase>('free');
  const saved = useRef<{ p: THREE.Vector3; q: THREE.Quaternion; target: THREE.Vector3 | null } | null>(null);
  const [restore, setRestore] = useState<{ target: THREE.Vector3 | null } | null>(null);

  useEffect(() => {
    if (props.focus && phase === 'free') {
      const orbit = controls as unknown as OrbitControlsImpl | null;
      saved.current = { p: camera.position.clone(), q: camera.quaternion.clone(), target: orbit?.target?.clone() ?? null };
      setPhase('zoom-in');
    } else if (!props.focus && (phase === 'focused' || phase === 'zoom-in')) {
      setPhase('zoom-out');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus]);

  if (phase === 'zoom-in' && props.focus) {
    return <CameraFly key="in" position={props.focus.eye} lookAt={props.focus.screen} duration={0.9} onDone={() => { setPhase('focused'); props.onFocused(); }} />;
  }
  if (phase === 'zoom-out' && saved.current) {
    return (
      <CameraFly
        key="out"
        position={saved.current.p}
        quaternion={saved.current.q}
        duration={0.7}
        onDone={() => { setRestore({ target: saved.current?.target ?? null }); setPhase('free'); }}
      />
    );
  }
  if (phase !== 'free') return null;
  return props.mode === 'iso' ? (
    <IsoControls center={props.plan.center} span={props.span} restoreTarget={restore?.target ?? null} />
  ) : (
    <FirstPersonControls
      bounds={props.bounds}
      colliders={props.colliders}
      spawn={props.spawn}
      restore={restore !== null}
      onHover={props.onHover}
      onLockChange={props.onLockChange}
      lockRef={props.lockRef}
      onMove={props.onMove}
    />
  );
}

export function OfficeScene(props: {
  world: Snapshot;
  floor: Floor;
  mode: CameraMode;
  /** Agent whose monitor the camera should zoom into. */
  focusAgentId: ID | null;
  onFocused: () => void;
  onOpenAgent: (id: ID) => void;
  onRecruit: () => void;
  onBoard: () => void;
  onElevator: () => void;
  onTerminal: (() => void) | null;
  /** Click on a repo agent on the balcony. */
  onSummon: (agentId: ID) => void;
  /** Click on the balcony while it has no agents. */
  onEmptyBalcony: () => void;
  /** Decorate mode: clicks place and pick decorations instead of using things. */
  decorating?: boolean;
}) {
  const { world, floor } = props;
  const plan = useMemo(() => floorPlan(floor.desks), [floor.desks]);
  const fx = useMemo(() => fixtures(plan), [plan]);
  const decor = useMemo(() => world.decor.filter((d) => d.floorId === floor.id), [world.decor, floor.id]);
  const meeting = useMemo(() => meetingRoom(plan), [plan]);
  // The drawing whiteboard's easel, by the task board.
  const easel = useMemo(() => easelPlacement(plan), [plan]);
  const agents = world.agents.filter((a) => a.floorId === floor.id && a.kind !== 'repo').sort((a, b) => a.createdAt - b.createdAt);
  // Repo agents (.claude/agents of this floor's projects) live on the balcony. Every floor has one, crew or not.
  const crew = world.agents.filter((a) => a.floorId === floor.id && a.kind === 'repo').sort((a, b) => a.createdAt - b.createdAt);
  const balcony = useMemo(() => balconyLayout(plan, crew.length), [plan, crew.length]);
  // Crew members smoking at the railing stand still: the player walks around them.
  const smoking = crew.flatMap((a, i) => (a.repo?.location === 'balcony' ? [i] : [])).join();
  const solid = useMemo(() => {
    // The meeting room's wall whiteboard sticks out of the partition a little (frame and marker tray).
    const anchor = meeting.whiteboardAnchor;
    const wallBoard = toWorld([anchor.position[0], 0, anchor.position[2]], anchor.rotation, [0, 0, 0.05]);
    return [
      ...colliders(plan, floor.theme),
      ...balconyColliders(plan, balcony, smoking ? smoking.split(',').map(Number) : []),
      ...decorColliders(decor),
      whiteboardCollider(easel.position, easel.rotation),
      whiteboardCollider(wallBoard, anchor.rotation, anchor.width, 'wall'),
    ];
  }, [plan, floor.theme, easel, meeting, decor, balcony, smoking]);
  // The player can walk out through the balcony door: the front wall and the railing are colliders.
  const walkable = useMemo<Rect>(() => ({ minX: plan.minX, maxX: plan.maxX, minZ: plan.minZ, maxZ: balcony.maxZ }), [plan, balcony]);
  const projectIds = new Set(world.projects.filter((p) => p.floorId === floor.id).map((p) => p.id));
  const tasks = world.tasks.filter((t) => projectIds.has(t.projectId));
  const canRecruit = world.agents.length < world.settings.maxAgents;
  const [hover, setHover] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const lockRef = useRef<(() => void) | null>(null);
  const htmlLayer = useRef<HTMLDivElement>(null);
  const span = Math.max(plan.maxX - plan.minX, plan.maxZ - plan.minZ);
  // Frame the whole balcony too in the overview. The camera looks in from the front, where things come out
  // bigger: aim a little in front of the middle and pull back a little.
  const view = useMemo(() => {
    const depth = balcony.maxZ - plan.minZ;
    const center: Vec3 = [plan.center[0], 0, (plan.minZ + balcony.maxZ) / 2 + depth * 0.2];
    return { plan: { ...plan, center }, span: Math.max(plan.maxX - plan.minX, depth) * 1.2 };
  }, [plan, balcony]);

  const focus = useMemo(() => {
    const index = agents.findIndex((a) => a.id === props.focusAgentId);
    const hotDesk = crew.find((a) => a.id === props.focusAgentId)?.repo?.deskIndex;
    const slot = index >= 0 ? plan.slots[index] : hotDesk != null ? balcony.desks[hotDesk] : undefined;
    if (!slot) return null;
    return {
      eye: new THREE.Vector3(...toWorld(slot.position, slot.rotation, MONITOR_EYE)),
      screen: new THREE.Vector3(...toWorld(slot.position, slot.rotation, MONITOR_SCREEN)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusAgentId, plan, balcony, agents.map((a) => a.id).join(), crew.map((a) => a.repo?.deskIndex).join()]);

  // Tell the other players where you are when you're not walking around.
  useEffect(() => {
    if (props.mode === 'iso') client.request('presence', { floorId: floor.id, mode: 'overview', position: [0, 0, 0], rotation: 0 }).catch(() => {});
  }, [floor.id, props.mode]);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (props.mode !== 'iso' || props.focusAgentId || props.decorating) return;
    const i = findInteractable(e.object);
    if (i) {
      e.stopPropagation();
      i.action();
    }
  };
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (props.mode !== 'iso' || props.decorating) return;
    const i = findInteractable(e.object);
    document.body.style.cursor = i ? 'pointer' : '';
    setHover(i?.label ?? null);
  };

  return (
    <div className="scene">
      <HtmlLayer.Provider value={htmlLayer}>
      <LabelScale.Provider value={props.mode === 'first' ? 0.35 : 1}>
      <Canvas shadows dpr={[1, 2]} camera={{ fov: props.mode === 'first' ? 70 : 42, near: 0.03, far: 200 }} key={props.mode}>
        <SceneLighting preset={floor.theme.lighting} firstPerson={props.mode === 'first'} plan={plan} span={span} />
        <Suspense fallback={null}>
        <group onClick={onClick} onPointerMove={onPointerMove} onPointerOut={() => { document.body.style.cursor = ''; setHover(null); }}>
          <Room
            plan={plan}
            theme={floor.theme}
            level={floor.level}
            tasks={tasks}
            cutaway={props.mode === 'iso'}
            onBoard={props.onBoard}
            onElevator={props.onElevator}
            onTerminal={props.onTerminal}
            unread={world.mail.filter((m) => !m.read).length + world.playerMail.unread}
            balcony={balcony}
          />
          <MeetingRoom
            world={world}
            floor={floor}
            layout={meeting}
            cutaway={props.mode === 'iso'}
            whiteboard={
              // Mounted in the anchor's group (centered on the spot, facing into the room), back against the partition.
              <WhiteboardStand
                variant="wall"
                position={[0, 0, -0.04]}
                elevation={0}
                size={[meeting.whiteboardAnchor.width, meeting.whiteboardAnchor.height]}
                spot={meetingSpot(floor.id)}
                newBoardName={`${floor.name} meeting notes`}
              />
            }
          />
          <WhiteboardStand position={easel.position} rotation={easel.rotation} spot={floorSpot(floor.id)} newBoardName={`${floor.name} whiteboard`} />
          <Balcony
            layout={balcony}
            crew={crew}
            tasks={world.tasks}
            accent={floor.theme.accentColor}
            focusAgentId={props.focusAgentId}
            gamification={world.settings.gamification}
            onSummon={props.onSummon}
            onOpenAgent={props.onOpenAgent}
            onEmpty={props.onEmptyBalcony}
          />
          <DecorLayer floor={floor} plan={plan} items={decor} decorating={!!props.decorating} />
          {plan.slots.map((slot) => {
            const agent = agents[slot.index] ?? null;
            return (
              <Workstation
                key={slot.index}
                position={slot.position}
                rotation={slot.rotation}
                accent={floor.theme.accentColor}
                agent={agent}
                task={agent?.currentTaskId ? world.tasks.find((t) => t.id === agent.currentTaskId) : undefined}
                selected={!!agent && agent.id === props.focusAgentId}
                gamification={world.settings.gamification}
                canRecruit={canRecruit}
                deskStyle={agent ? world.desks.find((d) => d.agentId === agent.id)?.style ?? null : null}
                onSelect={() => agent && props.onOpenAgent(agent.id)}
                onRecruit={props.onRecruit}
              />
            );
          })}
        </group>
        <Players users={world.users} presence={world.presence} floorId={floor.id} youId={world.you.id} yourMode={props.mode} fixtures={fx} />
        </Suspense>
        <CameraDirector
          mode={props.mode}
          plan={view.plan}
          span={view.span}
          bounds={walkable}
          colliders={solid}
          spawn={fx.spawn}
          focus={focus}
          onFocused={props.onFocused}
          onHover={setHover}
          onLockChange={setLocked}
          lockRef={lockRef}
          onMove={(position, rotation) => client.request('presence', { floorId: floor.id, mode: 'walk', position, rotation }).catch(() => {})}
        />
      </Canvas>
      </LabelScale.Provider>
      </HtmlLayer.Provider>
      <div ref={htmlLayer} className={`html-layer ${props.focusAgentId ? 'hidden' : ''} ${props.decorating ? 'decorating' : ''}`} />

      {props.mode === 'first' && !props.focusAgentId && (
        <>
          <div className={`crosshair ${hover ? 'active' : ''}`} />
          {hover && locked && <div className="hover-label">{hover} — click</div>}
          {!locked && (
            <button className="fp-enter" onClick={() => lockRef.current?.()}>
              Click to walk around<br />
              <small>WASD to move · Shift to run · mouse to look · click to use · Esc to release</small>
            </button>
          )}
        </>
      )}
      {props.mode === 'iso' && hover && !props.focusAgentId && <div className="hover-label bottom">{hover}</div>}
    </div>
  );
}
