import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { DecorItem, Floor } from '@agent-hq/protocol';
import { catalogItem, type CatalogItem } from '@agent-hq/protocol/catalog';
import { Label } from '../Label.tsx';
import { toWorld, type FloorPlan } from '../layout.ts';
import { Decorations, ItemMesh, itemColor, NO_RAYCAST, useDecorModels } from './Decorations.tsx';
import { deleteItem, editor, moveItem, placeItem, redo, undo, useEditor, type Tool } from './editor.ts';
import { checkPlacement, deskAt, itemRect, poseFor, wallHit, type Pose } from './placement.ts';

// Decorate mode inside the 3D scene: the ghost that follows the pointer,
// picking and dragging placed items, desk picking, and the keyboard
// shortcuts (R rotate, Del delete, Ctrl+Z / Ctrl+Shift+Z, G grid, Esc).

const GHOST_BAD = new THREE.MeshBasicMaterial({ color: '#ff4d5e', transparent: true, opacity: 0.45, depthWrite: false });
const PLATE_OK = new THREE.MeshBasicMaterial({ color: '#2fd47a', transparent: true, opacity: 0.35, depthWrite: false });
const PLATE_BAD = new THREE.MeshBasicMaterial({ color: '#ff4d5e', transparent: true, opacity: 0.4, depthWrite: false });
const FLOOR = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const DESK_TOP = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.76);
const CLICK_PX = 5;

const notify = (text: string) => window.dispatchEvent(new CustomEvent('hq-error', { detail: text }));
const isTyping = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], .xterm');

/** Footprint on the floor: green where it fits, red where it doesn't. */
function Plate({ entry, pose, ok }: { entry: CatalogItem; pose: Pose; ok: boolean }) {
  const r = itemRect(entry, pose);
  return (
    <mesh position={[(r.minX + r.maxX) / 2, 0.02, (r.minZ + r.maxZ) / 2]} rotation={[-Math.PI / 2, 0, 0]} material={ok ? PLATE_OK : PLATE_BAD} raycast={NO_RAYCAST}>
      <planeGeometry args={[r.maxX - r.minX, r.maxZ - r.minZ]} />
    </mesh>
  );
}

/** A thin frame around a selected item. */
function Outline({ entry, pose, color }: { entry: CatalogItem; pose: Pose; color: string }) {
  const r = itemRect(entry, pose);
  const pad = 0.06;
  const w = r.maxX - r.minX + pad * 2;
  const d = r.maxZ - r.minZ + pad * 2;
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  const t = 0.04;
  return (
    <group position={[cx, 0.025, cz]}>
      {[[0, -d / 2, w, t], [0, d / 2, w, t], [-w / 2, 0, t, d], [w / 2, 0, t, d]].map(([x, z, sx, sz], i) => (
        <mesh key={i} position={[x, 0, z]} raycast={NO_RAYCAST}>
          <boxGeometry args={[sx, 0.02, sz]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function Ghost({ entry, pose, color, ok, modelOf }: { entry: CatalogItem; pose: Pose; color: string; ok: boolean; modelOf: ReturnType<typeof useDecorModels> }) {
  const model = modelOf(entry.id);
  if (!model) return null;
  return (
    <>
      <group position={[pose.x, 0, pose.z]} rotation={[0, pose.rotation * (Math.PI / 2), 0]}>
        <ItemMesh model={model} color={color} override={ok ? undefined : GHOST_BAD} />
      </group>
      <Plate entry={entry} pose={pose} ok={ok} />
    </>
  );
}

/** The selected item's floating toolbar. */
function ItemToolbar({ item, entry, onRotate, onMove, onDelete }: { item: DecorItem; entry: CatalogItem; onRotate: () => void; onMove: () => void; onDelete: () => void }) {
  const r = itemRect(entry, item);
  const y = entry.mount === 'wall' ? entry.height + 0.55 : Math.max(entry.height, 0.3) + 0.35;
  return (
    <Label position={[(r.minX + r.maxX) / 2, y, (r.minZ + r.maxZ) / 2]} center distanceFactor={13} zIndexRange={[30, 0]}>
      <div className="decor-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <strong>{entry.name}</strong>
        {entry.mount !== 'wall' && <button type="button" onClick={onRotate} title="Rotate (R)">⟳</button>}
        <button type="button" onClick={onMove} title="Move (or drag it)">✥</button>
        <button type="button" className="danger" onClick={onDelete} title="Remove (Del)">🗑</button>
      </div>
    </Label>
  );
}

/**
 * The floor's decorations, plus the editor while decorating. Always mounted
 * by OfficeScene so everyone sees the furniture.
 */
export function DecorLayer(props: { floor: Floor; plan: FloorPlan; items: DecorItem[]; decorating: boolean }) {
  const ed = useEditor();
  const hiddenId = props.decorating && ed.tool.kind === 'move' ? ed.tool.id : null;
  const picked = useRef<string | null>(null);
  return (
    <>
      <Decorations
        items={props.items}
        preset={props.floor.theme.lighting}
        editing={props.decorating}
        hiddenId={hiddenId}
        onPick={props.decorating ? (id: string, _e: ThreeEvent<PointerEvent>) => { picked.current = id; window.dispatchEvent(new CustomEvent('hq-decor-pick', { detail: id })); } : undefined}
      />
      {props.decorating && <DecorEditor {...props} picked={picked} />}
    </>
  );
}

function DecorEditor(props: { floor: Floor; plan: FloorPlan; items: DecorItem[]; picked: { current: string | null } }) {
  const { floor, plan, items } = props;
  const ed = useEditor();
  const modelOf = useDecorModels();
  const { camera, gl, controls, raycaster, pointer } = useThree();
  const [pose, setPose] = useState<Pose | null>(null);
  const inside = useRef(false);
  const down = useRef<{ x: number; y: number; button: number } | null>(null);
  /** The selected item was pressed: dragging it moves it. */
  const dragPending = useRef(false);
  const latest = useRef({ ed, items, pose, plan, floor });
  latest.current = { ed, items, pose, plan, floor };

  const tool = ed.tool;
  const toolEntry: CatalogItem | undefined = tool.kind === 'place' ? catalogItem(tool.itemId) : tool.kind === 'move' ? catalogItem(items.find((i) => i.id === tool.id)?.itemId ?? '') : undefined;
  const ignoreId = tool.kind === 'move' ? tool.id : null;
  const check = useMemo(() => (toolEntry && pose ? checkPlacement(toolEntry, pose, plan, floor.theme, items, ignoreId) : null), [toolEntry, pose, plan, floor.theme, items, ignoreId]);

  useEffect(() => {
    const hint = check ? { ok: check.ok, reason: check.reason } : null;
    const prev = editor.get().hint;
    if (prev?.ok !== hint?.ok || prev?.reason !== hint?.reason) editor.set({ hint });
  }, [check]);

  // Follow the pointer with the ghost.
  const point = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    if (!toolEntry || !inside.current) return;
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(FLOOR, point)) return;
    const rotation = tool.kind === 'place' || tool.kind === 'move' ? tool.rotation : 0;
    const next = poseFor(toolEntry, plan, { x: point.x, z: point.z }, rotation, ed.grid, toolEntry.mount === 'wall' ? wallHit(plan, raycaster.ray.origin, raycaster.ray.direction) : null);
    if (!pose || next.x !== pose.x || next.z !== pose.z || next.rotation !== pose.rotation) setPose(next);
  });
  useEffect(() => { if (!toolEntry) setPose(null); }, [toolEntry]);

  const orbit = controls as unknown as { enabled: boolean } | null;

  // Pointer: click to place / select, drag the selected item to move it.
  useEffect(() => {
    const el = gl.domElement;
    const onEnter = () => { inside.current = true; };
    const onLeave = () => { inside.current = false; };
    const onDown = (e: PointerEvent) => {
      inside.current = true;
      down.current = { x: e.clientX, y: e.clientY, button: e.button };
      // R3F's handlers (Decorations' onPick) run after this one.
      props.picked.current = null;
      dragPending.current = false;
    };
    const onPick = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const { ed } = latest.current;
      if (ed.tool.kind === 'idle' && ed.selectedId === id && down.current?.button === 0) {
        dragPending.current = true;
        if (orbit) orbit.enabled = false;
      }
    };
    const onMove = (e: PointerEvent) => {
      const d = down.current;
      if (!d || !dragPending.current) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < CLICK_PX) return;
      const item = latest.current.items.find((i) => i.id === latest.current.ed.selectedId);
      dragPending.current = false;
      if (item) editor.set({ tool: { kind: 'move', id: item.id, rotation: item.rotation, drag: true } });
    };
    const onUp = (e: PointerEvent) => {
      const d = down.current;
      down.current = null;
      dragPending.current = false;
      if (orbit) orbit.enabled = true;
      if (!d) return;
      const click = Math.hypot(e.clientX - d.x, e.clientY - d.y) < CLICK_PX;
      const { ed, items, pose, plan, floor } = latest.current;
      const t = ed.tool;
      if (d.button === 2) {
        if (click && t.kind !== 'idle') editor.set({ tool: { kind: 'idle' } });
        return;
      }
      if (d.button !== 0) return;
      if (t.kind === 'move' && (t.drag || click)) {
        const item = items.find((i) => i.id === t.id);
        const entry = item && catalogItem(item.itemId);
        editor.set({ tool: { kind: 'idle' } });
        if (!item || !entry || !pose) return;
        const ok = checkPlacement(entry, pose, plan, floor.theme, items, item.id);
        if (!ok.ok) { notify(`Can't put it there: ${ok.reason}`); return; }
        if (pose.x !== item.x || pose.z !== item.z || pose.rotation !== item.rotation) moveItem(item, pose);
        return;
      }
      if (!click) return;
      if (t.kind === 'place') {
        const entry = catalogItem(t.itemId);
        if (!entry || !pose) return;
        const ok = checkPlacement(entry, pose, plan, floor.theme, items);
        if (ok.ok) placeItem(floor.id, entry.id, pose, t.color);
        return;
      }
      // Idle: select what was clicked (an item, else a desk), or clear the selection.
      if (props.picked.current) {
        editor.set({ selectedId: props.picked.current, deskIndex: null, tab: 'items' });
        return;
      }
      raycaster.setFromCamera(pointer, camera);
      // Desks are picked where the ray crosses their top, not the floor below.
      const hit = raycaster.ray.intersectPlane(DESK_TOP, new THREE.Vector3());
      const desk = hit ? deskAt(plan, hit.x, hit.z) : null;
      if (desk != null) editor.set({ deskIndex: desk, selectedId: null, tab: 'desk' });
      else editor.set({ selectedId: null, deskIndex: null });
    };
    const noMenu = (e: MouseEvent) => e.preventDefault();
    el.addEventListener('pointerenter', onEnter);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('contextmenu', noMenu);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('hq-decor-pick', onPick);
    return () => {
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('hq-decor-pick', onPick);
      if (orbit) orbit.enabled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, camera, orbit]);

  const selected = items.find((i) => i.id === ed.selectedId);
  const selectedEntry = selected ? catalogItem(selected.itemId) : undefined;

  const rotateSelected = () => {
    const { items, plan, floor } = latest.current;
    const item = items.find((i) => i.id === editor.get().selectedId);
    const entry = item && catalogItem(item.itemId);
    if (!item || !entry || entry.mount === 'wall') return;
    // Turning changes the footprint: keep the edges on the grid.
    const next = poseFor(entry, plan, { x: item.x, z: item.z }, (item.rotation + 1) % 4, editor.get().grid, null);
    const ok = checkPlacement(entry, next, plan, floor.theme, items, item.id);
    if (ok.ok) moveItem(item, next);
    else notify(`No room to turn it: ${ok.reason}`);
  };
  const startMove = () => {
    const item = latest.current.items.find((i) => i.id === editor.get().selectedId);
    if (item) editor.set({ tool: { kind: 'move', id: item.id, rotation: item.rotation, drag: false } });
  };
  const deleteSelected = () => {
    const item = latest.current.items.find((i) => i.id === editor.get().selectedId);
    if (item) deleteItem(item);
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || document.querySelector('.modal-backdrop')) return;
      const s = editor.get();
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && key === 'y') { e.preventDefault(); redo(); return; }
      if (mod || e.altKey) return;
      if (key === 'r' && !e.repeat) {
        const t = s.tool;
        if (t.kind === 'place' || t.kind === 'move') editor.set({ tool: { ...t, rotation: (t.rotation + 1) % 4 } as Tool });
        else rotateSelected();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedId && s.tool.kind === 'idle') {
        e.preventDefault();
        deleteSelected();
      } else if (key === 'g' && !e.repeat) {
        editor.set({ grid: !s.grid });
      } else if (e.key === 'Escape') {
        if (s.tool.kind !== 'idle') editor.set({ tool: { kind: 'idle' } });
        else if (s.selectedId || s.deskIndex != null) editor.set({ selectedId: null, deskIndex: null });
        else editor.close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ghostColor = tool.kind === 'place' && toolEntry ? tool.color ?? toolEntry.tint ?? '#ffffff' : tool.kind === 'move' ? itemColor(toolEntry, items.find((i) => i.id === tool.id) ?? { color: null }) : '#ffffff';
  const deskSlot = ed.deskIndex != null ? plan.slots[ed.deskIndex] : undefined;
  const deskCenter = deskSlot ? toWorld(deskSlot.position, deskSlot.rotation, [0, 0, -0.3]) : null;

  return (
    <>
      {toolEntry && pose && check && <Ghost entry={toolEntry} pose={pose} color={ghostColor} ok={check.ok} modelOf={modelOf} />}
      {selected && selectedEntry && tool.kind === 'idle' && (
        <>
          <Outline entry={selectedEntry} pose={selected} color="#ffd84d" />
          <ItemToolbar item={selected} entry={selectedEntry} onRotate={rotateSelected} onMove={startMove} onDelete={deleteSelected} />
        </>
      )}
      {deskCenter && (
        <mesh position={[deskCenter[0], 0.02, deskCenter[2]]} rotation={[-Math.PI / 2, 0, 0]} raycast={NO_RAYCAST}>
          <ringGeometry args={[0.95, 1.05, 48]} />
          <meshBasicMaterial color="#ffd84d" toneMapped={false} />
        </mesh>
      )}
    </>
  );
}
