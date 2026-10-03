import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ID, ServerEvent, WhiteboardInfo } from '@agent-hq/protocol';
import { client, run } from './api.ts';

// Whiteboards on the client: the list of the office's boards (kept apart from
// the world snapshot, see api.ts), their thumbnails for the 3D objects and
// the list, and the window events that open the editor from anywhere.
// The editor itself (Excalidraw) is lazy-loaded by components/Whiteboards.tsx.

type Detail<T extends ServerEvent['type']> = Extract<ServerEvent, { type: T }>;

class WhiteboardStore {
  private boards: WhiteboardInfo[] = [];
  private readonly listeners = new Set<() => void>();

  constructor() {
    client.whiteboards.addEventListener('snapshot', () => this.refresh());
    client.whiteboards.addEventListener('whiteboard', (e) => {
      const board = (e as CustomEvent<Detail<'whiteboard'>>).detail.whiteboard;
      const i = this.boards.findIndex((b) => b.id === board.id);
      this.set(i < 0 ? [...this.boards, board] : this.boards.map((b) => (b.id === board.id ? board : b)));
    });
    client.whiteboards.addEventListener('whiteboard_removed', (e) => {
      const id = (e as CustomEvent<Detail<'whiteboard_removed'>>).detail.id;
      this.set(this.boards.filter((b) => b.id !== id));
    });
    if (client.get().world) this.refresh();
  }

  get = () => this.boards;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(boards: WhiteboardInfo[]) {
    this.boards = boards;
    for (const fn of this.listeners) fn();
  }

  refresh() {
    client.request('whiteboard_list', {}).then((list) => this.set(list), () => {});
  }
}

export const whiteboardStore = new WhiteboardStore();

/** Every board of the office, oldest first. */
export function useWhiteboards(): WhiteboardInfo[] {
  return useSyncExternalStore(whiteboardStore.subscribe, whiteboardStore.get);
}

/** The board hanging at a spot (e.g. `floor:<id>`), if any. */
export function boardAt(boards: WhiteboardInfo[], spot: string): WhiteboardInfo | undefined {
  return boards.find((b) => b.spot === spot);
}

/** The spot of a floor's easel, by the task board. */
export const floorSpot = (floorId: ID) => `floor:${floorId}`;

// ---------------------------------------------------------------- thumbnails

const thumbs = new Map<ID, { version: number; dataUrl: string | null }>();
const inflight = new Map<ID, Promise<void>>();
const thumbListeners = new Set<() => void>();
/** Thumbnails are fetched at most this often per board, however fast they change. */
const THUMB_MIN_INTERVAL_MS = 1500;
const lastFetch = new Map<ID, number>();

function fetchThumbnail(board: WhiteboardInfo) {
  if (inflight.has(board.id)) return;
  const wait = Math.max(0, (lastFetch.get(board.id) ?? 0) + THUMB_MIN_INTERVAL_MS - Date.now());
  const p = new Promise<void>((r) => setTimeout(r, wait))
    .then(() => client.request('whiteboard_thumbnail', { id: board.id }))
    .then((t) => {
      thumbs.set(board.id, t);
      for (const fn of thumbListeners) fn();
    })
    .catch(() => {})
    .finally(() => {
      lastFetch.set(board.id, Date.now());
      inflight.delete(board.id);
      // It changed again while we were fetching.
      const latest = whiteboardStore.get().find((b) => b.id === board.id);
      if (latest && (thumbs.get(board.id)?.version ?? -1) < latest.thumbnailVersion) fetchThumbnail(latest);
    });
  inflight.set(board.id, p);
}

/** The board's latest thumbnail (a PNG data URL), refetched (throttled) when it changes. */
export function useThumbnail(board: WhiteboardInfo | undefined): string | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    thumbListeners.add(fn);
    return () => { thumbListeners.delete(fn); };
  }, []);
  useEffect(() => {
    if (board && board.thumbnailVersion > 0 && (thumbs.get(board.id)?.version ?? -1) < board.thumbnailVersion) fetchThumbnail(board);
  }, [board?.id, board?.thumbnailVersion]);
  return board ? thumbs.get(board.id)?.dataUrl ?? null : null;
}

// ---------------------------------------------------------------- opening

export interface OpenBoardDetail {
  id: ID;
}

/** Opens a board full screen (the editor is loaded on first use). */
export function openWhiteboard(id: ID) {
  window.dispatchEvent(new CustomEvent<OpenBoardDetail>('hq-open-whiteboard', { detail: { id } }));
}

/**
 * Opens the board hanging at a spot (a 3D whiteboard was clicked), creating
 * it there first if the spot is empty.
 */
export async function openWhiteboardAt(spot: string, name: string) {
  const existing = boardAt(whiteboardStore.get(), spot);
  const board = existing ?? await run('whiteboard_create', { name, spot });
  openWhiteboard(board.id);
}

/** Opens the Whiteboards list (main menu → Whiteboards). */
export function openWhiteboards() {
  window.dispatchEvent(new CustomEvent('hq-open-whiteboards'));
}
