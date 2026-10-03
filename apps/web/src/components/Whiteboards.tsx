import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import type { ID, Snapshot, WhiteboardInfo } from '@agent-hq/protocol';
import { run } from '../api.ts';
import { ago, floorLabel, stamp } from '../format.ts';
import { floorSpot, openWhiteboard, useThumbnail, useWhiteboards, type OpenBoardDetail } from '../whiteboards.ts';
import { Modal } from './Modal.tsx';
import '../whiteboards.css';

// Whiteboards: the list (main menu → Whiteboards) and the full-screen editor
// overlay, opened from the list or from a whiteboard in the office (see
// office3d/WhiteboardStand.tsx). <WhiteboardLayer/> mounts both; open them
// from anywhere with openWhiteboard / openWhiteboards (whiteboards.ts).

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

// Excalidraw is big: it's only downloaded when a board is first opened. Its
// fonts are served by the host (copied at build time, see vite.config.ts),
// with Excalidraw's CDN as the fallback (e.g. CJK, which isn't copied).
const WhiteboardEditor = lazy(() => {
  window.EXCALIDRAW_ASSET_PATH = `${import.meta.env.BASE_URL}excalidraw-assets/`;
  return import('./WhiteboardEditor.tsx');
});

const canManage = (world: Snapshot, board: WhiteboardInfo) => world.you.role === 'owner' || board.createdBy === world.you.id;

/** Where a board hangs, in words. */
export function spotLabel(world: Snapshot, spot: string | null): string | null {
  if (!spot) return null;
  if (spot.startsWith('floor:')) {
    const floor = world.floors.find((f) => `floor:${f.id}` === spot);
    return floor ? `Easel on ${floorLabel(floor.level)} · ${floor.name}` : 'Easel on a removed floor';
  }
  if (spot.startsWith('meeting')) return 'Meeting room wall';
  return 'In the office';
}

function Viewers({ world, ids }: { world: Snapshot; ids: ID[] }) {
  if (!ids.length) return null;
  return (
    <span className="wb-viewers" title={`Drawing now: ${ids.map((id) => world.users.find((u) => u.id === id)?.name ?? 'someone').join(', ')}`}>
      {ids.map((id) => {
        const user = world.users.find((u) => u.id === id);
        return <span key={id} className="wb-avatar" style={{ background: user?.color ?? '#888' }}>{(user?.name ?? '?').slice(0, 1).toUpperCase()}</span>;
      })}
    </span>
  );
}

async function rename(board: WhiteboardInfo) {
  const name = window.prompt('Rename the board', board.name);
  if (name && name.trim() && name.trim() !== board.name) await run('whiteboard_update', { id: board.id, patch: { name } }).catch(() => {});
}

async function remove(board: WhiteboardInfo) {
  if (window.confirm(`Delete "${board.name}" and its drawings for everyone? This can't be undone.`)) {
    await run('whiteboard_delete', { id: board.id }).catch(() => {});
  }
}

function BoardCard(props: { world: Snapshot; board: WhiteboardInfo; here: string | null; onOpen: () => void }) {
  const { world, board, here } = props;
  const thumb = useThumbnail(board);
  const creator = world.users.find((u) => u.id === board.createdBy)?.name ?? 'a former player';
  const where = spotLabel(world, board.spot);
  return (
    <article className="wb-card">
      <button className="wb-thumb" onClick={props.onOpen} title={`Open ${board.name}`}>
        {thumb ? <img src={thumb} alt="" /> : <span className="muted">Empty board</span>}
      </button>
      <div className="wb-card-body">
        <div className="row nowrap">
          <strong className="wb-card-name" title={board.name}>{board.name}</strong>
          <span className="spacer" />
          <Viewers world={world} ids={board.viewers} />
        </div>
        <div className="muted small-text">
          by {creator} · <span title={stamp(board.updatedAt)}>{ago(board.updatedAt)}</span>
        </div>
        {where && <div className="small-text">📍 {where}</div>}
        <div className="row nowrap">
          <button className="small" onClick={props.onOpen}>Open</button>
          {here && board.spot !== here && (
            <button className="small ghost" onClick={() => run('whiteboard_update', { id: board.id, patch: { spot: here } }).catch(() => {})} title="Show it on the easel by this floor's task board">
              📍 Hang here
            </button>
          )}
          <span className="spacer" />
          {canManage(world, board) && (
            <>
              <button className="icon-btn" aria-label={`Rename ${board.name}`} title="Rename" onClick={() => rename(board)}>✎</button>
              <button className="icon-btn danger" aria-label={`Delete ${board.name}`} title="Delete" onClick={() => remove(board)}>🗑</button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function WhiteboardList(props: { world: Snapshot; here: string | null; onClose: () => void; onOpen: (id: ID) => void }) {
  const boards = useWhiteboards();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const board = await run('whiteboard_create', { name });
      setName('');
      props.onOpen(board.id);
    } catch {
      // shown as a toast
    } finally {
      setBusy(false);
    }
  };
  const sorted = [...boards].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <Modal title="🖍️ Whiteboards" subtitle="Draw together. Boards are saved in this office." onClose={props.onClose} wide>
      <form className="row nowrap wb-new" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New board name, e.g. Architecture sketch" maxLength={80} aria-label="New board name" />
        <button type="submit" disabled={busy || !name.trim()}>＋ New board</button>
      </form>
      {sorted.length === 0 ? (
        <p className="empty">No whiteboards yet. Create one, or click the easel next to the task board.</p>
      ) : (
        <div className="wb-grid">
          {sorted.map((b) => <BoardCard key={b.id} world={props.world} board={b} here={props.here} onOpen={() => props.onOpen(b.id)} />)}
        </div>
      )}
    </Modal>
  );
}

/** The full-screen editor: a slim bar over Excalidraw. */
function WhiteboardOverlay(props: { world: Snapshot; board: WhiteboardInfo | undefined; here: string | null; onClose: () => void; onList: () => void }) {
  const { world, board } = props;
  const boards = useWhiteboards();
  return (
    // data-captures-keys: drawing shortcuts must not walk the player around (Controls.tsx).
    <div className="wb-overlay" role="dialog" aria-modal="true" aria-label={board ? `Whiteboard ${board.name}` : 'Whiteboard'} data-captures-keys>
      <header className="wb-bar">
        <button className="small ghost" onClick={props.onClose} title="Back to the office">← Office</button>
        {board && (
          <>
            <select className="wb-switch" value={board.id} onChange={(e) => openWhiteboard(e.target.value)} aria-label="Switch board">
              {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            {canManage(world, board) && <button className="icon-btn" title="Rename" aria-label="Rename" onClick={() => rename(board)}>✎</button>}
            {props.here && board.spot !== props.here && (
              <button className="small ghost" onClick={() => run('whiteboard_update', { id: board.id, patch: { spot: props.here } }).catch(() => {})} title="Show it on the easel by this floor's task board">
                📍 Hang on this floor
              </button>
            )}
          </>
        )}
        <span className="spacer" />
        {board && <Viewers world={world} ids={board.viewers} />}
        <button className="small ghost" onClick={props.onList}>All boards</button>
      </header>
      <div className="wb-canvas">
        {board ? (
          <Suspense fallback={<div className="wb-loading">Loading the whiteboard…</div>}>
            <WhiteboardEditor key={board.id} board={board} world={world} onRemoved={props.onClose} />
          </Suspense>
        ) : (
          <div className="wb-loading">Opening…</div>
        )}
      </div>
    </div>
  );
}

/** Mounts the Whiteboards list and editor; `floorId` is the floor on screen (where "Hang here" puts a board). */
export function WhiteboardLayer(props: { world: Snapshot; floorId: ID | null }) {
  const boards = useWhiteboards();
  const [list, setList] = useState(false);
  const [openId, setOpenId] = useState<ID | null>(null);
  const here = props.floorId ? floorSpot(props.floorId) : null;

  useEffect(() => {
    const onOpen = (e: Event) => {
      const { id } = (e as CustomEvent<OpenBoardDetail>).detail;
      setList(false);
      setOpenId(id);
    };
    const onList = () => setList(true);
    window.addEventListener('hq-open-whiteboard', onOpen);
    window.addEventListener('hq-open-whiteboards', onList);
    return () => {
      window.removeEventListener('hq-open-whiteboard', onOpen);
      window.removeEventListener('hq-open-whiteboards', onList);
    };
  }, []);

  const board = boards.find((b) => b.id === openId);
  // Deleted while open (or a stale id): close once the list knows it's gone.
  useEffect(() => {
    if (openId && boards.length && !board) {
      const t = setTimeout(() => setOpenId(null), 1500);
      return () => clearTimeout(t);
    }
  }, [openId, board, boards.length]);

  return (
    <>
      {list && <WhiteboardList world={props.world} here={here} onClose={() => setList(false)} onOpen={(id) => openWhiteboard(id)} />}
      {openId && (
        <WhiteboardOverlay
          world={props.world}
          board={board}
          here={here}
          onClose={() => setOpenId(null)}
          onList={() => { setOpenId(null); setList(true); }}
        />
      )}
    </>
  );
}
