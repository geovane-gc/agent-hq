import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { Agent, AgentStatus, Building, Floor, ID, LedgerEntry, Snapshot, TaskStatus } from '@agent-hq/protocol';
import { STATUS_LABEL } from '../agentUtil.ts';
import { floorLabel, humanize, initials, toolLabel, usd } from '../format.ts';
import { NOTICE_EVENT, type HudNotice } from '../notify.ts';
import { CashBadge, openFinances } from './Finance.tsx';
import { onPlayerMail } from './MailClient.tsx';
import { UserPortrait } from './Portrait.tsx';
import { RateMeters } from './Usage.tsx';

// The heads-up display: one status card, one menu, notification cards.
// Everything else stays hidden until the player asks for it.

export const BUILDING_ICON = { web: '🌐', desktop: '🖥️', game: '🎮', custom: '🏢' } as const;

/** Statuses in the order the HUD lists them: what needs you first. */
const STATUS_ORDER: AgentStatus[] = ['awaiting_approval', 'error', 'working', 'idle', 'offline'];
const SHORT_STATUS: Record<AgentStatus, string> = { ...STATUS_LABEL, awaiting_approval: 'Waiting' };

const countBy = (agents: Agent[]) =>
  STATUS_ORDER.map((status) => ({ status, n: agents.filter((a) => a.status === status).length })).filter((c) => c.n > 0);

const summarize = (agents: Agent[]) =>
  agents.length ? countBy(agents).map((c) => `${c.n} ${STATUS_LABEL[c.status].toLowerCase()}`).join(', ') : 'No agents';

/** One dot per agent, colored by status: a floor's headcount at a glance. */
function StatusDots({ agents }: { agents: Agent[] }) {
  if (!agents.length) return <span className="muted small-text">empty</span>;
  const sorted = [...agents].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  return (
    <span className="status-dots" aria-hidden>
      {sorted.slice(0, 6).map((a) => <span key={a.id} className={`sdot status-${a.status}`} />)}
      {sorted.length > 6 && <span className="muted small-text">+{sorted.length - 6}</span>}
    </span>
  );
}

/** Online players as overlapping avatar badges. */
export function Avatars({ world }: { world: Snapshot }) {
  const online = world.users.filter((u) => u.online);
  return (
    <span className="avatars" aria-hidden>
      {online.slice(0, 3).map((u) => <span key={u.id} className="avatar" style={{ background: u.color }}>{initials(u.name)}</span>)}
      {online.length > 3 && <span className="avatar more">+{online.length - 3}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- status card

/** Top-left card: where you are, how the staff is doing, and your plan meters. */
export function StatusCard(props: {
  world: Snapshot;
  floor: Floor | undefined;
  building: Building | undefined;
  /** null in the campus view. */
  agents: Agent[];
  reconnecting: boolean;
  pickerOpen: boolean;
  onPicker: (() => void) | null;
}) {
  const { floor, building } = props;
  const counts = countBy(props.agents);
  // Repo agents live on the balcony: they don't take desks.
  const seated = props.agents.filter((a) => a.kind !== 'repo').length;
  return (
    <section className="status-card" aria-label="Status">
      <button
        className="place"
        onClick={props.onPicker ?? undefined}
        disabled={!props.onPicker}
        aria-expanded={props.onPicker ? props.pickerOpen : undefined}
        title={props.onPicker ? 'Change floor' : undefined}
      >
        {floor ? (
          <>
            <span className="level-badge large" style={{ '--building': building?.color } as CSSProperties}>{floorLabel(floor.level)}</span>
            <span className="place-text">
              <span className="eyebrow">
                {building ? `${BUILDING_ICON[building.kind]} ${building.name}` : 'Agent HQ'}
                <span title={`${seated} of ${floor.desks} desks taken`}> · {seated}/{floor.desks} desks</span>
              </span>
              <strong>{floor.name}</strong>
            </span>
            {props.onPicker && <span className="chevron" aria-hidden>{props.pickerOpen ? '▴' : '▾'}</span>}
          </>
        ) : (
          <>
            <span className="level-badge large" aria-hidden>🏙️</span>
            <span className="place-text">
              <span className="eyebrow">Agent HQ</span>
              <strong>Campus</strong>
            </span>
          </>
        )}
      </button>

      <div className="staff" title={summarize(props.agents)}>
        {counts.length === 0 && <span className="muted small-text">{floor ? 'No one works here yet' : 'No agents hired yet'}</span>}
        {counts.map((c) => (
          <span key={c.status} className={`staff-chip status-${c.status}`}>
            <span className={`sdot status-${c.status}`} /> <strong>{c.n}</strong> {SHORT_STATUS[c.status].toLowerCase()}
          </span>
        ))}
      </div>

      <CashBadge world={props.world} />
      <RateMeters limits={props.world.rateLimits} />
      {props.reconnecting && <div className="reconnecting"><span className="sdot status-error" /> Reconnecting…</div>}
    </section>
  );
}

/** Floors of every building; opens from the status card. */
export function FloorPicker(props: {
  world: Snapshot;
  floorId: ID | null;
  owner: boolean;
  onFloor: (id: ID) => void;
  onEditBuilding: (id: ID) => void;
  onNewFloor: (buildingId: ID) => void;
}) {
  const { world } = props;
  return (
    <nav className="popover floor-picker" aria-label="Floors">
      {world.buildings.map((b) => (
        <section key={b.id} className="building" style={{ '--building': b.color } as CSSProperties}>
          <header className="building-name">
            <span aria-hidden>{BUILDING_ICON[b.kind]}</span>
            <span className="name">{b.name}</span>
            {props.owner && (
              <button className="icon-btn" onClick={() => props.onEditBuilding(b.id)} aria-label={`Edit ${b.name}`} title="Edit building">✎</button>
            )}
          </header>
          {world.floors.filter((f) => f.buildingId === b.id).sort((x, y) => y.level - x.level).map((f) => {
            const agents = world.agents.filter((a) => a.floorId === f.id);
            const active = f.id === props.floorId;
            return (
              <button
                key={f.id}
                className={`floor ${active ? 'active' : ''}`}
                aria-current={active ? 'location' : undefined}
                title={`${f.name}: ${summarize(agents)}`}
                onClick={() => props.onFloor(f.id)}
              >
                <span className="level-badge">{floorLabel(f.level)}</span>
                <span className="floor-name">{f.name}</span>
                <StatusDots agents={agents} />
              </button>
            );
          })}
          {props.owner && <button className="add-row" onClick={() => props.onNewFloor(b.id)}>＋ Add floor</button>}
        </section>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------- main menu

export interface MenuItem {
  icon: string;
  label: string;
  hint?: string;
  badge?: ReactNode;
  onSelect: () => void;
}

/** The single entry point to every panel, like right-clicking the office in a tycoon game. */
export function MainMenu(props: { groups: MenuItem[][]; onClose: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, []);
  // Arrow keys walk the list (and must not also pan the camera).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return (
    <div ref={list} className="popover main-menu" role="menu" aria-label="Menu" onKeyDown={onKeyDown}>
      {props.groups.filter((g) => g.length).map((group, gi) => (
        <div key={gi} className="menu-group" role="group">
          {group.map((item) => (
            <button key={item.label} role="menuitem" className="menu-item" onClick={() => { props.onClose(); item.onSelect(); }}>
              <span className="menu-icon" aria-hidden>{item.icon}</span>
              <span className="menu-text">
                <strong>{item.label}</strong>
                {item.hint && <small>{item.hint}</small>}
              </span>
              {item.badge}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- notifications

interface Note {
  id: string;
  tone: 'waiting' | 'success' | 'error';
  icon: string;
  /** Shown instead of the icon, e.g. who sent you mail. */
  portrait?: ReactNode;
  title: string;
  text?: string;
  action?: { label: string; run: () => void };
}

function NoteCard({ note, onDismiss }: { note: Note; onDismiss: () => void }) {
  return (
    <div className={`note tone-${note.tone}`} role={note.tone === 'error' ? 'alert' : 'status'}>
      {note.portrait
        ? <span className="note-icon note-portrait" aria-hidden>{note.portrait}</span>
        : <span className={`note-icon ${note.tone === 'waiting' ? 'bounce' : ''}`} aria-hidden>{note.icon}</span>}
      <div className="note-body">
        <strong>{note.title}</strong>
        {note.text && <span title={note.text}>{note.text}</span>}
      </div>
      {note.action && <button className="small" onClick={note.action.run}>{note.action.label}</button>}
      <button className="icon-btn" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">✕</button>
    </div>
  );
}

/**
 * Approval requests (while they last), finished or failed tasks and errors,
 * stacked as small cards in the bottom-left corner.
 */
export function Notifications(props: {
  world: Snapshot;
  onOpenAgent: (id: ID) => void;
  onBoard: () => void;
  onInbox: (mailId: ID) => void;
  /** Opens a players' conversation in the mail client. */
  onMail: (threadId: ID) => void;
}) {
  const { world } = props;
  const [events, setEvents] = useState<Note[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const lastStatus = useRef<Map<ID, TaskStatus> | null>(null);
  const seenMail = useRef<Set<ID> | null>(null);

  const push = (note: Note, ttl: number) => {
    setEvents((list) => [...list.filter((n) => n.id !== note.id), note].slice(-4));
    setTimeout(() => setEvents((list) => list.filter((n) => n.id !== note.id)), ttl);
  };

  useEffect(() => {
    const on = (e: Event) => push({ id: `err-${Date.now()}-${Math.random()}`, tone: 'error', icon: '⚠️', title: 'That didn’t work', text: String((e as CustomEvent).detail) }, 8000);
    // Notices raised with notify() (notify.ts) carry their own title and icon.
    const notice = (e: Event) => {
      const n = (e as CustomEvent<HudNotice | string>).detail;
      const { ttl = 10000, ...note } = typeof n === 'string' ? { title: 'Notice', text: n } : n;
      push({ tone: 'success', icon: 'ℹ️', ...note, id: note.id ?? `notice-${Date.now()}-${Math.random()}` }, ttl);
    };
    window.addEventListener('hq-error', on);
    window.addEventListener(NOTICE_EVENT, notice);
    // Tycoon: revenue for merged work (see Finance.tsx).
    const onLedger = (e: Event) => {
      const entry = (e as CustomEvent<LedgerEntry>).detail;
      if (entry.amount <= 0 || !['revenue', 'commission', 'bonus'].includes(entry.kind)) return;
      push({ id: `ledger-${entry.id}`, tone: 'success', icon: '💰', title: `+${usd(entry.amount)} earned`, text: entry.description, action: { label: 'Finances', run: openFinances } }, 10000);
    };
    window.addEventListener('hq-ledger', onLedger);
    return () => {
      window.removeEventListener('hq-error', on);
      window.removeEventListener(NOTICE_EVENT, notice);
      window.removeEventListener('hq-ledger', onLedger);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tasks that just reached Review or Failed.
  useEffect(() => {
    const prev = lastStatus.current;
    lastStatus.current = new Map(world.tasks.map((t) => [t.id, t.status]));
    if (!prev) return;
    for (const t of world.tasks) {
      const before = prev.get(t.id);
      if (!before || before === t.status) continue;
      const assignee = world.agents.find((a) => a.id === t.assigneeId);
      // Repo agents report by mail instead (below).
      if (assignee?.kind === 'repo') continue;
      const who = assignee?.name ?? 'An agent';
      const open = { label: 'Open board', run: props.onBoard };
      if (t.status === 'review') push({ id: `task-${t.id}`, tone: 'success', icon: '✅', title: `${who} finished a task`, text: `“${t.title}” is ready for review.`, action: open }, 12000);
      if (t.status === 'failed') push({ id: `task-${t.id}`, tone: 'error', icon: '❌', title: 'A task failed', text: `“${t.title}” (${who})`, action: open }, 12000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.tasks]);

  // "You've got mail": reports from the balcony crew.
  useEffect(() => {
    const seen = seenMail.current;
    seenMail.current = new Set(world.mail.map((m) => m.id));
    if (!seen) return;
    for (const m of world.mail) {
      if (seen.has(m.id) || m.read) continue;
      const who = world.agents.find((a) => a.id === m.fromAgentId)?.name ?? 'An agent';
      push({ id: `mail-${m.id}`, tone: 'success', icon: '📧', title: `${who} sent you a report`, text: m.subject, action: { label: 'Read', run: () => props.onInbox(m.id) } }, 15000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.mail]);

  // "You've got mail" from a teammate: their portrait, the subject, and Open.
  const latest = useRef(world);
  latest.current = world;
  useEffect(() => onPlayerMail((e) => {
    const w = latest.current;
    // Everything read (here or in another tab): those cards have served their purpose.
    if (e.type === 'player_mail_changed' && e.unread === 0) setEvents((list) => list.filter((n) => !n.id.startsWith('pmail-')));
    if (e.type !== 'player_mail' || !e.mail.received || e.mail.fromUserId === w.you.id) return;
    const from = w.users.find((u) => u.id === e.mail.fromUserId);
    const id = `pmail-${e.mail.id}`;
    const open = () => {
      setEvents((list) => list.filter((n) => n.id !== id));
      props.onMail(e.mail.threadId);
    };
    push({
      id, tone: 'success', icon: '📧', portrait: <UserPortrait user={from} size={30} />,
      title: `${from?.name ?? 'A teammate'} sent you mail`, text: e.mail.subject, action: { label: 'Open', run: open },
    }, 15000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  const approvals: Note[] = world.agents
    .filter((a) => a.status === 'awaiting_approval' && a.ownerId === world.you.id)
    .map((a) => {
      const approval = world.approvals.find((x) => x.agentId === a.id);
      const floor = world.floors.find((f) => f.id === a.floorId);
      return {
        id: `approval-${a.id}-${approval?.id ?? a.activity ?? ''}`,
        tone: 'waiting',
        icon: '✋',
        title: `${a.name} needs your OK`,
        text: `${approval ? `Wants to use ${toolLabel(approval.toolName)}` : humanize(a.activity ?? 'Waiting for permission')}${floor ? ` · ${floorLabel(floor.level)} ${floor.name}` : ''}`,
        action: { label: 'Review', run: () => props.onOpenAgent(a.id) },
      };
    });

  // A mail card goes away once that report is read.
  const unreadMail = new Set(world.mail.filter((m) => !m.read).map((m) => `mail-${m.id}`));
  const visible = [...approvals.filter((n) => !dismissed.has(n.id)), ...events.filter((n) => !n.id.startsWith('mail-') || unreadMail.has(n.id))];
  if (!visible.length) return null;
  return (
    <div className="notes" aria-live="polite">
      {visible.map((n) => (
        <NoteCard
          key={n.id}
          note={n}
          onDismiss={() => n.id.startsWith('approval-')
            ? setDismissed((s) => new Set(s).add(n.id))
            : setEvents((list) => list.filter((x) => x.id !== n.id))}
        />
      ))}
    </div>
  );
}
