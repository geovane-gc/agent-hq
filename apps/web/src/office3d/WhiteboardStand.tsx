import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import type { ID } from '@agent-hq/protocol';
import { boardAt, openWhiteboard, openWhiteboardAt, useThumbnail, useWhiteboards } from '../whiteboards.ts';
import type { Interactable } from './interact.ts';
import { Label } from './Label.tsx';
import { fixtures, type FloorPlan, type Rect, type Vec3 } from './layout.ts';

// A drawing whiteboard in the 3D world, showing a live thumbnail of its board
// (rendered by whoever edits it, refetched when it changes). Clicking it opens
// the board full screen. Reusable anywhere: give it a position and rotation
// and either a fixed `boardId` or a `spot`, a named place that shows whatever
// board hangs there (an empty spot offers to start one). E.g. a meeting room:
//
//   <WhiteboardStand variant="wall" position={anchor} rotation={angle}
//     spot={`meeting:${roomId}`} newBoardName="Meeting notes" size={[2.4, 1.3]} />
//
// and add whiteboardCollider(...) to the floor's colliders for an easel.

const TEXTURE_WIDTH = 1024;

export interface WhiteboardStandProps {
  position: Vec3;
  /** Rotation around Y; the board faces +Z before rotating. */
  rotation?: number;
  /** Show this board. */
  boardId?: ID | null;
  /** Or whatever board hangs at this spot, e.g. `floor:<id>` (one board per spot). */
  spot?: string;
  /** Name of the board created when an empty spot is clicked. */
  newBoardName?: string;
  /** easel: free-standing on legs. wall: just the board, its back at `position`. */
  variant?: 'easel' | 'wall';
  /** Drawing surface, meters [width, height]. */
  size?: [number, number];
  /** Height of the board's center above `position`. */
  elevation?: number;
  /** Show the clickable sign above it. */
  label?: boolean;
}

/** The board's picture fitted (contain) on a white surface of the board's aspect. */
function useBoardTexture(dataUrl: string | null, aspect: number) {
  const canvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = TEXTURE_WIDTH;
    c.height = Math.round(TEXTURE_WIDTH / aspect);
    return c;
  }, [aspect]);
  const texture = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [canvas]);
  useEffect(() => () => texture.dispose(), [texture]);
  useEffect(() => {
    const ctx = canvas.getContext('2d')!;
    const paint = (img: HTMLImageElement | null) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (img) {
        const pad = canvas.width * 0.04;
        const scale = Math.min((canvas.width - pad * 2) / img.width, (canvas.height - pad * 2) / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      }
      texture.needsUpdate = true;
    };
    if (!dataUrl) return paint(null);
    let alive = true;
    const img = new Image();
    img.onload = () => alive && paint(img);
    img.src = dataUrl;
    return () => { alive = false; };
  }, [dataUrl, canvas, texture]);
  return texture;
}

export function WhiteboardStand(props: WhiteboardStandProps) {
  const variant = props.variant ?? 'easel';
  const [w, h] = props.size ?? (variant === 'easel' ? [1.6, 1.05] : [2.2, 1.2]);
  const elevation = props.elevation ?? (variant === 'easel' ? 1.42 : 1.5);
  const boards = useWhiteboards();
  const board = props.boardId ? boards.find((b) => b.id === props.boardId) : props.spot ? boardAt(boards, props.spot) : undefined;
  const thumb = useThumbnail(board);
  const texture = useBoardTexture(board ? thumb : null, w / h);
  const [creating, setCreating] = useState(false);

  const open = () => {
    if (board) return openWhiteboard(board.id);
    if (!props.spot || creating) return;
    setCreating(true);
    openWhiteboardAt(props.spot, props.newBoardName ?? 'Whiteboard').catch(() => {}).finally(() => setCreating(false));
  };
  const interact: Interactable = {
    label: board ? `Whiteboard: ${board.name}` : props.spot ? 'Whiteboard: start a drawing' : 'Whiteboard',
    action: open,
  };
  const drawing = board?.viewers.length ?? 0;
  const frame = '#9aa3ad';
  const top = elevation + h / 2;
  // A wall board sits just in front of the wall; an easel stands on its own.
  const z = variant === 'wall' ? 0.05 : 0;

  return (
    <group position={props.position} rotation={[0, props.rotation ?? 0, 0]} userData={{ interact }}>
      {/* frame and drawing surface */}
      <mesh position={[0, elevation, z]} castShadow receiveShadow>
        <boxGeometry args={[w + 0.07, h + 0.07, 0.04]} />
        <meshStandardMaterial color={frame} metalness={0.4} roughness={0.45} />
      </mesh>
      <mesh position={[0, elevation, z + 0.021]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      {/* marker tray */}
      <mesh position={[0, elevation - h / 2 - 0.035, z + 0.05]} castShadow>
        <boxGeometry args={[w * 0.7, 0.025, 0.08]} />
        <meshStandardMaterial color={frame} metalness={0.4} roughness={0.45} />
      </mesh>
      {['#e5484d', '#3d63dd', '#1c2026'].map((c, i) => (
        <mesh key={c} position={[-w * 0.2 + i * 0.12, elevation - h / 2 - 0.01, z + 0.05]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.012, 0.012, 0.1, 8]} />
          <meshStandardMaterial color={c} />
        </mesh>
      ))}
      {variant === 'easel' && (
        <>
          {[-1, 1].map((side) => (
            <group key={side} position={[side * (w / 2 - 0.12), 0, -0.04]}>
              <mesh position={[0, (top + 0.08) / 2, 0]} castShadow>
                <boxGeometry args={[0.04, top + 0.08, 0.04]} />
                <meshStandardMaterial color={frame} metalness={0.5} roughness={0.4} />
              </mesh>
              <mesh position={[0, 0.02, 0]} castShadow>
                <boxGeometry args={[0.06, 0.04, 0.62]} />
                <meshStandardMaterial color="#5a5f6a" />
              </mesh>
            </group>
          ))}
        </>
      )}
      {props.label !== false && (
        <Label position={[0, top + 0.25, z]} center distanceFactor={15} zIndexRange={[10, 0]}>
          <button className="tag sign" onClick={open}>
            🖍️ {board ? board.name : 'Whiteboard'}{drawing ? <span className="mail-badge">✏️ {drawing}</span> : null}
          </button>
        </Label>
      )}
    </group>
  );
}

/** Floor footprint of a stand (axis-aligned), for first-person collisions. */
export function whiteboardCollider(position: Vec3, rotation = 0, width = 1.6, variant: 'easel' | 'wall' = 'easel'): Rect {
  const hw = width / 2 + 0.05;
  const hd = variant === 'easel' ? 0.33 : 0.1;
  const c = Math.abs(Math.cos(rotation));
  const s = Math.abs(Math.sin(rotation));
  const ex = hw * c + hd * s;
  const ez = hw * s + hd * c;
  return { minX: position[0] - ex, maxX: position[0] + ex, minZ: position[2] - ez, maxZ: position[2] + ez };
}

/**
 * Where a floor's easel stands: by the task board on the back wall, or, on a
 * floor too narrow for it there (one desk pod), in the open space right of the
 * desks, between the pod, the lounge and the side plant, turned towards the
 * overview camera. Not below the boss room: that is the meeting room
 * (layout.ts → meetingRoom), whose own whiteboard hangs on its partition.
 */
export function easelPlacement(plan: FloorPlan): { position: Vec3; rotation: number } {
  const f = fixtures(plan);
  const x = f.whiteboard[0] + 2.7;
  if (x + 1.0 < f.elevator[0] - 0.95) return { position: [x, 0, plan.minZ + 1.0], rotation: -0.25 };
  return { position: [plan.maxX - 1.7, 0, (plan.minZ + plan.maxZ) / 2 + 1.0], rotation: 0.5 };
}
