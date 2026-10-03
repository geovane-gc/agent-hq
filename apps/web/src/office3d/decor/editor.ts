import { useSyncExternalStore } from 'react';
import type { DecorItem, DeskStyle, Floor, FloorTheme, ID } from '@agent-hq/protocol';
import { catalogItem, type DecorCategory } from '@agent-hq/protocol/catalog';
import { run } from '../../api.ts';
import type { Pose } from './placement.ts';

// Decorate mode's state, shared by the HUD panel (components/Decorate.tsx)
// and the in-scene editor (DecorEditor.tsx): the active tool, the selection
// and the undo/redo history. Every change goes to the host first; the
// history only records changes the host accepted.

export type Tool =
  | { kind: 'idle' }
  /** A catalog item follows the pointer; clicking places it. */
  | { kind: 'place'; itemId: string; rotation: number; color: string | null }
  /** A placed item follows the pointer (`drag`: while the mouse button is held). */
  | { kind: 'move'; id: ID; rotation: number; drag: boolean };

export interface EditorState {
  open: boolean;
  tab: 'items' | 'room' | 'desk';
  category: DecorCategory;
  tool: Tool;
  selectedId: ID | null;
  /** Desk slot picked for the Desk tab. */
  deskIndex: number | null;
  grid: boolean;
  /** Whether the ghost can go where it is, and why not. */
  hint: { ok: boolean; reason: string | null } | null;
  undo: Change[];
  redo: Change[];
  busy: boolean;
}

export interface Change {
  label: string;
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
}

let state: EditorState = {
  open: false, tab: 'items', category: 'furniture', tool: { kind: 'idle' }, selectedId: null, deskIndex: null, grid: true, hint: null, undo: [], redo: [], busy: false,
};
const listeners = new Set<() => void>();

export const editor = {
  get: () => state,
  set(patch: Partial<EditorState>) {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  open() {
    editor.set({ open: true, tool: { kind: 'idle' }, selectedId: null, deskIndex: null, hint: null });
  },
  close() {
    editor.set({ open: false, tool: { kind: 'idle' }, selectedId: null, deskIndex: null, hint: null, undo: [], redo: [] });
  },
};

export function useEditor(): EditorState {
  return useSyncExternalStore(editor.subscribe, editor.get);
}

const HISTORY = 100;

/** Applies a change on the host and records it for undo. */
async function perform(change: Change) {
  if (state.busy) return;
  editor.set({ busy: true });
  try {
    await change.redo();
    editor.set({ undo: [...state.undo, change].slice(-HISTORY), redo: [] });
  } catch {
    // run() already showed the error
  } finally {
    editor.set({ busy: false });
  }
}

export async function undo() {
  const change = state.undo.at(-1);
  if (!change || state.busy) return;
  editor.set({ busy: true });
  try {
    await change.undo();
    editor.set({ undo: state.undo.slice(0, -1), redo: [...state.redo, change] });
  } catch {
    // Someone else changed it meanwhile: drop that step.
    editor.set({ undo: state.undo.slice(0, -1) });
  } finally {
    editor.set({ busy: false });
  }
}

export async function redo() {
  const change = state.redo.at(-1);
  if (!change || state.busy) return;
  editor.set({ busy: true });
  try {
    await change.redo();
    editor.set({ redo: state.redo.slice(0, -1), undo: [...state.undo, change] });
  } catch {
    editor.set({ redo: state.redo.slice(0, -1) });
  } finally {
    editor.set({ busy: false });
  }
}

/** crypto.randomUUID needs a secure context; LAN players may be on plain http. */
function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

const nameOf = (itemId: string) => catalogItem(itemId)?.name ?? 'item';

// ---------------------------------------------------------------- decorations

export function placeItem(floorId: ID, itemId: string, pose: Pose, color: string | null) {
  const args = { id: newId(), floorId, itemId, x: pose.x, z: pose.z, rotation: pose.rotation, color };
  return perform({
    label: `Place ${nameOf(itemId)}`,
    redo: () => run('place_decor', args),
    undo: () => run('remove_decor', { id: args.id }),
  });
}

export function moveItem(item: DecorItem, pose: Pose) {
  const before = { x: item.x, z: item.z, rotation: item.rotation };
  return perform({
    label: `Move ${nameOf(item.itemId)}`,
    redo: () => run('update_decor', { id: item.id, patch: { x: pose.x, z: pose.z, rotation: pose.rotation } }),
    undo: () => run('update_decor', { id: item.id, patch: before }),
  });
}

export function recolorItem(item: DecorItem, color: string | null) {
  const before = item.color;
  return perform({
    label: `Recolor ${nameOf(item.itemId)}`,
    redo: () => run('update_decor', { id: item.id, patch: { color } }),
    undo: () => run('update_decor', { id: item.id, patch: { color: before } }),
  });
}

export function deleteItem(item: DecorItem) {
  const { id, floorId, itemId, x, z, rotation, color } = item;
  if (state.selectedId === id) editor.set({ selectedId: null });
  return perform({
    label: `Remove ${nameOf(itemId)}`,
    redo: () => run('remove_decor', { id }),
    // Restores the same item (bought again in career).
    undo: () => run('place_decor', { id, floorId, itemId, x, z, rotation, color }),
  });
}

// ---------------------------------------------------------------- room style & desks

export function setTheme(floor: Floor, patch: Partial<FloorTheme>, label = 'Restyle room') {
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, floor.theme[k as keyof FloorTheme]])) as Partial<FloorTheme>;
  return perform({
    label,
    redo: () => run('update_floor', { id: floor.id, patch: { theme: patch as FloorTheme } }),
    undo: () => run('update_floor', { id: floor.id, patch: { theme: before as FloorTheme } }),
  });
}

/** Restyles one or more agents' desks as one undoable step. */
export function setDesks(changes: Array<{ agentId: ID; before: DeskStyle | null; after: DeskStyle | null }>, label = 'Restyle desk') {
  return perform({
    label,
    redo: async () => { for (const c of changes) await run('set_desk_style', { agentId: c.agentId, style: c.after }); },
    undo: async () => { for (const c of [...changes].reverse()) await run('set_desk_style', { agentId: c.agentId, style: c.before }); },
  });
}
