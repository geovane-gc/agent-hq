import { useMemo, type CSSProperties } from 'react';
import type { Agent, DeskItem, DeskStyle, Floor, FloorTheme, Snapshot } from '@agent-hq/protocol';
import {
  BASIC_DESK, CHAIR_MODELS, catalogItem, DECOR_CATALOG, DECOR_CATEGORIES, DESK_ITEMS, DESK_MODELS, deskStyleCost, EXTRA_MONITOR_PRICE,
  FLOOR_MATERIALS, LIGHTING_PRESETS, THEME_PRESETS, WALL_FINISHES, WINDOW_VIEWS, type CatalogItem,
} from '@agent-hq/protocol/catalog';
import { usd } from '../format.ts';
import { deleteItem, editor, recolorItem, redo, setDesks, setTheme, undo, useEditor } from '../office3d/decor/editor.ts';
import { floorLook, swatchUrl, wallLook } from '../office3d/decor/textures.ts';
import { ThumbnailBaker, useThumbnails } from '../office3d/decor/Thumbnails.tsx';
import { COLORS } from './forms.tsx';
import '../decor.css';

// Decorate mode's HUD: a toolbar on top (undo/redo, grid, done) and a
// drawer at the bottom with the catalog, the room style and desk upgrades.
// The 3D side (ghost, picking, shortcuts) is office3d/decor/DecorEditor.tsx.

const WALL_COLORS = ['#e9e4da', '#ffffff', '#f4f4f2', '#dfe7ef', '#e8dcd0', '#d5e3d5', '#f2d7d9', '#c9a27a', '#b4644a', '#7d8794', '#3a3f4b', '#2a2440'];
const ITEM_COLORS = ['#e5484d', '#f76b15', '#ffcf33', '#30a46c', '#12a594', '#3d63dd', '#8e4ec6', '#d6409f', '#5b6b8c', '#8a6a4a', '#e8e2d6', '#2b2f36'];

function Swatch({ color, on, onClick, label }: { color: string; on: boolean; onClick: () => void; label?: string }) {
  return <button type="button" className={`swatch ${on ? 'on' : ''}`} style={{ background: color }} onClick={onClick} aria-label={label ?? color} aria-pressed={on} title={label ?? color} />;
}

/** Price label: free in sandbox, red when career cash can't cover it. */
function Price({ world, price }: { world: Snapshot; price: number }) {
  const eco = world.economy;
  if (price === 0) return <span className="decor-price free">Free</span>;
  if (!eco || eco.mode !== 'career') return <span className="decor-price free" title="Sandbox: everything is free"><s>{usd(price)}</s>free</span>;
  return <span className={`decor-price ${eco.cash < price ? 'short' : ''}`} title={eco.cash < price ? `You have ${usd(eco.cash)}` : undefined}>{usd(price)}</span>;
}

// ---------------------------------------------------------------- items

function ItemCard({ world, entry, active }: { world: Snapshot; entry: CatalogItem; active: boolean }) {
  const thumb = useThumbnails()(entry.id);
  return (
    <button
      type="button"
      className={`decor-card ${active ? 'active' : ''}`}
      title={`${entry.name}: ${entry.blurb}`}
      onClick={() => editor.set({ tool: active ? { kind: 'idle' } : { kind: 'place', itemId: entry.id, rotation: 0, color: null }, selectedId: null })}
    >
      <span className="decor-thumb">{thumb ? <img src={thumb} alt="" draggable={false} /> : <span className="decor-thumb-wait" aria-hidden>{DECOR_CATEGORIES.find((c) => c.id === entry.category)?.icon}</span>}</span>
      <span className="decor-card-name">{entry.name}</span>
      <Price world={world} price={entry.price} />
    </button>
  );
}

function Inspector({ world }: { world: Snapshot }) {
  const ed = useEditor();
  const item = world.decor.find((d) => d.id === ed.selectedId);
  const entry = item && catalogItem(item.itemId);
  const placing = ed.tool.kind === 'place' ? catalogItem(ed.tool.itemId) : undefined;
  if (placing && ed.tool.kind === 'place') {
    const tool = ed.tool;
    return (
      <aside className="decor-inspector">
        <strong>{placing.name}</strong>
        <p className="hint">{placing.blurb}</p>
        {placing.tint && (
          <div className="swatches">
            {ITEM_COLORS.map((c) => <Swatch key={c} color={c} on={(tool.color ?? placing.tint) === c} onClick={() => editor.set({ tool: { ...tool, color: c } })} />)}
          </div>
        )}
        <p className="hint">Click to place · <kbd>R</kbd> rotate · right-click or <kbd>Esc</kbd> to stop</p>
      </aside>
    );
  }
  if (!item || !entry) {
    return (
      <aside className="decor-inspector muted">
        <strong>Pick something to place</strong>
        <p className="hint">Click a placed item to select it, drag it to move it. Click a desk to upgrade it.</p>
        <p className="hint"><kbd>R</kbd> rotate · <kbd>Del</kbd> remove · <kbd>G</kbd> grid · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo</p>
      </aside>
    );
  }
  const career = world.economy?.mode === 'career';
  return (
    <aside className="decor-inspector">
      <strong>{entry.name}</strong>
      <p className="hint">{entry.blurb}</p>
      {entry.tint && (
        <div className="swatches">
          {ITEM_COLORS.map((c) => <Swatch key={c} color={c} on={(item.color ?? entry.tint) === c} onClick={() => recolorItem(item, c)} />)}
        </div>
      )}
      <div className="row">
        <button type="button" className="small ghost" onClick={() => editor.set({ tool: { kind: 'move', id: item.id, rotation: item.rotation, drag: false } })}>✥ Move</button>
        <button type="button" className="small ghost danger" onClick={() => deleteItem(item)}>
          🗑 {career && item.paid > 0 ? `Sell (+${usd(item.paid)})` : 'Remove'}
        </button>
      </div>
    </aside>
  );
}

function ItemsTab({ world }: { world: Snapshot }) {
  const ed = useEditor();
  const items = DECOR_CATALOG.filter((i) => i.category === ed.category);
  const placing = ed.tool.kind === 'place' ? ed.tool.itemId : null;
  return (
    <div className="decor-items">
      <div className="decor-main">
        <div className="decor-cats" role="tablist">
          {DECOR_CATEGORIES.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={ed.category === c.id} className={`chip ${ed.category === c.id ? 'on' : ''}`} onClick={() => editor.set({ category: c.id })}>
              <span aria-hidden>{c.icon}</span> {c.label}
            </button>
          ))}
        </div>
        <div className="decor-grid">
          {items.map((entry) => <ItemCard key={entry.id} world={world} entry={entry} active={placing === entry.id} />)}
        </div>
      </div>
      <Inspector world={world} />
    </div>
  );
}

// ---------------------------------------------------------------- room

function RoomTab({ floor }: { floor: Floor }) {
  const t = floor.theme;
  const apply = (patch: Partial<FloorTheme>, label?: string) => setTheme(floor, patch, label);
  const floorSwatches = useMemo(() => Object.fromEntries(FLOOR_MATERIALS.map((m) => [m.id, swatchUrl(floorLook(m.id).texture)])), []);
  const wallSwatches = useMemo(() => Object.fromEntries(WALL_FINISHES.map((w) => [w.id, swatchUrl(wallLook(w.id).texture)])), []);
  return (
    <div className="decor-room">
      <section>
        <h4>Themes</h4>
        <div className="decor-presets">
          {THEME_PRESETS.map((p) => {
            const on = (Object.keys(p.theme) as Array<keyof typeof p.theme>).every((k) => t[k] === p.theme[k]);
            return (
              <button key={p.id} type="button" className={`decor-preset ${on ? 'active' : ''}`} onClick={() => apply(p.theme, `Theme: ${p.name}`)} title={p.blurb}>
                <span className="decor-preset-colors" aria-hidden>
                  <span style={{ background: p.theme.wallColor }} />
                  <span style={{ background: p.theme.accentColor }} />
                  <span style={{ backgroundImage: floorSwatches[p.theme.floor] ? `url(${floorSwatches[p.theme.floor]})` : undefined, backgroundColor: floorLook(p.theme.floor).color }} />
                </span>
                <strong>{p.name}</strong>
                <small>{p.blurb}</small>
              </button>
            );
          })}
        </div>
      </section>
      <section>
        <h4>Floor</h4>
        <div className="decor-materials">
          {FLOOR_MATERIALS.map((m) => (
            <button key={m.id} type="button" className={`decor-material ${t.floor === m.id ? 'active' : ''}`} onClick={() => apply({ floor: m.id }, 'Floor material')} title={m.name}>
              <span style={{ backgroundImage: floorSwatches[m.id] ? `url(${floorSwatches[m.id]})` : undefined, backgroundColor: floorLook(m.id).color } as CSSProperties} />
              <small>{m.name}</small>
            </button>
          ))}
        </div>
      </section>
      <section>
        <h4>Walls</h4>
        <div className="decor-materials">
          {WALL_FINISHES.map((w) => (
            <button key={w.id} type="button" className={`decor-material ${t.wall === w.id ? 'active' : ''}`} onClick={() => apply({ wall: w.id }, 'Wall finish')} title={w.name}>
              <span className={w.id === 'glass' ? 'glass' : ''} style={{ backgroundImage: wallSwatches[w.id] ? `url(${wallSwatches[w.id]})` : undefined, backgroundColor: w.id === 'glass' ? undefined : t.wallColor, backgroundBlendMode: 'multiply' }} />
              <small>{w.name}</small>
            </button>
          ))}
        </div>
        <div className="swatches">{WALL_COLORS.map((c) => <Swatch key={c} color={c} on={t.wallColor === c} onClick={() => apply({ wallColor: c }, 'Wall color')} />)}</div>
      </section>
      <section>
        <h4>Accent</h4>
        <div className="swatches">{COLORS.map((c) => <Swatch key={c} color={c} on={t.accentColor === c} onClick={() => apply({ accentColor: c }, 'Accent color')} />)}</div>
        <h4>Lighting</h4>
        <div className="row">
          {LIGHTING_PRESETS.map((l) => (
            <button key={l.id} type="button" className={`small ${t.lighting === l.id ? '' : 'ghost'}`} onClick={() => apply({ lighting: l.id }, `Lighting: ${l.name}`)}>{l.icon} {l.name}</button>
          ))}
        </div>
        <h4>Window view</h4>
        <div className="row">
          {WINDOW_VIEWS.map((v) => (
            <button key={v.id} type="button" className={`small ${t.view === v.id ? '' : 'ghost'}`} onClick={() => apply({ view: v.id }, 'Window view')}>{v.name}</button>
          ))}
        </div>
        <div className="row decor-toggles">
          <label className="check"><input type="checkbox" checked={t.plants} onChange={(e) => apply({ plants: e.target.checked }, 'Corner plants')} /> Corner plants</label>
          <label className="check"><input type="checkbox" checked={t.lounge} onChange={(e) => apply({ lounge: e.target.checked }, 'Lounge')} /> Lounge</label>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- desks

function DeskTab({ world, floor, staff }: { world: Snapshot; floor: Floor; staff: Agent[] }) {
  const ed = useEditor();
  const agent = ed.deskIndex != null ? staff[ed.deskIndex] : undefined;
  if (ed.deskIndex == null) return <p className="empty">Click a desk in the office to upgrade it.</p>;
  if (!agent) return <p className="empty">An empty desk. Upgrades belong to whoever works at a desk: recruit someone here first.</p>;
  const setup = world.desks.find((d) => d.agentId === agent.id);
  const style = setup?.style ?? BASIC_DESK;
  const career = world.economy?.mode === 'career';
  const change = (patch: Partial<DeskStyle>) => setDesks([{ agentId: agent.id, before: setup?.style ?? null, after: { ...style, ...patch } }], `${agent.name}'s desk`);
  const toggle = (id: DeskItem) => change({ items: style.items.includes(id) ? style.items.filter((i) => i !== id) : [...style.items, id] });
  const everyone = () => setDesks(
    staff.filter((a) => a.id !== agent.id).map((a) => ({ agentId: a.id, before: world.desks.find((d) => d.agentId === a.id)?.style ?? null, after: style })),
    `Every desk on ${floor.name}`,
  );
  return (
    <div className="decor-desk">
      <header>
        <strong>{agent.name}'s desk</strong>
        <span className="muted small-text">
          Worth {usd(deskStyleCost(style))}{career && setup ? ` · paid ${usd(setup.paid)}` : ''}{!career ? ' · free in sandbox' : ''}
        </span>
      </header>
      <section>
        <h4>Desk</h4>
        <div className="row">
          {DESK_MODELS.map((d) => <button key={d.id} type="button" className={`small ${style.desk === d.id ? '' : 'ghost'}`} onClick={() => change({ desk: d.id })}>{d.name}{d.price ? ` · ${usd(d.price)}` : ''}</button>)}
        </div>
        <h4>Chair</h4>
        <div className="row">
          {CHAIR_MODELS.map((c) => <button key={c.id} type="button" className={`small ${style.chair === c.id ? '' : 'ghost'}`} onClick={() => change({ chair: c.id })}>{c.name}{c.price ? ` · ${usd(c.price)}` : ''}</button>)}
        </div>
      </section>
      <section>
        <h4>Monitors <span className="muted small-text">· {usd(EXTRA_MONITOR_PRICE)} each extra</span></h4>
        <div className="row">
          {([1, 2, 3] as const).map((n) => <button key={n} type="button" className={`small ${style.monitors === n ? '' : 'ghost'}`} onClick={() => change({ monitors: n })}>{'🖥️'.repeat(n)}</button>)}
        </div>
        <h4>On the desk</h4>
        <div className="row">
          {DESK_ITEMS.map((i) => (
            <button key={i.id} type="button" className={`chip ${style.items.includes(i.id) ? 'on' : ''}`} onClick={() => toggle(i.id)} aria-pressed={style.items.includes(i.id)}>
              {i.icon} {i.name}{i.price ? ` · ${usd(i.price)}` : ''}
            </button>
          ))}
        </div>
      </section>
      <section className="decor-desk-actions">
        {staff.length > 1 && <button type="button" className="small ghost" onClick={everyone}>Same setup for every desk on this floor</button>}
        {setup && <button type="button" className="small ghost danger" onClick={() => setDesks([{ agentId: agent.id, before: setup.style, after: null }], 'Reset desk')}>Reset to basic{career && setup.paid ? ` (+${usd(setup.paid)})` : ''}</button>}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- panel

export function DecoratePanel({ world, floor }: { world: Snapshot; floor: Floor }) {
  const ed = useEditor();
  const staff = world.agents.filter((a) => a.floorId === floor.id && a.kind !== 'repo').sort((a, b) => a.createdAt - b.createdAt);
  const eco = world.economy;
  const placed = world.decor.filter((d) => d.floorId === floor.id).length;
  const hint = ed.hint && !ed.hint.ok ? ed.hint.reason : null;
  return (
    <>
      <div className="decor-bar" role="toolbar" aria-label="Decorate">
        <span className="decor-title">🎨 Decorate <span className="muted">· {floor.name} · {placed} item{placed === 1 ? '' : 's'}</span></span>
        <button type="button" className="icon-btn" onClick={undo} disabled={!ed.undo.length || ed.busy} title={ed.undo.length ? `Undo: ${ed.undo.at(-1)!.label} (Ctrl+Z)` : 'Undo (Ctrl+Z)'} aria-label="Undo">↶</button>
        <button type="button" className="icon-btn" onClick={redo} disabled={!ed.redo.length || ed.busy} title={ed.redo.length ? `Redo: ${ed.redo.at(-1)!.label} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'} aria-label="Redo">↷</button>
        <button type="button" className={`icon-btn ${ed.grid ? 'on' : ''}`} onClick={() => editor.set({ grid: !ed.grid })} aria-pressed={ed.grid} title="Snap to grid (G)">▦</button>
        {eco && <span className={`decor-cash ${eco.mode}`} title={eco.mode === 'career' ? 'Items cost cash; selling refunds what you paid' : 'Sandbox: decorating is free'}>{eco.mode === 'career' ? `💰 ${usd(eco.cash)}` : '🏆 Free'}</span>}
        {hint && <span className="decor-hint" role="status">⛔ {hint}</span>}
        <button type="button" className="small" onClick={() => editor.close()}>Done</button>
      </div>
      <section className="decor-drawer" aria-label="Decorate">
        <div className="tabs inline">
          <button type="button" className={ed.tab === 'items' ? 'active' : ''} onClick={() => editor.set({ tab: 'items' })}>🛋️ Items</button>
          <button type="button" className={ed.tab === 'room' ? 'active' : ''} onClick={() => editor.set({ tab: 'room', tool: { kind: 'idle' } })}>🧱 Room style</button>
          <button type="button" className={ed.tab === 'desk' ? 'active' : ''} onClick={() => editor.set({ tab: 'desk', tool: { kind: 'idle' } })}>🖥️ Desks</button>
        </div>
        {ed.tab === 'items' && <ItemsTab world={world} />}
        {ed.tab === 'room' && <RoomTab floor={floor} />}
        {ed.tab === 'desk' && <DeskTab world={world} floor={floor} staff={staff} />}
      </section>
      <ThumbnailBaker />
    </>
  );
}
