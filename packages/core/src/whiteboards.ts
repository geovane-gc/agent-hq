import { randomUUID } from 'node:crypto';
import type {
  ID,
  ServerEvent,
  User,
  WhiteboardCommandName,
  WhiteboardCommands,
  WhiteboardElement,
  WhiteboardFile,
  WhiteboardInfo,
  WhiteboardPointer,
} from '@agent-hq/protocol';
import type { Db } from './db.ts';
import type { Store } from './store.ts';

// Collaborative drawing boards (Excalidraw), stored per office.
//
// - Sync: clients push the elements they changed; the host keeps whichever
//   copy wins Excalidraw's reconciliation rule (higher `version`, then the
//   lower `versionNonce`), relays the winners to the board's other viewers and
//   answers the sender with its own copy where the sender's lost. Every client
//   reconciles what it receives with the same rule (reconcileElements), so
//   everyone converges on the host's copy.
// - Persistence: one row per element (deleted ones stay as tombstones so an
//   old copy can't come back), written in batches a moment after the last
//   change rather than on every stroke. Pasted images live in their own
//   table with size limits; the thumbnail (a small PNG the editing client
//   renders) on the board's row.
// - Cursors are relayed to the board's viewers only, never stored.
//
// The tables are created here (not in db.ts migrations) so whiteboards stay a
// self-contained module, like the economy's ledger.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS whiteboards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    spot TEXT,
    thumbnail TEXT,
    thumbnail_version INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS whiteboard_elements (
    board_id TEXT NOT NULL,
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (board_id, id)
  );
  CREATE TABLE IF NOT EXISTS whiteboard_files (
    board_id TEXT NOT NULL,
    id TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    data_url TEXT NOT NULL,
    size INTEGER NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (board_id, id)
  );`;

export const WHITEBOARD_COMMANDS = new Set<string>([
  'whiteboard_list', 'whiteboard_create', 'whiteboard_update', 'whiteboard_delete', 'whiteboard_open', 'whiteboard_close',
  'whiteboard_push', 'whiteboard_cursor', 'whiteboard_add_files', 'whiteboard_files', 'whiteboard_set_thumbnail', 'whiteboard_thumbnail',
] satisfies WhiteboardCommandName[]);

/** Save this long after the last change… */
const SAVE_DEBOUNCE_MS = 1500;
/** …but at least this often while someone keeps drawing. */
const SAVE_MAX_WAIT_MS = 8000;
const MAX_BOARDS = 200;
const MAX_ELEMENTS = 20_000;
/** One element's JSON (a long freehand stroke is the biggest). */
const MAX_ELEMENT_BYTES = 512 * 1024;
/** One pasted image, as a data URL. The WebSocket takes 4 MB per message. */
const MAX_FILE_BYTES = 3.5 * 1024 * 1024;
const MAX_BOARD_FILE_BYTES = 64 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 600 * 1024;
const FILE_MIME = /^(image\/(png|jpeg|gif|webp|svg\+xml|bmp|x-icon|avif)|application\/octet-stream)$/;

/** One open connection (a browser tab) of a player. */
export interface WhiteboardPeer {
  id: string;
  user: User;
  send: (event: ServerEvent) => void;
}

/** A board as stored; `viewers` is live state. */
type BoardRecord = Omit<WhiteboardInfo, 'viewers'>;

interface LiveBoard {
  elements: Map<string, WhiteboardElement>;
  /** Element ids changed since the last save. */
  dirty: Set<string>;
  peers: Set<WhiteboardPeer>;
  saveTimer: NodeJS.Timeout | null;
  firstDirtyAt: number;
}

interface BoardRow {
  id: string;
  name: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  spot: string | null;
  thumbnail_version: number;
}

const toRecord = (r: BoardRow): BoardRecord => ({
  id: String(r.id),
  name: String(r.name),
  createdBy: String(r.created_by),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  spot: r.spot == null ? null : String(r.spot),
  thumbnailVersion: Number(r.thumbnail_version),
});

/** Excalidraw's rule (data/reconcile.ts): does `incoming` replace `current`? */
export function wins(incoming: WhiteboardElement, current: WhiteboardElement | undefined): boolean {
  if (!current) return true;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return incoming.versionNonce < current.versionNonce;
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new Error('Give the board a name');
  if (name.length > 80) throw new Error('That name is too long (80 characters max)');
  return name;
}

function cleanSpot(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 120) throw new Error('Invalid spot');
  return value;
}

function validElement(e: unknown): e is WhiteboardElement {
  if (!e || typeof e !== 'object') return false;
  const el = e as WhiteboardElement;
  return typeof el.id === 'string' && el.id.length > 0 && el.id.length <= 100
    && Number.isInteger(el.version) && typeof el.versionNonce === 'number';
}

export class Whiteboards {
  private readonly db: Db;
  private readonly store: Store;
  private readonly boards = new Map<ID, BoardRecord>();
  private readonly live = new Map<ID, LiveBoard>();

  constructor(db: Db, store: Store) {
    this.db = db;
    this.store = store;
    db.sql.exec(SCHEMA);
    for (const row of db.sql.prepare('SELECT id, name, created_by, created_at, updated_at, spot, thumbnail_version FROM whiteboards').all()) {
      const record = toRecord(row as unknown as BoardRow);
      this.boards.set(record.id, record);
    }
  }

  // ------------------------------------------------------------------ queries

  list(): WhiteboardInfo[] {
    return [...this.boards.values()].sort((a, b) => a.createdAt - b.createdAt).map((b) => this.info(b));
  }

  private info(board: BoardRecord): WhiteboardInfo {
    const peers = this.live.get(board.id)?.peers;
    return { ...board, viewers: peers ? [...new Set([...peers].map((p) => p.user.id))] : [] };
  }

  private require(id: unknown): BoardRecord {
    const board = typeof id === 'string' ? this.boards.get(id) : undefined;
    if (!board) throw new Error('That whiteboard no longer exists');
    return board;
  }

  private announce(board: BoardRecord) {
    this.store.broadcast({ type: 'whiteboard', whiteboard: this.info(board) });
  }

  private canManage(board: BoardRecord, user: User) {
    return user.role === 'owner' || board.createdBy === user.id;
  }

  /** The board's elements in memory, loaded from the database on first use. */
  private load(id: ID): LiveBoard {
    let live = this.live.get(id);
    if (!live) {
      const elements = new Map<string, WhiteboardElement>();
      for (const row of this.db.sql.prepare('SELECT data FROM whiteboard_elements WHERE board_id = ?').all(id)) {
        const el = JSON.parse(String((row as { data: string }).data)) as WhiteboardElement;
        elements.set(el.id, el);
      }
      live = { elements, dirty: new Set(), peers: new Set(), saveTimer: null, firstDirtyAt: 0 };
      this.live.set(id, live);
    }
    return live;
  }

  // ------------------------------------------------------------------ commands

  async handle<K extends WhiteboardCommandName>(
    command: K,
    args: WhiteboardCommands[K]['args'],
    peer: WhiteboardPeer,
  ): Promise<WhiteboardCommands[K]['result']> {
    const a = (args ?? {}) as Record<string, unknown>;
    type R = WhiteboardCommands[K]['result'];
    const user = peer.user;
    switch (command) {
      case 'whiteboard_list':
        return this.list() as R;

      case 'whiteboard_create': {
        if (this.boards.size >= MAX_BOARDS) throw new Error(`An office can have up to ${MAX_BOARDS} whiteboards`);
        const now = Date.now();
        const board: BoardRecord = {
          id: randomUUID(), name: cleanName(a.name), createdBy: user.id, createdAt: now, updatedAt: now, spot: null, thumbnailVersion: 0,
        };
        this.db.sql.prepare('INSERT INTO whiteboards (id, name, created_by, created_at, updated_at, spot, thumbnail_version) VALUES (?, ?, ?, ?, ?, NULL, 0)')
          .run(board.id, board.name, board.createdBy, board.createdAt, board.updatedAt);
        this.boards.set(board.id, board);
        const spot = cleanSpot(a.spot);
        if (spot) this.hang(board, spot);
        else this.announce(board);
        return this.info(board) as R;
      }

      case 'whiteboard_update': {
        const board = this.require(a.id);
        const patch = (a.patch ?? {}) as { name?: unknown; spot?: unknown };
        if (patch.name !== undefined) {
          if (!this.canManage(board, user)) throw new Error('Only its creator or the office owner can rename this board');
          board.name = cleanName(patch.name);
          this.db.sql.prepare('UPDATE whiteboards SET name = ? WHERE id = ?').run(board.name, board.id);
        }
        if (patch.spot !== undefined) this.hang(board, cleanSpot(patch.spot));
        else this.announce(board);
        return this.info(board) as R;
      }

      case 'whiteboard_delete': {
        const board = this.require(a.id);
        if (!this.canManage(board, user)) throw new Error('Only its creator or the office owner can delete this board');
        const live = this.live.get(board.id);
        if (live?.saveTimer) clearTimeout(live.saveTimer);
        this.live.delete(board.id);
        this.boards.delete(board.id);
        this.db.sql.exec('BEGIN');
        try {
          for (const table of ['whiteboard_elements', 'whiteboard_files']) this.db.sql.prepare(`DELETE FROM ${table} WHERE board_id = ?`).run(board.id);
          this.db.sql.prepare('DELETE FROM whiteboards WHERE id = ?').run(board.id);
          this.db.sql.exec('COMMIT');
        } catch (err) {
          this.db.sql.exec('ROLLBACK');
          throw err;
        }
        this.store.broadcast({ type: 'whiteboard_removed', id: board.id });
        return null as R;
      }

      case 'whiteboard_open': {
        const board = this.require(a.id);
        const live = this.load(board.id);
        const before = live.peers.size;
        live.peers.add(peer);
        if (live.peers.size !== before) this.announce(board);
        const elements = [...live.elements.values()];
        const fileIds = new Set<string>();
        for (const el of elements) if (!el.isDeleted && typeof el.fileId === 'string') fileIds.add(el.fileId);
        return { board: this.info(board), elements, files: this.files(board.id, [...fileIds]), peerId: peer.id } as R;
      }

      case 'whiteboard_close': {
        if (typeof a.id === 'string') this.leaveBoard(a.id, peer);
        return null as R;
      }

      case 'whiteboard_push': {
        const board = this.require(a.id);
        const live = this.load(board.id);
        if (!live.peers.has(peer)) throw new Error('Open the board first');
        const incoming = Array.isArray(a.elements) ? a.elements : [];
        const accepted: WhiteboardElement[] = [];
        const stale: WhiteboardElement[] = [];
        for (const el of incoming) {
          if (!validElement(el)) continue;
          const current = live.elements.get(el.id);
          if (!wins(el, current)) {
            if (current && (current.version !== el.version || current.versionNonce !== el.versionNonce)) stale.push(current);
            continue;
          }
          if (!current && live.elements.size >= MAX_ELEMENTS) throw new Error(`A board can have up to ${MAX_ELEMENTS} elements`);
          if (JSON.stringify(el).length > MAX_ELEMENT_BYTES) continue;
          live.elements.set(el.id, el);
          live.dirty.add(el.id);
          accepted.push(el);
        }
        if (accepted.length) {
          for (const other of live.peers) if (other !== peer) other.send({ type: 'whiteboard_elements', boardId: board.id, elements: accepted });
          this.scheduleSave(board.id, live);
        }
        return { stale } as R;
      }

      case 'whiteboard_cursor': {
        const live = typeof a.id === 'string' ? this.live.get(a.id) : undefined;
        if (!live?.peers.has(peer)) return null as R;
        const pointer = a.pointer as WhiteboardPointer | null;
        const event: ServerEvent = {
          type: 'whiteboard_cursor',
          boardId: a.id as string,
          peerId: peer.id,
          userId: user.id,
          pointer: pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)
            ? { x: pointer.x, y: pointer.y, tool: pointer.tool === 'laser' ? 'laser' : 'pointer' }
            : null,
          button: a.button === 'down' ? 'down' : 'up',
          selectedElementIds: Array.isArray(a.selectedElementIds) ? a.selectedElementIds.filter((x) => typeof x === 'string').slice(0, 500) : [],
        };
        for (const other of live.peers) if (other !== peer) other.send(event);
        return null as R;
      }

      case 'whiteboard_add_files': {
        const board = this.require(a.id);
        const files = Array.isArray(a.files) ? (a.files as WhiteboardFile[]) : [];
        let used = Number((this.db.sql.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM whiteboard_files WHERE board_id = ?').get(board.id) as { n: number }).n);
        const exists = this.db.sql.prepare('SELECT 1 FROM whiteboard_files WHERE board_id = ? AND id = ?');
        const insert = this.db.sql.prepare('INSERT INTO whiteboard_files (board_id, id, mime_type, data_url, size, created) VALUES (?, ?, ?, ?, ?, ?)');
        const stored: string[] = [];
        const added: string[] = [];
        for (const f of files) {
          if (!f || typeof f.id !== 'string' || !f.id || f.id.length > 100 || typeof f.dataURL !== 'string') continue;
          if (exists.get(board.id, f.id)) { stored.push(f.id); continue; }
          if (!FILE_MIME.test(String(f.mimeType)) || !f.dataURL.startsWith('data:')) throw new Error('Only images can be added to a whiteboard');
          const size = f.dataURL.length;
          if (size > MAX_FILE_BYTES) throw new Error(`That image is too big for the whiteboard (${(MAX_FILE_BYTES / 1024 / 1024).toFixed(1)} MB max)`);
          if (used + size > MAX_BOARD_FILE_BYTES) throw new Error(`This board is full of images (${MAX_BOARD_FILE_BYTES / 1024 / 1024} MB max)`);
          insert.run(board.id, f.id, f.mimeType, f.dataURL, size, Number(f.created) || Date.now());
          used += size;
          stored.push(f.id);
          added.push(f.id);
        }
        const live = this.live.get(board.id);
        if (live && added.length) for (const other of live.peers) if (other !== peer) other.send({ type: 'whiteboard_files_added', boardId: board.id, fileIds: added });
        return { stored } as R;
      }

      case 'whiteboard_files': {
        const board = this.require(a.id);
        const ids = Array.isArray(a.fileIds) ? a.fileIds.filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
        return this.files(board.id, ids) as R;
      }

      case 'whiteboard_set_thumbnail': {
        const board = this.require(a.id);
        const dataUrl = a.dataUrl == null ? null : String(a.dataUrl);
        if (dataUrl && (!dataUrl.startsWith('data:image/') || dataUrl.length > MAX_THUMBNAIL_BYTES)) throw new Error('Invalid thumbnail');
        board.thumbnailVersion += 1;
        this.db.sql.prepare('UPDATE whiteboards SET thumbnail = ?, thumbnail_version = ? WHERE id = ?').run(dataUrl, board.thumbnailVersion, board.id);
        this.announce(board);
        return null as R;
      }

      case 'whiteboard_thumbnail': {
        const board = this.require(a.id);
        const row = this.db.sql.prepare('SELECT thumbnail FROM whiteboards WHERE id = ?').get(board.id) as { thumbnail: string | null } | undefined;
        return { version: board.thumbnailVersion, dataUrl: row?.thumbnail ?? null } as R;
      }
    }
    throw new Error(`Unknown command: ${command}`);
  }

  /** One board per spot: hanging this one takes the spot from any other. */
  private hang(board: BoardRecord, spot: string | null) {
    if (spot) {
      for (const other of this.boards.values()) {
        if (other !== board && other.spot === spot) {
          other.spot = null;
          this.db.sql.prepare('UPDATE whiteboards SET spot = NULL WHERE id = ?').run(other.id);
          this.announce(other);
        }
      }
    }
    board.spot = spot;
    this.db.sql.prepare('UPDATE whiteboards SET spot = ? WHERE id = ?').run(spot, board.id);
    this.announce(board);
  }

  private files(boardId: ID, ids: string[]): WhiteboardFile[] {
    const get = this.db.sql.prepare('SELECT id, mime_type, data_url, created FROM whiteboard_files WHERE board_id = ? AND id = ?');
    const out: WhiteboardFile[] = [];
    for (const id of ids) {
      const r = get.get(boardId, id) as { id: string; mime_type: string; data_url: string; created: number } | undefined;
      if (r) out.push({ id: String(r.id), mimeType: String(r.mime_type), dataURL: String(r.data_url), created: Number(r.created) });
    }
    return out;
  }

  // ------------------------------------------------------------------ viewers

  /** A connection closed: it leaves every board it had open. */
  leave(peer: WhiteboardPeer) {
    for (const [id, live] of this.live) if (live.peers.has(peer)) this.leaveBoard(id, peer);
  }

  private leaveBoard(id: ID, peer: WhiteboardPeer) {
    const live = this.live.get(id);
    const board = this.boards.get(id);
    if (!live?.peers.delete(peer)) return;
    for (const other of live.peers) {
      other.send({ type: 'whiteboard_cursor', boardId: id, peerId: peer.id, userId: peer.user.id, pointer: null, button: 'up', selectedElementIds: [] });
    }
    if (board) this.announce(board);
    // Nobody is looking: save what's pending and free the memory.
    if (live.peers.size === 0) {
      this.save(id, live);
      this.live.delete(id);
    }
  }

  // ------------------------------------------------------------------ persistence

  private scheduleSave(id: ID, live: LiveBoard) {
    const now = Date.now();
    if (!live.firstDirtyAt) live.firstDirtyAt = now;
    if (live.saveTimer) clearTimeout(live.saveTimer);
    const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, live.firstDirtyAt + SAVE_MAX_WAIT_MS - now));
    live.saveTimer = setTimeout(() => this.save(id, live), wait);
    live.saveTimer.unref?.();
  }

  /** Writes the elements changed since the last save, in one transaction. */
  private save(id: ID, live: LiveBoard) {
    if (live.saveTimer) clearTimeout(live.saveTimer);
    live.saveTimer = null;
    live.firstDirtyAt = 0;
    const board = this.boards.get(id);
    if (!board || live.dirty.size === 0) return;
    const upsert = this.db.sql.prepare(
      `INSERT INTO whiteboard_elements (board_id, id, version, data) VALUES (?, ?, ?, ?)
       ON CONFLICT (board_id, id) DO UPDATE SET version = excluded.version, data = excluded.data`,
    );
    board.updatedAt = Date.now();
    this.db.sql.exec('BEGIN');
    try {
      for (const elementId of live.dirty) {
        const el = live.elements.get(elementId);
        if (el) upsert.run(id, el.id, el.version, JSON.stringify(el));
      }
      this.db.sql.prepare('UPDATE whiteboards SET updated_at = ? WHERE id = ?').run(board.updatedAt, id);
      this.db.sql.exec('COMMIT');
    } catch (err) {
      this.db.sql.exec('ROLLBACK');
      console.error(`[whiteboards] could not save ${board.name}: ${(err as Error).message}`);
      this.scheduleSave(id, live);
      return;
    }
    live.dirty.clear();
    this.announce(board);
  }

  /** Saves everything pending (office closing, host shutting down). */
  flush() {
    for (const [id, live] of this.live) this.save(id, live);
  }
}
