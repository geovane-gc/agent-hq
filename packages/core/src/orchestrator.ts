import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  Agent,
  Appearance,
  Approval,
  CommandName,
  Commands,
  HostToRunner,
  ID,
  Presence,
  RunnerSessionEvent,
  Snapshot,
  Task,
  TranscriptEntry,
  User,
} from '@agent-hq/protocol';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { hasCommits, initRepo, originUrl } from './git.ts';
import { taskPrompt } from './memory.ts';
import { RemoteRunner } from './runner/remote.ts';
import type { Runner, RunnerSession } from './runner/runner.ts';
import { DEFAULT_THEME, PALETTE, type Store } from './store.ts';
import type { BossTerminal } from './terminal.ts';

/** Who is issuing a command: a player, or an agent through the HQ MCP tools. */
export type Actor =
  | { kind: 'user'; user: User }
  | { kind: 'agent'; agentId: ID; manager: boolean };

interface LiveSession {
  session: RunnerSession;
  /** null for a free conversation outside any task. */
  taskId: ID | null;
  closing: boolean;
  /** Token the agent's HQ MCP server uses to reach us. */
  token: string;
  /** Distinguishes this session's events from a replaced session's stragglers. */
  key: string;
  /** Whether the session is a real terminal; null until the runner says. */
  interactive: boolean | null;
  /** Recent terminal output, replayed to whoever opens the agent's computer. */
  buffer: string;
}

/** How much terminal output to keep per agent for late viewers. */
const TERMINAL_HISTORY = 400_000;

interface PendingApproval {
  approval: Approval;
  requestId: string;
}

const XP_PER_TURN = 10;
const SKINS = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a0662f'];
const HAIRS = ['#2c1b10', '#3b2a1a', '#6a4e2e', '#b8860b', '#1c1c1c', '#a33b20', '#d8d8d8'];
const HAIR_STYLES: Appearance['hairStyle'][] = ['short', 'long', 'bun', 'bald'];

const OWNER_ONLY = new Set<CommandName>([
  'create_building', 'update_building', 'remove_building', 'create_floor', 'update_floor', 'remove_floor',
  'create_project', 'remove_project', 'update_settings', 'create_invite', 'list_invites', 'revoke_invite',
  'remove_member', 'terminal_open', 'terminal_input', 'terminal_resize',
]);
const MANAGER_COMMANDS = new Set<CommandName>(['create_task', 'assign_task']);

const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
const randomAppearance = (shirt: string): Appearance => ({ skin: pick(SKINS), hair: pick(HAIRS), shirt, hairStyle: pick(HAIR_STYLES) });

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

/**
 * The brain of Agent HQ: hires agents, routes tasks to them, runs their
 * sessions through runners and turns session events into world state.
 */
export class Orchestrator {
  private readonly store: Store;
  private readonly db: Db;
  private readonly config: Config;
  private readonly terminal: BossTerminal;
  private localRunner: Runner | null = null;
  private readonly remoteRunners = new Map<ID, RemoteRunner>();
  private readonly sessions = new Map<ID, LiveSession>();
  private readonly approvals = new Map<ID, PendingApproval>();
  private readonly agentTokens = new Map<string, ID>();
  private readonly presence = new Map<ID, Presence>();
  private readonly connections = new Map<ID, number>();
  /** Agents whose session is being prepared. */
  private readonly starting = new Set<ID>();
  /** How many clients have each agent's terminal open. */
  private readonly watchers = new Map<ID, number>();
  /** Agent terminal output, for the server to relay to viewers. */
  readonly terminals = new EventEmitter<{ data: [ID, string] }>();

  constructor(store: Store, db: Db, config: Config, terminal: BossTerminal) {
    this.store = store;
    this.db = db;
    this.config = config;
    this.terminal = terminal;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Creates the owner on first run; returns them. */
  ensureOwner(): User {
    const existing = this.store.all('user').find((u) => u.role === 'owner');
    if (existing) return existing;
    return this.store.put('user', {
      id: randomUUID(), name: 'Boss', role: 'owner', color: PALETTE[0], online: false, runnerOnline: true, appearance: randomAppearance('#1f2a44'),
    });
  }

  boot(localRunner: Runner) {
    this.localRunner = localRunner;
    const owner = this.owner();
    this.store.touch('user', owner.id, { runnerOnline: true });
    if (this.store.all('building').length === 0) {
      const building = this.store.put('building', { id: randomUUID(), name: 'Web Studio', kind: 'web', color: PALETTE[0], createdAt: Date.now() });
      this.store.put('floor', {
        id: randomUUID(), buildingId: building.id, name: 'Ground floor', level: 0, desks: 6, theme: DEFAULT_THEME, createdAt: Date.now(),
      });
    }
    // Agents hired before multiplayer existed belong to the owner.
    for (const agent of this.store.all('agent')) {
      if (!agent.ownerId || !this.store.get('user', agent.ownerId)) this.store.patch('agent', agent.id, { ownerId: owner.id });
    }
    // Sessions don't survive a restart. Agents come back idle (or offline if
    // their owner's runner isn't connected); unfinished tasks keep their
    // session id so a message resumes the conversation.
    for (const agent of this.store.all('agent')) {
      const status = agent.ownerId === owner.id ? 'idle' : 'offline';
      if (agent.status !== status || agent.activity || agent.live) {
        this.store.patch('agent', agent.id, { status, activity: null, live: false });
        const task = agent.currentTaskId ? this.store.get('task', agent.currentTaskId) : undefined;
        if (task?.status === 'in_progress') {
          this.log(agent.id, task.id, 'system', 'Agent HQ restarted while this task was running. Send a message to resume.');
        }
      }
    }
    this.dispatch();
  }

  shutdown(): Promise<void> {
    this.terminal.dispose();
    return Promise.all([...this.sessions.keys()].map((id) => this.endSession(id))).then(() => {});
  }

  owner(): User {
    return this.store.all('user').find((u) => u.role === 'owner')!;
  }

  // ------------------------------------------------------------------ auth & connections

  /** Resolves a connection token: the owner's, an invite (member), or a live agent's MCP token. */
  authenticate(token: string): Actor | null {
    const agentId = this.agentTokens.get(token);
    if (agentId) {
      const agent = this.store.get('agent', agentId);
      return agent ? { kind: 'agent', agentId, manager: agent.isManager } : null;
    }
    if (token === this.config.ownerToken) return { kind: 'user', user: this.owner() };
    const invite = this.store.all('invite').find((i) => i.token === token);
    if (!invite) return null;
    if (invite.usedBy) {
      const user = this.store.get('user', invite.usedBy);
      return user ? { kind: 'user', user } : null;
    }
    const used = new Set(this.store.all('user').map((u) => u.color));
    const color = PALETTE.find((c) => !used.has(c)) ?? pick(PALETTE);
    const user = this.store.put('user', {
      id: randomUUID(), name: invite.name, role: 'member', color, online: false, runnerOnline: false, appearance: randomAppearance(color),
    });
    this.store.patch('invite', invite.id, { usedBy: user.id });
    return { kind: 'user', user };
  }

  connected(userId: ID) {
    const n = (this.connections.get(userId) ?? 0) + 1;
    this.connections.set(userId, n);
    if (n === 1) this.store.touch('user', userId, { online: true });
  }

  disconnected(userId: ID) {
    const n = (this.connections.get(userId) ?? 1) - 1;
    this.connections.set(userId, n);
    if (n > 0 || !this.store.get('user', userId)) return;
    this.store.touch('user', userId, { online: false });
    if (this.presence.delete(userId)) this.store.broadcast({ type: 'presence_left', userId });
  }

  attachRunner(userId: ID, send: (msg: HostToRunner) => void): RemoteRunner {
    this.remoteRunners.get(userId)?.disconnect();
    const runner = new RemoteRunner(userId, send);
    this.remoteRunners.set(userId, runner);
    this.store.touch('user', userId, { runnerOnline: true });
    for (const a of this.store.all('agent')) {
      if (a.ownerId === userId && a.status === 'offline') this.store.patch('agent', a.id, { status: 'idle' });
    }
    this.dispatch();
    return runner;
  }

  detachRunner(userId: ID, runner: RemoteRunner) {
    if (this.remoteRunners.get(userId) !== runner) return;
    this.remoteRunners.delete(userId);
    runner.disconnect();
    if (this.store.get('user', userId)) this.store.touch('user', userId, { runnerOnline: false });
    for (const a of this.store.all('agent')) {
      if (a.ownerId === userId) this.store.patch('agent', a.id, { status: 'offline', activity: null });
    }
  }

  private runnerFor(agent: Agent): Runner | null {
    if (agent.ownerId === this.owner().id) return this.localRunner;
    return this.remoteRunners.get(agent.ownerId) ?? null;
  }

  snapshot(actor: Actor): Snapshot {
    const you = actor.kind === 'user'
      ? actor.user
      : { id: actor.agentId, name: this.store.get('agent', actor.agentId)?.name ?? 'agent', role: 'member' as const, color: '#888', online: true, runnerOnline: true, appearance: randomAppearance('#888888') };
    return {
      you,
      users: this.store.all('user'),
      buildings: this.store.all('building'),
      floors: this.store.all('floor'),
      projects: this.store.all('project'),
      agents: this.store.all('agent'),
      tasks: this.store.all('task'),
      approvals: [...this.approvals.values()].map((p) => p.approval),
      settings: this.store.settings,
      rateLimits: this.store.rateLimits.get(you.id) ?? null,
      presence: [...this.presence.values()],
      terminalAvailable: you.role === 'owner' && actor.kind === 'user',
    };
  }

  // ------------------------------------------------------------------ commands

  async handle<K extends CommandName>(command: K, args: Commands[K]['args'], actor: Actor): Promise<Commands[K]['result']> {
    const handler = (this.handlers as Record<string, (a: unknown, u: User, actor: Actor) => unknown>)[command];
    if (!handler) throw new Error(`Unknown command: ${command}`);
    let user: User;
    if (actor.kind === 'agent') {
      if (!MANAGER_COMMANDS.has(command) || !actor.manager) throw new Error('Only manager agents can change the board');
      user = this.owner();
    } else {
      user = actor.user;
      if (OWNER_ONLY.has(command) && user.role !== 'owner') throw new Error('Only the office owner can do that');
    }
    return (await handler.call(this, args ?? {}, user, actor)) as Commands[K]['result'];
  }

  /** Agents run on their owner's machine and plan, so only the owner may steer them. */
  private ownAgent(id: ID, user: User): Agent {
    const agent = this.store.require('agent', id);
    if (agent.ownerId !== user.id) {
      const owner = this.store.get('user', agent.ownerId);
      throw new Error(`${agent.name} works for ${owner?.name ?? 'someone else'}; only they can do that`);
    }
    return agent;
  }

  private readonly handlers: {
    [K in CommandName]: (args: Commands[K]['args'], user: User, actor: Actor) => Commands[K]['result'] | Promise<Commands[K]['result']>;
  } = {
    // ---- world
    create_building: ({ name, kind, color }) => {
      const building = this.store.put('building', {
        id: randomUUID(), name: requireText(name, 'name'), kind,
        color: color ?? PALETTE[this.store.all('building').length % PALETTE.length], createdAt: Date.now(),
      });
      // Every building opens with a ground floor so it can be entered right away.
      this.store.put('floor', {
        id: randomUUID(), buildingId: building.id, name: 'Ground floor', level: 0, desks: 6, theme: DEFAULT_THEME, createdAt: Date.now(),
      });
      return building;
    },

    update_building: ({ id, patch }) => this.store.patch('building', id, patch),

    remove_building: ({ id }) => {
      const floors = this.store.all('floor').filter((f) => f.buildingId === id);
      if (floors.some((f) => this.store.all('agent').some((a) => a.floorId === f.id))) throw new Error('Move or fire the agents in this building first');
      if (floors.some((f) => this.store.all('project').some((p) => p.floorId === f.id))) throw new Error('Remove the projects in this building first');
      for (const f of floors) this.store.remove('floor', f.id);
      this.store.remove('building', id);
      return null;
    },

    create_floor: ({ buildingId, name }) => {
      this.store.require('building', buildingId);
      const level = this.store.all('floor').filter((f) => f.buildingId === buildingId).length;
      return this.store.put('floor', {
        id: randomUUID(), buildingId, name: requireText(name, 'name'), level, desks: 6, theme: DEFAULT_THEME, createdAt: Date.now(),
      });
    },

    update_floor: ({ id, patch }) => {
      const floor = this.store.require('floor', id);
      if (patch.desks !== undefined) {
        const seated = this.store.all('agent').filter((a) => a.floorId === id).length;
        if (!Number.isInteger(patch.desks) || patch.desks < Math.max(1, seated) || patch.desks > 24) {
          throw new Error(`Desks must be between ${Math.max(1, seated)} and 24`);
        }
      }
      return this.store.patch('floor', id, { ...patch, theme: { ...floor.theme, ...patch.theme } });
    },

    remove_floor: ({ id }) => {
      if (this.store.all('agent').some((a) => a.floorId === id)) throw new Error('Move or fire the agents on this floor first');
      if (this.store.all('project').some((p) => p.floorId === id)) throw new Error('Remove the projects on this floor first');
      this.store.remove('floor', id);
      return null;
    },

    create_project: async ({ name, repoPath, floorId, initGit }) => {
      this.store.require('floor', floorId);
      const dir = path.resolve(requireText(repoPath, 'repoPath').replace(/^~(?=$|[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? '~'));
      if (!existsSync(dir) && !initGit) throw new Error(`Directory not found: ${dir}`);
      let git = existsSync(dir) && (await hasCommits(dir));
      if (!git && initGit) git = await initRepo(dir);
      return this.store.put('project', {
        id: randomUUID(), name: requireText(name, 'name'), repoPath: dir, remoteUrl: git ? await originUrl(dir) : null,
        floorId, git, createdAt: Date.now(),
      });
    },

    remove_project: ({ id }) => {
      if (this.store.all('task').some((t) => t.projectId === id && t.status === 'in_progress')) {
        throw new Error('Project has tasks in progress');
      }
      for (const t of this.store.all('task')) if (t.projectId === id) this.store.remove('task', t.id);
      this.store.remove('project', id);
      return null;
    },

    // ---- agents
    hire_agent: ({ name, role, floorId, model, instructions, permissionMode, isManager, integrations, appearance }, user) => {
      if (this.store.all('agent').length >= this.store.settings.maxAgents) {
        throw new Error(`The company is at its limit of ${this.store.settings.maxAgents} agents. Raise it in settings.`);
      }
      const floor = this.store.require('floor', floorId);
      if (this.store.all('agent').filter((a) => a.floorId === floorId).length >= floor.desks) {
        throw new Error(`No free desk on ${floor.name}. Expand the floor first.`);
      }
      const known = new Set(this.store.settings.integrations.map((i) => i.id));
      const online = user.id === this.owner().id || this.remoteRunners.has(user.id);
      const agent = this.store.put('agent', {
        id: randomUUID(),
        name: requireText(name, 'name'),
        role: requireText(role, 'role'),
        adapter: 'claude-code',
        model: model || null,
        instructions: instructions ?? '',
        permissionMode: permissionMode ?? 'manual',
        isManager: !!isManager,
        integrations: (integrations ?? []).filter((i) => known.has(i)),
        floorId,
        ownerId: user.id,
        appearance: appearance ?? { skin: pick(SKINS), hair: pick(HAIRS), shirt: pick(PALETTE), hairStyle: pick(HAIR_STYLES) },
        status: online ? 'idle' : 'offline',
        activity: null,
        currentTaskId: null,
        live: false,
        xp: 0,
        createdAt: Date.now(),
      });
      this.dispatch();
      return agent;
    },

    update_agent: ({ id, patch }, user) => {
      this.ownAgent(id, user);
      if (patch.floorId && patch.floorId !== this.store.require('agent', id).floorId) {
        const floor = this.store.require('floor', patch.floorId);
        if (this.store.all('agent').filter((a) => a.floorId === floor.id).length >= floor.desks) throw new Error(`No free desk on ${floor.name}`);
      }
      const agent = this.store.patch('agent', id, patch);
      if (patch.floorId) this.dispatch();
      return agent;
    },

    fire_agent: async ({ id }, user) => {
      const agent = this.store.require('agent', id);
      if (agent.ownerId !== user.id && user.role !== 'owner') this.ownAgent(id, user);
      await this.endSession(id);
      for (const t of this.store.all('task')) {
        if (t.assigneeId === id && t.status !== 'done') this.store.patch('task', t.id, { assigneeId: null, status: t.status === 'in_progress' ? 'todo' : t.status });
      }
      this.store.remove('agent', id);
      this.dispatch();
      return null;
    },

    // ---- board
    create_task: ({ projectId, title, description, assigneeId }, user, actor) => {
      this.store.require('project', projectId);
      if (assigneeId) this.store.require('agent', assigneeId);
      const now = Date.now();
      const task = this.store.put('task', {
        id: randomUUID(), projectId, title: requireText(title, 'title'), description: description ?? '',
        status: 'todo', assigneeId: assigneeId ?? null, sessionId: null, branch: null, worktreePath: null,
        createdBy: actor.kind === 'agent' ? actor.agentId : user.id, createdAt: now, updatedAt: now,
      });
      if (actor.kind === 'agent') {
        const who = assigneeId ? this.store.get('agent', assigneeId)?.name : null;
        this.log(actor.agentId, null, 'system', `Created task "${task.title}"${who ? ` for ${who}` : ''}`);
      }
      this.dispatch();
      return task;
    },

    update_task: async ({ id, patch }) => {
      const before = this.store.require('task', id);
      const task = this.store.patch('task', id, patch);
      if (patch.status && patch.status !== before.status && (patch.status === 'done' || patch.status === 'failed')) {
        await this.closeTask(task);
      }
      this.dispatch();
      return this.store.require('task', id);
    },

    remove_task: async ({ id }) => {
      const task = this.store.require('task', id);
      await this.closeTask(task);
      this.store.remove('task', id);
      return null;
    },

    assign_task: async ({ taskId, agentId }) => {
      const task = this.store.require('task', taskId);
      const agent = this.store.require('agent', agentId);
      if (task.status === 'done') throw new Error('Task is already done');
      if (!this.isAvailable(agent, true)) {
        // Queue it: the agent picks it up as soon as it's free.
        return this.store.patch('task', taskId, { assigneeId: agentId, status: 'todo' });
      }
      await this.startTask(agent, task);
      return this.store.require('task', taskId);
    },

    // ---- conversations
    send_message: async ({ agentId, text }, user) => {
      const agent = this.ownAgent(agentId, user);
      const body = requireText(text, 'text');
      const live = this.sessions.get(agentId);
      if (live) {
        live.session.send(body);
        return null;
      }
      // No session: continue the current task's conversation, or start a free one.
      const task = agent.currentTaskId ? this.store.get('task', agent.currentTaskId) : undefined;
      if (task && task.status !== 'done') await this.startTask(agent, task, body);
      else await this.openSession(agent, null, body);
      return null;
    },

    agent_terminal_open: async ({ agentId, cols, rows }, user) => {
      const agent = this.store.require('agent', agentId);
      const mine = agent.ownerId === user.id;
      if (!this.sessions.has(agentId)) {
        if (!mine) throw new Error(`${agent.name} isn't working right now; only their owner can start a session`);
        const task = agent.currentTaskId ? this.store.get('task', agent.currentTaskId) : undefined;
        // Reopen the current task's conversation, or start a free one.
        if (task && (task.status === 'in_progress' || task.status === 'review')) {
          this.store.patch('agent', agentId, { status: 'idle' });
          await this.openSession(agent, task, null);
        } else {
          await this.openSession(agent, null, null);
        }
      }
      const live = this.sessions.get(agentId)!;
      if (mine) live.session.resize(cols, rows);
      return { history: live.buffer, interactive: live.interactive ?? true, canType: mine };
    },

    agent_terminal_input: ({ agentId, data }, user) => {
      this.ownAgent(agentId, user);
      const live = this.sessions.get(agentId);
      if (!live) throw new Error('The session has ended; open the computer again');
      live.session.write(data);
      return null;
    },

    agent_terminal_resize: ({ agentId, cols, rows }, user) => {
      if (this.store.get('agent', agentId)?.ownerId !== user.id) return null;
      this.sessions.get(agentId)?.session.resize(cols, rows);
      return null;
    },

    agent_terminal_close: () => null,

    interrupt_agent: ({ agentId }, user) => {
      this.ownAgent(agentId, user);
      const live = this.sessions.get(agentId);
      if (!live) throw new Error('Agent is not running');
      live.session.interrupt();
      return null;
    },

    resolve_approval: ({ id, decision, always, message }, user) => {
      const pending = this.approvals.get(id);
      if (!pending) throw new Error('Approval not found or already resolved');
      const { approval } = pending;
      this.ownAgent(approval.agentId, user);
      this.approvals.delete(id);
      this.store.broadcast({ type: 'approval_resolved', id });
      const live = this.sessions.get(approval.agentId);
      live?.session.respondPermission(pending.requestId, { allow: decision === 'allow', always, message });
      this.log(approval.agentId, approval.taskId, 'system',
        `${decision === 'allow' ? 'Approved' : 'Denied'}${always ? ' (always)' : ''}: ${approval.toolName}`);
      if (live && !this.hasPendingApproval(approval.agentId)) {
        this.store.patch('agent', approval.agentId, { status: 'working' });
      }
      return null;
    },

    get_transcript: ({ agentId, limit }) => this.db.transcript(agentId, Math.min(limit ?? 500, 2000)),

    get_usage_report: () =>
      this.db.usageReport({
        agents: new Map(this.store.all('agent').map((a) => [a.id, a.name])),
        projects: new Map(this.store.all('project').map((p) => [p.id, p.name])),
      }),

    update_settings: ({ patch }) => {
      if (patch.maxAgents !== undefined && (!Number.isInteger(patch.maxAgents) || patch.maxAgents < 1 || patch.maxAgents > 100)) {
        throw new Error('maxAgents must be between 1 and 100');
      }
      if (patch.integrations) {
        for (const i of patch.integrations) {
          requireText(i.id, 'integration id');
          requireText(i.name, 'integration name');
          if (!i.config || typeof i.config !== 'object') throw new Error(`Integration ${i.name} needs a config object`);
        }
      }
      const settings = this.store.setSettings(patch);
      this.dispatch();
      return settings;
    },

    // ---- multiplayer
    update_profile: ({ name, color, appearance }, user) =>
      this.store.patch('user', user.id, {
        ...(name ? { name: requireText(name, 'name') } : {}),
        ...(color ? { color } : {}),
        ...(appearance ? { appearance } : {}),
      }),

    create_invite: ({ name }) =>
      this.store.put('invite', { id: randomUUID(), name: requireText(name, 'name'), token: randomBytes(18).toString('base64url'), createdAt: Date.now(), usedBy: null }),

    list_invites: () => this.store.all('invite').sort((a, b) => b.createdAt - a.createdAt),

    revoke_invite: ({ id }) => {
      this.store.remove('invite', id);
      return null;
    },

    remove_member: async ({ id }) => {
      const member = this.store.require('user', id);
      if (member.role === 'owner') throw new Error('The owner cannot be removed');
      for (const a of this.store.all('agent').filter((x) => x.ownerId === id)) await this.handlers.fire_agent({ id: a.id }, this.owner(), { kind: 'user', user: this.owner() });
      for (const inv of this.store.all('invite').filter((i) => i.usedBy === id)) this.store.remove('invite', inv.id);
      this.store.remove('user', id);
      return null;
    },

    presence: ({ floorId, mode, position, rotation }, user) => {
      const p: Presence = { userId: user.id, floorId, mode: mode === 'walk' ? 'walk' : 'overview', position, rotation, ts: Date.now() };
      this.presence.set(user.id, p);
      this.store.broadcast({ type: 'presence', presence: p });
      return null;
    },

    // ---- boss terminal
    terminal_open: ({ cols, rows }) => ({ history: this.terminal.open(cols, rows) }),
    terminal_input: ({ data }) => { this.terminal.write(data); return null; },
    terminal_resize: ({ cols, rows }) => { this.terminal.resize(cols, rows); return null; },
  };

  // ------------------------------------------------------------------ dispatch

  /**
   * `explicit`: the task was assigned to this agent by someone, so it may
   * replace a free conversation; auto-dispatch never interrupts one that
   * somebody is watching.
   */
  private isAvailable(agent: Agent, explicit = false): boolean {
    if (this.starting.has(agent.id) || agent.status !== 'idle' || !this.runnerFor(agent)) return false;
    const live = this.sessions.get(agent.id);
    if (!explicit && live && live.taskId === null && (this.watchers.get(agent.id) ?? 0) > 0) return false;
    const current = agent.currentTaskId ? this.store.get('task', agent.currentTaskId) : undefined;
    return !current || current.status !== 'in_progress';
  }

  /** Hands queued tasks to free agents. Explicit assignments always run; open tasks only in auto mode. */
  dispatch() {
    const todo = this.store.all('task').filter((t) => t.status === 'todo').sort((a, b) => a.createdAt - b.createdAt);
    for (const agent of this.store.all('agent')) {
      let next = this.isAvailable(agent, true) ? todo.find((t) => t.assigneeId === agent.id) : undefined;
      if (!next && this.store.settings.dispatchMode === 'auto' && this.isAvailable(agent)) {
        // Managers plan and delegate; they don't grab open tasks themselves.
        next = agent.isManager ? undefined : todo.find((t) => !t.assigneeId && this.store.get('project', t.projectId)?.floorId === agent.floorId);
      }
      if (!next) continue;
      todo.splice(todo.indexOf(next), 1);
      this.startTask(agent, next).catch((err) => this.log(agent.id, next.id, 'error', `Could not start task: ${err.message}`));
    }
  }

  // ------------------------------------------------------------------ sessions

  /** Starts (or continues) a task. `message` replaces the default task prompt. */
  private async startTask(agent: Agent, task: Task, message?: string) {
    if (this.starting.has(agent.id)) throw new Error(`${agent.name} is busy`);
    const live = this.sessions.get(agent.id);
    if (live && live.taskId === task.id) {
      task = this.store.patch('task', task.id, { assigneeId: agent.id, status: 'in_progress' });
      this.store.patch('agent', agent.id, { currentTaskId: task.id, status: 'working' });
      live.session.send(message ?? 'Continue the task.');
      return;
    }
    const resumed = task.sessionId !== null;
    task = this.store.patch('task', task.id, { assigneeId: agent.id, status: 'in_progress' });
    agent = this.store.patch('agent', agent.id, { currentTaskId: task.id, status: 'working', activity: 'Getting started' });
    if (!message) this.log(agent.id, task.id, 'system', resumed ? `Resumed task: ${task.title}` : `Started task: ${task.title}`);
    await this.openSession(agent, task, message ?? (resumed ? 'Continue the task.' : taskPrompt(task)));
  }

  /**
   * Launches a Claude Code session for the agent. With a task it runs in the
   * task's worktree; without one it is a free conversation in the floor's
   * project (or the agent's scratch folder). `prompt` null waits for the user.
   */
  private async openSession(agent: Agent, task: Task | null, prompt: string | null) {
    if (this.starting.has(agent.id)) throw new Error(`${agent.name} is busy`);
    const runner = this.runnerFor(agent);
    if (!runner) throw new Error(`${agent.name}'s machine is offline`);
    this.starting.add(agent.id);
    try {
      if (this.sessions.has(agent.id)) await this.endSession(agent.id);
      const project = task
        ? this.store.require('project', task.projectId)
        : this.store.all('project').filter((p) => p.floorId === agent.floorId).sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
      const token = randomBytes(18).toString('base64url');
      this.agentTokens.set(token, agent.id);
      const integrations = this.store.settings.integrations.filter((i) => agent.integrations.includes(i.id));
      const sessionKey = randomUUID();
      const taskId = task?.id ?? null;
      const session = runner.start(
        {
          sessionKey,
          agent,
          task,
          project,
          prompt,
          mcpServers: Object.fromEntries(integrations.map((i) => [i.id, i.config])),
          hq: { url: `ws://127.0.0.1:${this.config.port}`, token, manager: agent.isManager },
        },
        (e) => this.onSessionEvent(agent.id, taskId, sessionKey, e),
      );
      this.sessions.set(agent.id, { session, taskId, closing: false, token, key: sessionKey, interactive: null, buffer: '' });
      this.store.patch('agent', agent.id, { live: true, ...(prompt ? {} : { status: 'idle', activity: null }) });
    } catch (err) {
      this.store.patch('agent', agent.id, { status: 'error', activity: null });
      throw err;
    } finally {
      this.starting.delete(agent.id);
    }
  }

  /** Stops an agent's session; resolves once its process has exited. */
  private endSession(agentId: ID): Promise<void> {
    const live = this.sessions.get(agentId);
    if (!live) return Promise.resolve();
    live.closing = true;
    this.sessions.delete(agentId);
    this.agentTokens.delete(live.token);
    this.clearApprovals(agentId);
    if (this.store.get('agent', agentId)) this.store.patch('agent', agentId, { live: false });
    return live.session.close();
  }

  private async closeTask(task: Task) {
    const agent = task.assigneeId ? this.store.get('agent', task.assigneeId) : undefined;
    if (agent) {
      const live = this.sessions.get(agent.id);
      // Wait for the process to exit: Windows won't delete a worktree that is
      // still some process's working directory.
      if (live?.taskId === task.id) await this.endSession(agent.id);
      if (agent.currentTaskId === task.id) {
        this.store.patch('agent', agent.id, { currentTaskId: null, status: agent.status === 'offline' ? 'offline' : 'idle', activity: null });
      }
    }
    const project = this.store.get('project', task.projectId);
    const runner = agent ? this.runnerFor(agent) : this.localRunner;
    if (project && task.worktreePath && runner && (await runner.cleanup(project, task))) {
      if (this.store.get('task', task.id)) this.store.patch('task', task.id, { worktreePath: null });
    }
  }

  private onSessionEvent(agentId: ID, taskId: ID | null, sessionKey: string, e: RunnerSessionEvent) {
    const agent = this.store.get('agent', agentId);
    if (!agent) return;
    // Ignore stragglers from a session that has since been replaced.
    const live = this.sessions.get(agentId);
    const current = live?.key === sessionKey;
    const task = taskId ? this.store.get('task', taskId) : undefined;
    switch (e.type) {
      case 'session':
        if (current) live!.interactive = e.interactive;
        if (task && task.sessionId !== e.sessionId) this.store.patch('task', task.id, { sessionId: e.sessionId });
        return;

      case 'pty':
        if (!current) return;
        live!.buffer = (live!.buffer + e.data).slice(-TERMINAL_HISTORY);
        live!.interactive = true;
        this.terminals.emit('data', agentId, e.data);
        return;

      case 'workspace':
        if (task) this.store.patch('task', task.id, { branch: e.branch, worktreePath: e.worktreePath });
        return;

      case 'transcript':
        this.log(agentId, taskId, e.kind, e.text, e.meta);
        return;

      case 'turn_start':
        if (!current) return;
        if (e.prompt.trim()) this.log(agentId, taskId, 'user', e.prompt);
        this.store.patch('agent', agentId, { status: 'working', activity: 'Thinking…' });
        if (task && task.status !== 'in_progress' && task.status !== 'done') this.store.patch('task', task.id, { status: 'in_progress' });
        return;

      case 'waiting':
        if (current) this.store.patch('agent', agentId, { status: 'awaiting_approval', activity: e.reason });
        return;

      case 'resumed':
        if (current && agent.status === 'awaiting_approval') this.store.patch('agent', agentId, { status: 'working', activity: 'Working…' });
        return;

      case 'activity':
        if (current) this.store.patch('agent', agentId, { activity: e.activity, ...(agent.status === 'idle' ? { status: 'working' } : {}) });
        return;

      case 'permission_request': {
        const approval: Approval = {
          id: randomUUID(), agentId, taskId, toolName: e.toolName, input: e.input,
          description: e.description, canAlwaysAllow: e.canAlwaysAllow, createdAt: Date.now(),
        };
        this.approvals.set(approval.id, { approval, requestId: e.requestId });
        this.store.broadcast({ type: 'approval', approval });
        this.store.patch('agent', agentId, { status: 'awaiting_approval' });
        return;
      }

      case 'turn_end': {
        this.db.recordUsage({ agentId, projectId: task?.projectId ?? null, taskId, ...e.usage });
        if (e.error) this.log(agentId, taskId, 'error', e.error);
        else this.log(agentId, taskId, 'result', e.interrupted ? 'Interrupted.' : 'Turn finished.', { usage: e.usage });
        if (!current) return;
        this.clearApprovals(agentId);
        const xp = this.store.settings.gamification && e.ok ? agent.xp + XP_PER_TURN : agent.xp;
        this.store.patch('agent', agentId, { status: 'idle', activity: null, xp });
        if (task?.status === 'in_progress') this.store.patch('task', task.id, { status: 'review' });
        this.dispatch();
        return;
      }

      case 'rate_limits':
        this.store.setRateLimits(agent.ownerId, e.rateLimits);
        return;

      case 'exit': {
        const expected = !current || !live || live.closing;
        if (current && live) {
          this.sessions.delete(agentId);
          this.agentTokens.delete(live.token);
          this.terminals.emit('data', agentId, `\r\n\x1b[90m[session ended${e.error ? `: ${e.error}` : ''} — open the computer again to start a new one]\x1b[0m\r\n`);
        }
        if (expected) return;
        this.clearApprovals(agentId);
        if (e.error) this.log(agentId, taskId, 'error', `Session ended: ${e.error}`);
        const offline = !this.runnerFor(agent);
        this.store.patch('agent', agentId, { live: false, status: offline ? 'offline' : e.error ? 'error' : 'idle', activity: null });
        this.dispatch();
        return;
      }
    }
  }

  // ------------------------------------------------------------------ terminals

  /** Someone opened (or closed) an agent's computer. */
  watch(agentId: ID, delta: 1 | -1) {
    const n = Math.max(0, (this.watchers.get(agentId) ?? 0) + delta);
    this.watchers.set(agentId, n);
    if (n === 0) this.dispatch();
  }

  // ------------------------------------------------------------------ helpers

  private hasPendingApproval(agentId: ID) {
    return [...this.approvals.values()].some((p) => p.approval.agentId === agentId);
  }

  private clearApprovals(agentId: ID) {
    for (const [id, p] of this.approvals) {
      if (p.approval.agentId !== agentId) continue;
      this.approvals.delete(id);
      this.store.broadcast({ type: 'approval_resolved', id });
    }
  }

  private log(agentId: ID, taskId: ID | null, kind: TranscriptEntry['kind'], text: string, meta?: Record<string, unknown>) {
    const entry = this.db.appendTranscript({ agentId, taskId, kind, text, meta: meta && Object.keys(meta).length ? meta : null, ts: Date.now() });
    this.store.broadcast({ type: 'transcript', entry });
  }
}
