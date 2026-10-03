import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaptureUpdateAction, Excalidraw, exportToBlob, reconcileElements, restoreElements } from '@excalidraw/excalidraw';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import type { ExcalidrawElement, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFileData, BinaryFiles, Collaborator, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import type { ID, ServerEvent, Snapshot, WhiteboardElement, WhiteboardFile, WhiteboardInfo } from '@agent-hq/protocol';
import { client } from '../api.ts';

// The whiteboard editor: Excalidraw plus the sync with the host. Loaded
// lazily (it's most of a megabyte), see Whiteboards.tsx.
//
// Sync, as in excalidraw.com's collaboration:
// - Local changes: every element whose `version` is above the one we last
//   sent or received is pushed (throttled), images first. The host answers
//   with its copy of the elements where ours lost, and we reconcile those.
// - Remote changes are merged with Excalidraw's reconcileElements (higher
//   version wins, ties go to the lower versionNonce, and the element you are
//   editing right now is kept), without entering the undo history.
// - On reconnect, the board is reopened: the host's elements are reconciled
//   in and whatever we drew offline is pushed.
// - Cursors are throttled and shown as Excalidraw collaborators.
// - Whoever changed the board renders its thumbnail (throttled) for the 3D
//   whiteboard and the list.

const PUSH_INTERVAL_MS = 60;
const CURSOR_INTERVAL_MS = 50;
const THUMBNAIL_INTERVAL_MS = 4000;
const THUMBNAIL_SIZE = 640;
/** Keeps each push well under the host's 4 MB message limit. */
const PUSH_CHUNK_BYTES = 1_000_000;

type Detail<T extends ServerEvent['type']> = Extract<ServerEvent, { type: T }>;

/** The pasted image an element shows, if it's an image. */
function fileIdOf(e: ExcalidrawElement): string | null {
  return e.type === 'image' ? (e as { fileId?: string | null }).fileId ?? null : null;
}

/** Light or dark, following the system like the rest of Agent HQ. */
function usePrefersDark() {
  const query = useMemo(() => window.matchMedia('(prefers-color-scheme: dark)'), []);
  const [dark, setDark] = useState(query.matches);
  useEffect(() => {
    const on = () => setDark(query.matches);
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
  }, [query]);
  return dark;
}

/** Hue (0-360) of a #rrggbb color. */
function hueOf(hex: string): number {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const colorIds = new Map<string, string>();
/**
 * Excalidraw colors a collaborator's cursor from a hash of its `id` (a pastel
 * of one of 37 hues) and ignores `color`. Pick an id that hashes to the
 * player's own hue, so their cursor matches their color in the office.
 */
function cursorId(userId: string, color: string): string {
  const key = `${userId}${color}`;
  const cached = colorIds.get(key);
  if (cached) return cached;
  const target = Math.round(hueOf(color) / 10) % 36;
  let id = userId;
  for (let n = 0; n < 5000; n++) {
    const candidate = `${userId}~${n}`;
    let hash = 0;
    // Exactly Excalidraw's hashToInteger (no int32 wrap of the result).
    for (let i = 0; i < candidate.length; i++) hash = (hash << 5) - hash + candidate.charCodeAt(i);
    if (Math.abs(hash) % 37 === target) {
      id = candidate;
      break;
    }
  }
  colorIds.set(key, id);
  return id;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const n = JSON.stringify(item).length;
    if (current.length && size + n > PUSH_CHUNK_BYTES) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += n;
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * Editors open per board in this tab. The host subscribes the connection, not
 * the editor: only the last one to close unsubscribes (switching boards fast,
 * React's StrictMode remounts).
 */
const openEditors = new Map<ID, number>();

/** The board's live sync with the host, bound to an Excalidraw instance. */
class BoardSync {
  readonly boardId: ID;
  private api: ExcalidrawImperativeAPI | null = null;
  /**
   * The scene as of Excalidraw's last onChange (elements include deleted
   * ones). Pushes and thumbnails read this rather than the API: when the
   * editor closes, Excalidraw has already torn its scene down.
   */
  private latest: { elements: readonly ExcalidrawElement[]; appState: AppState; files: BinaryFiles } | null = null;
  /** Element id → the version we last sent or received. */
  private readonly known = new Map<string, number>();
  /** Files the host has (or refused: not retried). */
  private readonly filesOnHost = new Set<string>();
  private readonly fetchingFiles = new Set<string>();
  private readonly collaborators = new Map<SocketId, Collaborator>();
  private pushTimer: number | null = null;
  private pushing = false;
  private pushAgain = false;
  private lastCursor = 0;
  private cursorTimer: number | null = null;
  private pendingCursor: (() => void) | null = null;
  /** We changed the board since the last thumbnail. */
  private changedLocally = false;
  private thumbTimer: number;
  private closed = false;
  private closing = false;
  private readonly users: () => Snapshot['users'];
  private readonly onRemoved: () => void;
  private readonly unlisten: Array<() => void> = [];

  constructor(boardId: ID, users: () => Snapshot['users'], onRemoved: () => void) {
    this.boardId = boardId;
    this.users = users;
    this.onRemoved = onRemoved;
    openEditors.set(boardId, (openEditors.get(boardId) ?? 0) + 1);
    const on = <T extends ServerEvent['type']>(type: T, fn: (e: Detail<T>) => void) => {
      const listener = (ev: Event) => fn((ev as CustomEvent<Detail<T>>).detail);
      client.whiteboards.addEventListener(type, listener);
      this.unlisten.push(() => client.whiteboards.removeEventListener(type, listener));
    };
    on('whiteboard_elements', (e) => { if (e.boardId === boardId) this.applyRemote(e.elements); });
    on('whiteboard_files_added', (e) => { if (e.boardId === boardId) this.fetchMissingFiles(); });
    on('whiteboard_cursor', (e) => { if (e.boardId === boardId) this.onCursor(e); });
    on('whiteboard_removed', (e) => { if (e.id === boardId) this.onRemoved(); });
    const reconnect = () => { this.resync().catch(() => {}); };
    client.whiteboards.addEventListener('snapshot', reconnect);
    this.unlisten.push(() => client.whiteboards.removeEventListener('snapshot', reconnect));
    this.thumbTimer = window.setInterval(() => { if (this.changedLocally) this.renderThumbnail(); }, THUMBNAIL_INTERVAL_MS);
  }

  /** Subscribes to the board and returns what Excalidraw starts with. */
  async open() {
    const res = await client.request('whiteboard_open', { id: this.boardId });
    for (const el of res.elements) this.known.set(el.id, el.version);
    for (const f of res.files) this.filesOnHost.add(f.id);
    return res;
  }

  attach(api: ExcalidrawImperativeAPI) {
    this.api = api;
    this.fetchMissingFiles();
  }

  /** After a reconnect: merge the host's copy, then push what we drew meanwhile. */
  private async resync() {
    if (this.closed || !this.api) return;
    const res = await client.request('whiteboard_open', { id: this.boardId });
    this.known.clear();
    for (const el of res.elements) this.known.set(el.id, el.version);
    for (const f of res.files) this.filesOnHost.add(f.id);
    this.collaborators.clear();
    this.api.updateScene({ collaborators: new Map() });
    if (res.files.length) this.api.addFiles(res.files as unknown as BinaryFileData[]);
    this.applyRemote(res.elements);
    this.schedulePush();
  }

  // ---------------------------------------------------------------- local changes

  /** Excalidraw's onChange: cheap, the diff happens in the throttled push. */
  onChange = (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    if (this.closed) return;
    this.latest = { elements, appState, files };
    this.schedulePush();
  };

  private schedulePush() {
    if (this.pushTimer != null) return;
    this.pushTimer = window.setTimeout(() => {
      this.pushTimer = null;
      this.push().catch(() => {});
    }, PUSH_INTERVAL_MS);
  }

  private async push() {
    const scene = this.latest;
    if (!scene || this.closed) return;
    if (this.pushing) {
      this.pushAgain = true;
      return;
    }
    const changed = scene.elements.filter((e) => (this.known.get(e.id) ?? -1) < e.version);
    if (!changed.length) return;
    this.pushing = true;
    try {
      // Images first, so whoever receives the element can fetch its file.
      const files = scene.files;
      const newFiles = changed
        .map((e) => {
          const id = e.isDeleted ? null : fileIdOf(e);
          return id && !this.filesOnHost.has(id) ? files[id] : undefined;
        })
        .filter((f): f is BinaryFileData => !!f);
      if (newFiles.length) {
        for (const f of newFiles) this.filesOnHost.add(f.id);
        const payload: WhiteboardFile[] = newFiles.map((f) => ({ id: f.id, mimeType: f.mimeType, dataURL: f.dataURL, created: f.created }));
        for (const batch of chunks(payload)) {
          await client.request('whiteboard_add_files', { id: this.boardId, files: batch }).catch((err: Error) => {
            // The overlay covers the HUD's notifications: tell it in Excalidraw.
            this.api?.setToast({ message: err.message, closable: true, duration: 6000 });
          });
        }
      }
      for (const e of changed) this.known.set(e.id, e.version);
      this.changedLocally = true;
      for (const batch of chunks(changed as unknown as WhiteboardElement[])) {
        const { stale } = await client.request('whiteboard_push', { id: this.boardId, elements: batch });
        if (stale.length) this.applyRemote(stale);
      }
    } catch {
      // Disconnected: the resync after reconnecting pushes it again.
    } finally {
      this.pushing = false;
      if (this.pushAgain) {
        this.pushAgain = false;
        this.schedulePush();
      }
    }
  }

  // ---------------------------------------------------------------- remote changes

  private applyRemote(remote: WhiteboardElement[]) {
    const api = this.api;
    if (!api || this.closed || !remote.length) return;
    const restored = restoreElements(remote as unknown as ExcalidrawElement[], null) as unknown as RemoteExcalidrawElement[];
    const reconciled = reconcileElements(api.getSceneElementsIncludingDeleted() as OrderedExcalidrawElement[], restored, api.getAppState());
    const byId = new Map(reconciled.map((e) => [e.id, e]));
    for (const r of restored) {
      // Only what we took counts as known; a local copy that won still has to be pushed.
      if (byId.get(r.id)?.version === r.version) this.known.set(r.id, Math.max(this.known.get(r.id) ?? -1, r.version));
    }
    api.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER });
    this.fetchMissingFiles();
  }

  private fetchMissingFiles() {
    const api = this.api;
    if (!api) return;
    const have = api.getFiles();
    const missing = api.getSceneElements()
      .map(fileIdOf)
      .filter((id): id is string => !!id && !have[id] && !this.fetchingFiles.has(id));
    if (!missing.length) return;
    for (const id of missing) this.fetchingFiles.add(id);
    client.request('whiteboard_files', { id: this.boardId, fileIds: missing })
      .then((files) => {
        for (const f of files) this.filesOnHost.add(f.id);
        if (files.length) api.addFiles(files as unknown as BinaryFileData[]);
      })
      .catch(() => {})
      // Not uploaded yet: whiteboard_files_added will tell us when it is.
      .finally(() => { for (const id of missing) this.fetchingFiles.delete(id); });
  }

  // ---------------------------------------------------------------- cursors

  onPointerUpdate = (payload: { pointer: { x: number; y: number; tool: 'pointer' | 'laser' }; button: 'down' | 'up' }) => {
    if (this.closed) return;
    const send = () => {
      this.lastCursor = Date.now();
      const selected = Object.keys(this.api?.getAppState().selectedElementIds ?? {});
      client.request('whiteboard_cursor', { id: this.boardId, pointer: payload.pointer, button: payload.button, selectedElementIds: selected }).catch(() => {});
    };
    const wait = this.lastCursor + CURSOR_INTERVAL_MS - Date.now();
    if (wait <= 0) return send();
    // Keep only the latest position; send it when the interval is over.
    this.pendingCursor = send;
    if (this.cursorTimer == null) {
      this.cursorTimer = window.setTimeout(() => {
        this.cursorTimer = null;
        this.pendingCursor?.();
        this.pendingCursor = null;
      }, wait);
    }
  };

  private onCursor(e: Detail<'whiteboard_cursor'>) {
    const key = e.peerId as SocketId;
    if (!e.pointer) this.collaborators.delete(key);
    else {
      const user = this.users().find((u) => u.id === e.userId);
      const color = user?.color ?? '#888888';
      this.collaborators.set(key, {
        id: cursorId(e.userId, color),
        socketId: key,
        username: user?.name ?? 'Someone',
        pointer: e.pointer,
        button: e.button,
        color: { background: color, stroke: color },
        selectedElementIds: Object.fromEntries(e.selectedElementIds.map((id) => [id, true])) as AppState['selectedElementIds'],
      });
    }
    this.api?.updateScene({ collaborators: new Map(this.collaborators) });
  }

  // ---------------------------------------------------------------- thumbnail

  private async renderThumbnail() {
    const scene = this.latest;
    if (!scene) return;
    this.changedLocally = false;
    const elements = scene.elements.filter((e) => !e.isDeleted);
    let dataUrl: string | null = null;
    if (elements.length) {
      // Always light: the physical whiteboard is white.
      const blob = await exportToBlob({
        elements,
        files: scene.files,
        appState: { ...scene.appState, exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false },
        maxWidthOrHeight: THUMBNAIL_SIZE,
        mimeType: 'image/png',
      });
      dataUrl = await blobToDataUrl(blob);
    }
    await client.request('whiteboard_set_thumbnail', { id: this.boardId, dataUrl }).catch(() => {});
  }

  /** Leaves the board: pushes what's left and renders a last thumbnail if we changed it. */
  async close() {
    if (this.closing) return;
    this.closing = true;
    openEditors.set(this.boardId, (openEditors.get(this.boardId) ?? 1) - 1);
    if (this.pushTimer != null) {
      window.clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    await this.push().catch(() => {});
    this.closed = true;
    window.clearInterval(this.thumbTimer);
    if (this.cursorTimer != null) window.clearTimeout(this.cursorTimer);
    for (const off of this.unlisten) off();
    if (this.changedLocally) await this.renderThumbnail().catch(() => {});
    if (!openEditors.get(this.boardId)) await client.request('whiteboard_close', { id: this.boardId }).catch(() => {});
  }
}

export default function WhiteboardEditor(props: {
  board: WhiteboardInfo;
  world: Snapshot;
  /** The board was deleted while open. */
  onRemoved: () => void;
}) {
  const { board } = props;
  const dark = usePrefersDark();
  const worldRef = useRef(props.world);
  worldRef.current = props.world;
  const onRemoved = useRef(props.onRemoved);
  onRemoved.current = props.onRemoved;
  const [sync, setSync] = useState<BoardSync | null>(null);
  const [initial, setInitial] = useState<{ elements: WhiteboardElement[]; files: WhiteboardFile[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = new BoardSync(board.id, () => worldRef.current.users, () => onRemoved.current());
    let alive = true;
    s.open().then(
      (res) => { if (alive) { setSync(s); setInitial({ elements: res.elements, files: res.files }); } },
      (err: Error) => { if (alive) setError(err.message); },
    );
    return () => {
      alive = false;
      s.close().catch(() => {});
    };
  }, [board.id]);

  const onApi = useCallback((api: ExcalidrawImperativeAPI) => sync?.attach(api), [sync]);

  if (error) return <div className="wb-loading">Could not open this board: {error}</div>;
  if (!sync || !initial) return <div className="wb-loading">Opening {board.name}…</div>;
  return (
    <Excalidraw
      key={board.id}
      name={board.name}
      theme={dark ? 'dark' : 'light'}
      isCollaborating
      initialData={{
        elements: initial.elements as unknown as ExcalidrawElement[],
        files: Object.fromEntries(initial.files.map((f) => [f.id, f])) as unknown as BinaryFiles,
        scrollToContent: true,
      }}
      excalidrawAPI={onApi}
      onChange={sync.onChange}
      onPointerUpdate={sync.onPointerUpdate}
      // Loading a file would replace the shared scene without telling the others.
      UIOptions={{ canvasActions: { loadScene: false } }}
    />
  );
}
