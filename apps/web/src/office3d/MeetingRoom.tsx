import { useEffect, useMemo, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import type { Floor, FloorTheme, Snapshot } from '@agent-hq/protocol';
import { openScreen, shareScreen, useVoice, voice } from '../voice/engine.ts';
import type { Interactable } from './interact.ts';
import { StyledWall } from './decor/RoomStyle.tsx';
import { Label } from './Label.tsx';
import { WALL_HEIGHT, type MeetingRoom as MeetingLayout, type WallMount } from './layout.ts';
import { Model } from './models.tsx';

const CUTAWAY_H = 0.25;

/**
 * A partition along x = `x` or z = `z` (cut down in the overview, like the other near walls), in the floor's
 * wall finish. Always solid, even in a glass-walled room: the whiteboard hangs on it.
 */
function Partition(props: { x?: number; z?: number; from: number; to: number; height: number; theme: FloorTheme; y?: number }) {
  const alongZ = props.x !== undefined;
  const from: [number, number] = alongZ ? [props.x!, props.from] : [props.from, props.z!];
  const to: [number, number] = alongZ ? [props.x!, props.to] : [props.to, props.z!];
  return <StyledWall from={from} to={to} height={props.height} y={props.y} theme={props.theme} />;
}

/** Plays a MediaStream onto a plane, letterboxed into the screen. */
function VideoPlane({ stream, width, height }: { stream: MediaStream; width: number; height: number }) {
  const [state, setState] = useState<{ texture: THREE.VideoTexture; aspect: number } | null>(null);
  useEffect(() => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sized = () => setState({ texture, aspect: video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : width / height });
    video.addEventListener('loadedmetadata', sized);
    video.addEventListener('resize', sized);
    void video.play().catch(() => {});
    sized();
    return () => {
      video.pause();
      video.srcObject = null;
      texture.dispose();
    };
  }, [stream, width, height]);
  if (!state) return null;
  const w = Math.min(width, height * state.aspect);
  const h = w / state.aspect;
  return (
    <mesh position={[0, 0, 0.012]}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={state.texture} toneMapped={false} />
    </mesh>
  );
}

function WallScreen(props: { mount: WallMount; stream: MediaStream | null; caption: ReactNode; interact: Interactable }) {
  const { mount } = props;
  return (
    <group position={mount.position} rotation={[0, mount.rotation, 0]} userData={{ interact: props.interact }}>
      <mesh position={[0, 0, -0.02]} castShadow>
        <boxGeometry args={[mount.width + 0.12, mount.height + 0.12, 0.05]} />
        <meshStandardMaterial color="#1b1e24" roughness={0.4} metalness={0.3} />
      </mesh>
      <mesh position={[0, 0, 0.006]}>
        <planeGeometry args={[mount.width, mount.height]} />
        <meshBasicMaterial color={props.stream ? '#000000' : '#151b26'} toneMapped={false} />
      </mesh>
      {props.stream && <VideoPlane stream={props.stream} width={mount.width} height={mount.height} />}
      {props.caption && (
        <Label position={[0, 0, 0.03]} center distanceFactor={9} zIndexRange={[10, 0]}>
          {props.caption}
        </Label>
      )}
    </group>
  );
}

/**
 * The meeting room: partitions, a long table with chairs, a big wall screen
 * showing the meeting's shared screen, and a clear spot on the partition kept
 * for a whiteboard (pass it as `whiteboard` to mount something there).
 */
export function MeetingRoom(props: {
  world: Snapshot;
  floor: Floor;
  layout: MeetingLayout;
  /** Overview: near partitions are cut down so you can look in. */
  cutaway: boolean;
  /** Mounted at layout.whiteboardAnchor (the group is centered on the spot, facing into the room). */
  whiteboard?: ReactNode;
}) {
  const { world, floor, layout: m } = props;
  const v = useVoice();
  const theme = useMemo(() => (floor.theme.wall === 'glass' ? { ...floor.theme, wall: 'paint' as const } : floor.theme), [floor.theme]);
  const h = props.cutaway ? CUTAWAY_H : WALL_HEIGHT;
  const share = world.screenShares.find((s) => s.floorId === floor.id);
  const here = v.meetingFloorId === floor.id;
  const stream = here && v.screen?.share.floorId === floor.id ? v.screen.stream : null;
  const sharer = share ? (share.userId === world.you.id ? 'You' : world.users.find((u) => u.id === share.userId)?.name ?? 'Someone') : null;

  const interact: Interactable = useMemo(() => {
    if (stream) return { label: 'Meeting screen — open full size', action: openScreen };
    if (!here) return { label: 'Meeting room — join the meeting', action: () => voice.joinMeeting(floor.id) };
    if (!share && v.joined) return { label: 'Meeting screen — share your screen', action: () => { if (document.pointerLockElement) document.exitPointerLock(); shareScreen(); } };
    return { label: 'Meeting screen', action: () => {} };
  }, [stream, here, share, v.joined, floor.id]);

  const caption = stream ? null : share ? (
    <button className="tag sign screen-caption" onClick={interact.action}>
      <span className="rec-dot" aria-hidden /> {sharer} {share.userId === world.you.id ? 'are' : 'is'} sharing{here ? '' : ' · Join meeting'}
    </button>
  ) : (
    <button className="tag sign screen-caption" onClick={interact.action}>🎥 Meeting room{here && v.joined ? ' · Share screen' : ''}</button>
  );

  const doorTop = props.cutaway ? null : <Partition x={m.maxX} from={m.door.minZ} to={m.door.maxZ} height={0.8} y={2.2} theme={theme} />;

  return (
    <group>
      {/* carpet */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[m.center[0], 0.006, m.center[2]]} receiveShadow>
        <planeGeometry args={[m.maxX - m.minX - 0.5, m.maxZ - m.minZ - 0.5]} />
        <meshStandardMaterial color="#2f3a4a" roughness={1} />
      </mesh>
      {/* partition with a door next to the open-plan area, and a front partition when the floor is deeper */}
      <Partition x={m.maxX} from={m.minZ} to={m.door.minZ} height={h} theme={theme} />
      <Partition x={m.maxX} from={m.door.maxZ} to={m.maxZ} height={h} theme={theme} />
      {doorTop}
      {m.frontWall && <Partition z={m.maxZ} from={m.minX} to={m.maxX} height={h} theme={theme} />}
      {/* table and chairs */}
      <group position={[m.center[0], 0, m.center[2]]}>
        <mesh position={[0, 0.74, 0]} castShadow receiveShadow>
          <boxGeometry args={[m.table.maxX - m.table.minX, 0.05, m.table.maxZ - m.table.minZ]} />
          <meshStandardMaterial color="#6b4f3a" roughness={0.6} />
        </mesh>
        {[-1, 1].map((sx) => (
          <mesh key={sx} position={[sx * ((m.table.maxX - m.table.minX) / 2 - 0.35), 0.36, 0]} castShadow>
            <boxGeometry args={[0.12, 0.72, (m.table.maxZ - m.table.minZ) * 0.7]} />
            <meshStandardMaterial color="#3a3f4b" metalness={0.3} />
          </mesh>
        ))}
      </group>
      {m.seats.map((s, i) => (
        <Model key={i} name="chair" position={s.position} rotation={[0, s.rotation, 0]} />
      ))}
      <WallScreen mount={m.screen} stream={stream} caption={caption} interact={interact} />
      {/* Whiteboard anchor: a clear stretch of the partition, facing the screen. */}
      <group position={m.whiteboardAnchor.position} rotation={[0, m.whiteboardAnchor.rotation, 0]} name="whiteboard-anchor" userData={{ anchor: 'whiteboard', width: m.whiteboardAnchor.width, height: m.whiteboardAnchor.height }}>
        {!props.cutaway && props.whiteboard}
      </group>
    </group>
  );
}
