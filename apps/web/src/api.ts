import { useSyncExternalStore } from 'react';
import type {
  CommandName,
  Commands,
  ID,
  ServerEvent,
  ServerMessage,
  Snapshot,
  TakeoverRequest,
  TranscriptEntry,
} from '@agent-hq/protocol';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'unauthorized';

interface State {
  connection: ConnectionState;
  world: Snapshot | null;
  transcripts: Record<ID, TranscriptEntry[]>;
}

function readToken(): string | null {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    try { localStorage.setItem('agent-hq-token', fromUrl); } catch {}
    url.searchParams.delete('token');
    history.replaceState(null, '', url);
    return fromUrl;
  }
  try { return localStorage.getItem('agent-hq-token'); } catch { return null; }
}

function upsert<T extends { id: ID }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function without<T extends { id: ID }>(list: T[], id: ID): T[] {
  return list.filter((x) => x.id !== id);
}

function applyEvent(world: Snapshot, e: ServerEvent): Snapshot {
  switch (e.type) {
    case 'building': return { ...world, buildings: upsert(world.buildings, e.building) };
    case 'building_removed': return { ...world, buildings: without(world.buildings, e.id) };
    case 'floor': return { ...world, floors: upsert(world.floors, e.floor) };
    case 'floor_removed': return { ...world, floors: without(world.floors, e.id) };
    case 'project': return { ...world, projects: upsert(world.projects, e.project) };
    case 'project_removed': return { ...world, projects: without(world.projects, e.id) };
    case 'agent': return { ...world, agents: upsert(world.agents, e.agent) };
    case 'agent_removed': return { ...world, agents: without(world.agents, e.id) };
    case 'task': return { ...world, tasks: upsert(world.tasks, e.task) };
    case 'task_removed': return { ...world, tasks: without(world.tasks, e.id) };
    case 'approval': return { ...world, approvals: upsert(world.approvals, e.approval) };
    case 'approval_resolved': return { ...world, approvals: without(world.approvals, e.id) };
    case 'settings': return { ...world, settings: e.settings };
    case 'rate_limits': return e.userId === world.you.id ? { ...world, rateLimits: e.rateLimits } : world;
    case 'user': return { ...world, users: upsert(world.users, e.user), you: e.user.id === world.you.id ? e.user : world.you };
    case 'account': return { ...world, accounts: upsert(world.accounts, e.account) };
    case 'account_removed': return { ...world, accounts: without(world.accounts, e.id) };
    case 'takeover': return { ...world, takeovers: e.takeover.status === 'pending' ? upsert(world.takeovers, e.takeover) : without(world.takeovers, e.takeover.id) };
    case 'takeover_removed': return { ...world, takeovers: without(world.takeovers, e.id) };
    case 'presence': return { ...world, presence: [...world.presence.filter((p) => p.userId !== e.presence.userId), e.presence] };
    case 'presence_left': return { ...world, presence: world.presence.filter((p) => p.userId !== e.userId) };
    case 'mail': return { ...world, mail: upsert(world.mail, e.mail).sort((a, b) => b.createdAt - a.createdAt) };
    default: return world;
  }
}

class Client {
  private state: State = { connection: 'connecting', world: null, transcripts: {} };
  private readonly listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private retry = 500;
  readonly token = readToken();
  /** Raw boss-terminal output, for the xterm view. */
  readonly terminal = new EventTarget();
  /** Raw agent-terminal output; the event type is the agent id. */
  readonly agentTerminals = new EventTarget();
  /** Output of your Claude login terminals; the event type is the account id. */
  readonly accountLogins = new EventTarget();
  /** Everything a login terminal printed, so reopening it shows the whole flow. */
  readonly loginHistory = new Map<ID, string>();

  constructor() {
    this.connect();
  }

  get = () => this.state;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private connect() {
    if (!this.token) {
      this.set({ connection: 'unauthorized' });
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;
    this.set({ connection: this.state.world ? 'closed' : 'connecting' });
    ws.onopen = () => { this.retry = 500; };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(String(ev.data)) as ServerMessage);
    ws.onclose = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error('Disconnected'));
      this.pending.clear();
      if (ev.code === 4001) {
        try { localStorage.removeItem('agent-hq-token'); } catch {}
        this.set({ connection: 'unauthorized' });
        return;
      }
      this.set({ connection: this.state.world ? 'closed' : 'connecting' });
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 10000);
    };
  }

  private onMessage(msg: ServerMessage) {
    if (msg.type === 'snapshot') {
      // Transcripts may have moved on while disconnected; refetch lazily.
      this.set({ connection: 'open', world: msg.snapshot, transcripts: {} });
    } else if (msg.type === 'event') {
      const e = msg.event;
      if (e.type === 'transcript') {
        const list = this.state.transcripts[e.entry.agentId];
        if (list) this.set({ transcripts: { ...this.state.transcripts, [e.entry.agentId]: [...list, e.entry] } });
      } else if (e.type === 'terminal_output') {
        this.terminal.dispatchEvent(new CustomEvent('data', { detail: e.data }));
      } else if (e.type === 'agent_terminal_output') {
        this.agentTerminals.dispatchEvent(new CustomEvent(e.agentId, { detail: e.data }));
      } else if (e.type === 'account_login_output') {
        this.loginHistory.set(e.accountId, ((this.loginHistory.get(e.accountId) ?? '') + e.data).slice(-200_000));
        this.accountLogins.dispatchEvent(new CustomEvent(e.accountId, { detail: e.data }));
      } else if (e.type === 'terminal_exit') {
        this.terminal.dispatchEvent(new CustomEvent('exit', { detail: e.code }));
      } else if (this.state.world) {
        if (e.type === 'takeover') this.noticeTakeover(this.state.world, e.takeover);
        this.set({ world: applyEvent(this.state.world, e) });
      }
    } else if (msg.type === 'reply') {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.ok) p?.resolve(msg.result);
      else p?.reject(new Error(msg.error));
    }
  }

  /** Tells the requester how their takeover request ended. */
  private noticeTakeover(world: Snapshot, t: TakeoverRequest) {
    if (t.requesterId !== world.you.id || t.status === 'pending' || t.status === 'cancelled') return;
    const agent = world.agents.find((a) => a.id === t.agentId)?.name ?? 'the agent';
    const owner = world.users.find((u) => u.id === t.ownerId)?.name ?? 'Its owner';
    const text = t.status === 'approved' ? `${owner} approved: ${agent} now works on your account.` : `${owner} declined your request to take over ${agent}.`;
    window.dispatchEvent(new CustomEvent(t.status === 'approved' ? 'hq-notice' : 'hq-error', { detail: text }));
  }

  request<K extends CommandName>(command: K, args: Commands[K]['args']): Promise<Commands[K]['result']> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ type: 'request', id, command, args }));
    });
  }

  /** Deleting mail has no event (only you see your inbox): drop it locally once the server agreed. */
  async deleteMail(id: ID) {
    await this.request('delete_mail', { id });
    if (this.state.world) this.set({ world: { ...this.state.world, mail: without(this.state.world.mail, id) } });
  }

  async loadTranscript(agentId: ID) {
    const entries = await this.request('get_transcript', { agentId, limit: 500 });
    this.set({ transcripts: { ...this.state.transcripts, [agentId]: entries } });
  }
}

export const client = new Client();

export function useClient(): State {
  return useSyncExternalStore(client.subscribe, client.get);
}

/** Runs a request and surfaces failures as a toast. */
export async function run<K extends CommandName>(command: K, args: Commands[K]['args']) {
  try {
    return await client.request(command, args);
  } catch (err) {
    window.dispatchEvent(new CustomEvent('hq-error', { detail: (err as Error).message }));
    throw err;
  }
}
