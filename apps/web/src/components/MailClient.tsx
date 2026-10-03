import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { ID, Mail, PlayerMail, PlayerMailEvent, PlayerMailFolder, PlayerMailThread, Snapshot, User } from '@agent-hq/protocol';
import { client, run } from '../api.ts';
import { ago, stamp } from '../format.ts';
import { MailView, Markdown } from './Inbox.tsx';
import { Modal } from './Modal.tsx';
import { AgentPortrait, UserPortrait } from './Portrait.tsx';
import { BossTerminal } from './Terminal.tsx';
import './mail.css';

// The office mail client, on every computer: players' conversations (stored on
// the host, private to their participants, fetched page by page) and the
// balcony crew's reports, in one Gmail-like window.

export type MailFolder = PlayerMailFolder | 'reports';

/** What to show when the mail client opens. */
export interface MailTarget {
  threadId?: ID;
  /** An agent report. */
  reportId?: ID;
  compose?: { to?: ID[] };
}

interface Draft {
  to: ID[];
  subject: string;
  body: string;
  inReplyTo: ID | null;
}

type View = { kind: 'thread'; threadId: ID } | { kind: 'report'; id: ID } | { kind: 'compose'; draft: Draft } | null;

type Row = { kind: 'thread'; at: number; thread: PlayerMailThread } | { kind: 'report'; at: number; mail: Mail };

const PAGE = 30;

/** Unread player mail plus unread agent reports: the badge on the menu and the boss computer. */
export const mailUnread = (world: Snapshot) => world.playerMail.unread + world.mail.filter((m) => !m.read).length;

/** Subscribes to player-mail events (see api.ts). */
export function onPlayerMail(fn: (e: PlayerMailEvent) => void) {
  const handler = (ev: Event) => fn((ev as CustomEvent<PlayerMailEvent>).detail);
  window.addEventListener('hq-player-mail', handler);
  return () => window.removeEventListener('hq-player-mail', handler);
}

const userById = (world: Snapshot, id: ID) => world.users.find((u) => u.id === id);
const nameOf = (world: Snapshot, id: ID) => (id === world.you.id ? 'me' : userById(world, id)?.name ?? 'Former player');
const names = (world: Snapshot, ids: ID[]) => ids.map((id) => nameOf(world, id)).join(', ');
const snippet = (text: string) => text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`_>~[\]()-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
const quote = (m: PlayerMail, world: Snapshot) =>
  `\n\n---\nOn ${stamp(m.createdAt)}, ${nameOf(world, m.fromUserId)} wrote:\n\n${m.body.split('\n').map((l) => `> ${l}`).join('\n')}`;

/** The players' conversations of a folder, page by page, refreshed when mail comes and goes. */
function useThreads(folder: PlayerMailFolder | null, query: string) {
  const [state, setState] = useState<{ threads: PlayerMailThread[]; more: boolean; loading: boolean; error: string | null }>(
    { threads: [], more: false, loading: !!folder, error: null },
  );
  const current = useRef(state);
  current.current = state;
  const generation = useRef(0);

  const load = useCallback(async (mode: 'reset' | 'more' | 'refresh') => {
    const g = ++generation.current;
    if (!folder) {
      setState({ threads: [], more: false, loading: false, error: null });
      return;
    }
    const { threads } = current.current;
    const before = mode === 'more' ? threads[threads.length - 1]?.latest.createdAt ?? null : null;
    // A refresh reloads as many conversations as are on screen.
    const limit = mode === 'refresh' ? Math.min(100, Math.max(PAGE, threads.length)) : PAGE;
    setState((s) => ({ ...s, loading: true, ...(mode === 'reset' ? { threads: [], more: false, error: null } : {}) }));
    try {
      const res = await client.request('list_player_mail', { folder, query, before, limit });
      if (g !== generation.current) return;
      setState((s) => ({ threads: mode === 'more' ? [...s.threads, ...res.threads] : res.threads, more: res.more, loading: false, error: null }));
    } catch (err) {
      if (g === generation.current) setState((s) => ({ ...s, loading: false, error: (err as Error).message }));
    }
  }, [folder, query]);

  useEffect(() => { load('reset'); }, [load]);
  useEffect(() => onPlayerMail(() => { load('refresh'); }), [load]);
  return { ...state, loadMore: () => load('more') };
}

// ---------------------------------------------------------------- recipients

/** "To" field: chips with portraits, and an autocomplete of this office's players. */
function RecipientInput(props: { world: Snapshot; value: ID[]; onChange: (ids: ID[]) => void; autoFocus?: boolean }) {
  const { world, value } = props;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const players = world.users.filter((u) => u.id !== world.you.id);
  const q = text.trim().toLowerCase();
  const options = players.filter((u) => !value.includes(u.id) && (!q || u.name.toLowerCase().includes(q))).slice(0, 8);

  const add = (u: User) => {
    props.onChange([...value, u.id]);
    setText('');
    setActive(0);
    input.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + Math.max(options.length, 1)) % Math.max(options.length, 1));
    } else if ((e.key === 'Enter' || e.key === 'Tab' || e.key === ',') && open && options[active] && (q || e.key === 'Enter')) {
      e.preventDefault();
      add(options[active]);
    } else if (e.key === 'Backspace' && !text && value.length) {
      props.onChange(value.slice(0, -1));
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="pm-to" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); } }}>
      <span className="pm-label">To</span>
      {value.map((id) => (
        <span key={id} className="pm-chip">
          <UserPortrait user={userById(world, id)} size={20} />
          {nameOf(world, id)}
          <button type="button" className="pm-chip-x" aria-label={`Remove ${nameOf(world, id)}`} onClick={() => props.onChange(value.filter((x) => x !== id))}>✕</button>
        </span>
      ))}
      <input
        ref={input}
        value={text}
        autoFocus={props.autoFocus}
        placeholder={value.length ? '' : players.length ? 'Type a teammate’s name' : 'No other players in this office yet'}
        aria-label="Recipients"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls="pm-to-options"
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {open && options.length > 0 && (
        <ul className="pm-suggest" id="pm-to-options" role="listbox">
          {options.map((u, i) => (
            <li key={u.id} role="option" aria-selected={i === active}>
              <button type="button" className={i === active ? 'active' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => add(u)} onMouseEnter={() => setActive(i)}>
                <UserPortrait user={u} size={28} />
                <span className="pm-suggest-name">
                  <strong>{u.name}</strong>
                  <small>{u.role === 'owner' ? 'Boss' : 'Manager'}{u.online ? ' · in the office' : ''}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- composer

/** A new message, or a reply (inline under a conversation: `compact` hides the subject). */
function Composer(props: {
  world: Snapshot;
  draft: Draft;
  compact?: boolean;
  onSent: (mail: PlayerMail) => void;
  onDiscard: () => void;
}) {
  const [draft, setDraft] = useState(props.draft);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (props.compact || props.draft.to.length) body.current?.focus(); }, [props.compact, props.draft.to.length]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const mail = await client.request('send_player_mail', { to: draft.to, subject: draft.subject, body: draft.body, inReplyTo: draft.inReplyTo });
      props.onSent(mail);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`pm-compose ${props.compact ? 'compact' : ''}`} onSubmit={send}>
      {!props.compact && <h3 className="pm-compose-title">{draft.inReplyTo ? 'Reply' : 'New message'}</h3>}
      <RecipientInput world={props.world} value={draft.to} onChange={(to) => setDraft({ ...draft, to })} autoFocus={!props.compact && !draft.to.length} />
      {!props.compact && (
        <label className="pm-subject">
          <span className="pm-label">Subject</span>
          <input value={draft.subject} maxLength={200} placeholder="What is it about?" onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
        </label>
      )}
      {preview
        ? <div className="pm-preview">{draft.body.trim() ? <Markdown text={draft.body} /> : <p className="muted">Nothing to preview yet.</p>}</div>
        : (
          <textarea
            ref={body}
            className="pm-body"
            rows={props.compact ? 4 : 10}
            value={draft.body}
            maxLength={20000}
            placeholder={props.compact ? 'Write a reply…' : 'Write your message…'}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
          />
        )}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <span className="muted small-text">**bold**, *italic*, `code`, - lists · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> sends</span>
        <span className="spacer" />
        <button type="button" className="ghost small" onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>
        <button type="button" className="ghost small" onClick={props.onDiscard}>Discard</button>
        <button type="submit" disabled={busy || !draft.to.length || !draft.body.trim()}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- a conversation

function ThreadView(props: {
  world: Snapshot;
  threadId: ID;
  onClose: () => void;
  onCompose: (draft: Draft) => void;
}) {
  const { world, threadId } = props;
  const [messages, setMessages] = useState<PlayerMail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<Draft | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    client.request('get_player_thread', { threadId }).then((list) => { setMessages(list); setError(null); }, (err) => setError((err as Error).message));
  }, [threadId]);
  useEffect(() => { setMessages(null); setReply(null); load(); }, [load]);
  useEffect(() => onPlayerMail((e) => { if (e.type === 'player_mail' && e.mail.threadId === threadId) load(); }), [load, threadId]);
  // Opening a conversation reads it.
  useEffect(() => {
    if (!messages?.some((m) => m.received && !m.read)) return;
    client.request('update_player_mail', { threadId, read: true })
      .then(() => setMessages((list) => list && list.map((m) => ({ ...m, read: true }))))
      .catch(() => {});
  }, [messages, threadId]);
  useEffect(() => { if (reply) bottom.current?.scrollIntoView({ block: 'nearest' }); }, [reply]);

  if (error) return <div className="pm-pane"><p className="muted mail-empty">{error}</p></div>;
  if (!messages) return <div className="pm-pane"><p className="muted mail-empty">Loading…</p></div>;
  const last = messages[messages.length - 1];
  const archived = messages.every((m) => m.archived);
  const me = world.you.id;
  const replyTo = (all: boolean): ID[] => {
    const everyone = [...new Set([last.fromUserId, ...last.toUserIds])].filter((id) => id !== me);
    if (all) return everyone.length ? everyone : [me];
    return last.fromUserId === me ? last.toUserIds : [last.fromUserId];
  };
  const act = (args: { read?: boolean; archived?: boolean }, after?: () => void) =>
    run('update_player_mail', { threadId, ...args }).then(() => after?.(), () => {});
  const remove = (id?: ID) => run('delete_player_mail', { threadId, id: id ?? null }).then(() => {
    if (!id || messages.length === 1) props.onClose();
    else load();
  }, () => {});

  return (
    <div className="pm-pane">
      <header className="pm-thread-head">
        <button className="ghost small pm-back" onClick={props.onClose} aria-label="Back to the list">←</button>
        <h3 className="mail-subject">{messages[0].subject}</h3>
        <span className="spacer" />
        <div className="pm-tools" role="toolbar" aria-label="Conversation">
          <button className="ghost small" onClick={() => setReply({ to: replyTo(false), subject: '', body: '', inReplyTo: last.id })}>↩ Reply</button>
          <button className="ghost small" onClick={() => setReply({ to: replyTo(true), subject: '', body: '', inReplyTo: last.id })}>↩↩ Reply all</button>
          <button className="ghost small" onClick={() => props.onCompose({ to: [], subject: `Fwd: ${messages[0].subject.replace(/^(re|fwd):\s*/i, '')}`, body: quote(last, world), inReplyTo: null })}>↪ Forward</button>
          <button className="ghost small" onClick={() => act({ archived: !archived }, props.onClose)} title={archived ? 'Back to the inbox' : 'Out of the inbox, kept in Archive'}>{archived ? '📥 Move to inbox' : '🗄️ Archive'}</button>
          <button className="ghost small" onClick={() => act({ read: false }, props.onClose)}>Mark unread</button>
          <button className="ghost danger small" onClick={() => remove()} title="Deletes it from your mailbox only">Delete</button>
        </div>
      </header>
      <div className="pm-messages">
        {messages.map((m) => (
          <article key={m.id} className="pm-message">
            <UserPortrait user={userById(world, m.fromUserId)} size={40} />
            <div className="pm-message-main">
              <header>
                <strong>{m.fromUserId === me ? 'Me' : nameOf(world, m.fromUserId)}</strong>
                <span className="muted small-text pm-recipients">to {names(world, m.toUserIds)}</span>
                <span className="spacer" />
                <time className="muted small-text" dateTime={new Date(m.createdAt).toISOString()} title={stamp(m.createdAt)}>{stamp(m.createdAt)} ({ago(m.createdAt)})</time>
                {messages.length > 1 && <button className="icon-btn danger" onClick={() => remove(m.id)} aria-label="Delete this message" title="Delete this message (your copy)">🗑</button>}
              </header>
              <Markdown text={m.body} />
            </div>
          </article>
        ))}
        {reply
          ? <Composer key={reply.inReplyTo + reply.to.join()} world={world} draft={reply} compact onSent={() => { setReply(null); load(); }} onDiscard={() => setReply(null)} />
          : <button className="ghost pm-reply-btn" onClick={() => setReply({ to: replyTo(false), subject: '', body: '', inReplyTo: last.id })}>↩ Reply to {last.fromUserId === me ? names(world, last.toUserIds) : nameOf(world, last.fromUserId)}…</button>}
        <div ref={bottom} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the client

const FOLDERS: Array<{ id: MailFolder; icon: string; label: string }> = [
  { id: 'inbox', icon: '📥', label: 'Inbox' },
  { id: 'reports', icon: '🤖', label: 'Agent reports' },
  { id: 'sent', icon: '📤', label: 'Sent' },
  { id: 'archive', icon: '🗄️', label: 'Archive' },
];

const EMPTY: Record<MailFolder, string> = {
  inbox: 'Your inbox is empty. Write to a teammate with Compose; reports from the balcony crew land here too.',
  reports: 'No reports yet. Summon one of the repo agents smoking on the balcony: when they finish, their report lands here, and you can reply to keep the conversation going.',
  sent: 'Nothing sent yet.',
  archive: 'Archived conversations leave the inbox and wait here.',
};

export function MailClient(props: { world: Snapshot; initial?: MailTarget; onOpenAgent: (id: ID) => void }) {
  const { world, initial } = props;
  const [folder, setFolder] = useState<MailFolder>('inbox');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>(() =>
    initial?.compose ? { kind: 'compose', draft: { to: initial.compose.to ?? [], subject: '', body: '', inReplyTo: null } }
      : initial?.threadId ? { kind: 'thread', threadId: initial.threadId }
        : initial?.reportId ? { kind: 'report', id: initial.reportId }
          : null);
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useThreads(folder === 'reports' ? null : folder, query);
  const reports = useMemo(() => {
    if (folder !== 'inbox' && folder !== 'reports') return [];
    const q = query.toLowerCase();
    const agentName = (m: Mail) => world.agents.find((a) => a.id === m.fromAgentId)?.name ?? '';
    return world.mail.filter((m) => !q || m.subject.toLowerCase().includes(q) || m.body.toLowerCase().includes(q) || agentName(m).toLowerCase().includes(q));
  }, [world.mail, world.agents, folder, query]);

  const rows: Row[] = useMemo(() => {
    const threads: Row[] = list.threads.map((t) => ({ kind: 'thread', at: t.latest.createdAt, thread: t }));
    // Reports older than the conversations loaded so far wait for "Load more".
    const oldest = list.more && list.threads.length ? list.threads[list.threads.length - 1].latest.createdAt : -Infinity;
    const shown: Row[] = reports.filter((m) => m.createdAt >= oldest).map((m) => ({ kind: 'report', at: m.createdAt, mail: m }));
    return [...threads, ...shown].sort((a, b) => b.at - a.at);
  }, [list.threads, list.more, reports]);

  const reportsUnread = world.mail.filter((m) => !m.read).length;
  const counts: Partial<Record<MailFolder, number>> = { inbox: world.playerMail.unread + reportsUnread, reports: reportsUnread };
  const selectedThread = view?.kind === 'thread' ? view.threadId : null;
  const selectedReport = view?.kind === 'report' ? view.id : null;
  const report = selectedReport ? world.mail.find((m) => m.id === selectedReport) : undefined;

  const pickFolder = (f: MailFolder) => {
    setFolder(f);
    if (view?.kind !== 'compose') setView(null);
  };
  const compose = (draft?: Partial<Draft>) => setView({ kind: 'compose', draft: { to: [], subject: '', body: '', inReplyTo: null, ...draft } });

  let pane: ReactNode;
  if (view?.kind === 'compose') {
    pane = (
      <div className="pm-pane">
        <Composer
          key={JSON.stringify(view.draft)}
          world={world}
          draft={view.draft}
          onSent={(mail) => { setFolder('sent'); setView({ kind: 'thread', threadId: mail.threadId }); }}
          onDiscard={() => setView(null)}
        />
      </div>
    );
  } else if (view?.kind === 'thread') {
    pane = <ThreadView world={world} threadId={view.threadId} onClose={() => setView(null)} onCompose={compose} />;
  } else if (report) {
    pane = (
      <div className="pm-pane">
        <button className="ghost small pm-back" onClick={() => setView(null)} aria-label="Back to the list">←</button>
        <MailView key={report.id} world={world} mail={report} onOpenAgent={props.onOpenAgent} onDeleted={() => setView(null)} />
      </div>
    );
  } else {
    pane = <div className="pm-pane"><p className="muted mail-empty">{rows.length ? 'Pick a conversation.' : ''}</p></div>;
  }

  return (
    <div className={`mail-client ${view ? 'reading' : ''}`}>
      <nav className="pm-folders" aria-label="Mail folders">
        <button className="pm-compose-btn" onClick={() => compose()}>✏️ Compose</button>
        {FOLDERS.map((f) => (
          <button key={f.id} className={`pm-folder ${folder === f.id ? 'active' : ''}`} aria-current={folder === f.id ? 'page' : undefined} onClick={() => pickFolder(f.id)}>
            <span aria-hidden>{f.icon}</span>
            <span className="pm-folder-name">{f.label}</span>
            {counts[f.id] ? <span className="count-badge">{counts[f.id]}</span> : null}
          </button>
        ))}
      </nav>

      <section className="pm-list" aria-label={FOLDERS.find((f) => f.id === folder)?.label}>
        <input className="pm-search" type="search" value={search} placeholder="Search mail" aria-label="Search mail" onChange={(e) => setSearch(e.target.value)} />
        <ul className="mail-list">
          {rows.map((r) => (r.kind === 'thread'
            ? <ThreadRow key={r.thread.threadId} world={world} thread={r.thread} folder={folder} active={r.thread.threadId === selectedThread} onOpen={() => setView({ kind: 'thread', threadId: r.thread.threadId })} />
            : <ReportRow key={r.mail.id} world={world} mail={r.mail} active={r.mail.id === selectedReport} onOpen={() => setView({ kind: 'report', id: r.mail.id })} />))}
        </ul>
        {list.error && <p className="error small-text">{list.error}</p>}
        {!rows.length && !list.loading && <p className="muted mail-empty">{query ? `Nothing matches “${query}”.` : EMPTY[folder]}</p>}
        {list.loading && !rows.length && <p className="muted mail-empty">Loading…</p>}
        {list.more && <button className="ghost small pm-more" disabled={list.loading} onClick={list.loadMore}>{list.loading ? 'Loading…' : 'Load more'}</button>}
      </section>

      {pane}
    </div>
  );
}

function ThreadRow(props: { world: Snapshot; thread: PlayerMailThread; folder: MailFolder; active: boolean; onOpen: () => void }) {
  const { world, thread } = props;
  const me = world.you.id;
  const { latest } = thread;
  const others = thread.participantIds.filter((id) => id !== me);
  // Whose face the row shows: who wrote last (unless that's you), otherwise who you wrote to.
  const face = props.folder === 'sent'
    ? latest.toUserIds.find((id) => id !== me) ?? me
    : latest.fromUserId !== me ? latest.fromUserId : others[0] ?? me;
  const who = props.folder === 'sent' ? `To: ${names(world, latest.toUserIds)}` : others.length ? names(world, others) : 'me';
  const unread = thread.unread > 0;
  return (
    <li>
      <button className={`mail-row ${props.active ? 'active' : ''} ${unread ? 'unread' : ''}`} onClick={props.onOpen}>
        <UserPortrait user={userById(world, face)} size={36} />
        <span className="mail-row-main">
          <span className="mail-row-top">
            <span className="mail-row-who">{who}</span>
            {thread.count > 1 && <span className="mail-row-count">{thread.count}</span>}
            <time className="muted small-text" title={stamp(latest.createdAt)}>{ago(latest.createdAt)}</time>
          </span>
          <span className="mail-row-subject">{unread && <span className="dot unread-dot" />}{thread.subject}</span>
          <span className="muted small-text mail-snippet">{latest.fromUserId === me ? 'You: ' : ''}{thread.snippet}</span>
        </span>
      </button>
    </li>
  );
}

function ReportRow(props: { world: Snapshot; mail: Mail; active: boolean; onOpen: () => void }) {
  const { world, mail } = props;
  const agent = world.agents.find((a) => a.id === mail.fromAgentId);
  return (
    <li>
      <button className={`mail-row report ${props.active ? 'active' : ''} ${mail.read ? '' : 'unread'}`} onClick={props.onOpen}>
        <AgentPortrait agent={agent} size={36} />
        <span className="mail-row-main">
          <span className="mail-row-top">
            <span className="mail-row-who">{agent?.name ?? 'Former agent'}</span>
            <span className="tag-report">Agent report</span>
            <time className="muted small-text" title={stamp(mail.createdAt)}>{ago(mail.createdAt)}</time>
          </span>
          <span className="mail-row-subject">{!mail.read && <span className="dot unread-dot" />}{mail.subject}</span>
          <span className="muted small-text mail-snippet">{snippet(mail.body)}</span>
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------- the computers

/**
 * An office computer: everyone's own mail, and on the boss computer the
 * owner's terminal. `via` says which computer (or the menu) opened it.
 */
export function BossComputer(props: {
  world: Snapshot;
  initial?: MailTarget;
  initialTab?: 'inbox' | 'terminal';
  via?: 'boss' | 'desk' | 'menu';
  onClose: () => void;
  onOpenAgent: (id: ID) => void;
}) {
  const boss = (props.via ?? 'boss') === 'boss';
  const terminal = boss && props.world.terminalAvailable;
  const [tab, setTab] = useState<'inbox' | 'terminal'>(props.initialTab === 'terminal' && props.world.terminalAvailable ? 'terminal' : 'inbox');
  const unread = mailUnread(props.world);
  const subtitle = tab === 'inbox' ? 'Write to your teammates, and read the balcony crew’s reports. Only you can see your mail.' : 'Your private shell on the host';
  return (
    <Modal title={boss ? '👑 Boss computer' : '📧 Mail'} subtitle={subtitle} onClose={props.onClose} wide>
      {(terminal || tab === 'terminal') && (
        <div className="tabs inline">
          <button className={tab === 'inbox' ? 'active' : ''} onClick={() => setTab('inbox')}>📧 Mail{unread ? ` (${unread})` : ''}</button>
          {props.world.terminalAvailable && <button className={tab === 'terminal' ? 'active' : ''} onClick={() => setTab('terminal')}>⌨️ Terminal</button>}
        </div>
      )}
      {tab === 'inbox'
        ? <MailClient world={props.world} initial={props.initial} onOpenAgent={(id) => { props.onClose(); props.onOpenAgent(id); }} />
        : <BossTerminal embedded onClose={props.onClose} />}
    </Modal>
  );
}
