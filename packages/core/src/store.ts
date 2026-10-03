import { EventEmitter } from 'node:events';
import type {
  Agent,
  Building,
  ClaudeAccount,
  Floor,
  FloorTheme,
  ID,
  Invite,
  Project,
  RateLimits,
  ServerEvent,
  Settings,
  TakeoverRequest,
  Task,
  User,
} from '@agent-hq/protocol';
import { PALETTE } from '@agent-hq/protocol/catalog';
import type { Db } from './db.ts';
import { githubUrl } from './github.ts';
import { DEFAULT_INTEGRATIONS } from './integrations.ts';
import { DEFAULT_VOICE } from './media.ts';

interface EntityKinds {
  user: User;
  invite: Invite;
  building: Building;
  floor: Floor;
  project: Project;
  agent: Agent;
  task: Task;
  account: ClaudeAccount;
  takeover: TakeoverRequest;
}

type Kind = keyof EntityKinds;
/** Kinds whose changes are broadcast to every client. Invites stay private. */
type PublicKind = Exclude<Kind, 'invite'>;

export const DEFAULT_THEME: FloorTheme = {
  floor: 'wood',
  wall: 'paint',
  wallColor: '#e9e4da',
  accentColor: '#3d63dd',
  lighting: 'daylight',
  view: 'city',
  plants: true,
  lounge: true,
};

export { PALETTE };

const DEFAULT_SETTINGS: Settings = { maxAgents: 10, dispatchMode: 'auto', gamification: true, integrations: DEFAULT_INTEGRATIONS, takeoverPolicy: 'approval', voice: DEFAULT_VOICE };

// Fill in fields added after a record was first saved.
const normalize: { [K in Kind]?: (e: any) => EntityKinds[K] } = {
  user: (u) => ({
    color: PALETTE[0],
    appearance: { skin: '#e0ac69', hair: '#2c1b10', shirt: u.color ?? PALETTE[0], hairStyle: 'short' },
    ...u,
    // Players other than the boss were called members before they became managers.
    role: u.role === 'owner' ? 'owner' : 'manager',
    online: false,
    runnerOnline: false,
  }),
  building: (b) => ({ color: PALETTE[0], ...b }),
  floor: (f) => ({ desks: 6, ...f, theme: { ...DEFAULT_THEME, ...f.theme } }),
  project: (p) => ({ remoteUrl: null, ...p, githubUrl: p.githubUrl ?? githubUrl(p.remoteUrl) }),
  agent: (a) => ({
    kind: 'staff',
    repo: null,
    accountId: null,
    isManager: false,
    integrations: [],
    live: false,
    appearance: { skin: '#e0ac69', hair: '#3b2a1a', shirt: PALETTE[0], hairStyle: 'short' },
    ...a,
  }),
};

/**
 * In-memory world state backed by SQLite. Every mutation goes through here so
 * it is persisted and broadcast to all connected clients in one place.
 */
/** Persists some entities of a kind somewhere else than the office database. */
export interface ExternalPersistence<T> {
  owns(entity: T): boolean;
  save(entity: T): void;
  delete(id: ID): void;
}

export class Store extends EventEmitter<{ event: [ServerEvent] }> {
  private readonly db: Db;
  private readonly maps: { [K in Kind]: Map<ID, EntityKinds[K]> };
  /**
   * Offices: entities kept outside this office's database, e.g. the host
   * owner's Claude accounts, which are machine-wide (see machine-accounts.ts).
   */
  readonly external: { [K in Kind]?: ExternalPersistence<EntityKinds[K]> } = {};
  settings: Settings;
  /** Subscription meters per user (each player has their own plan). */
  readonly rateLimits = new Map<ID, RateLimits>();

  constructor(db: Db) {
    super();
    this.db = db;
    const load = <K extends Kind>(kind: K) =>
      new Map(db.loadEntities<EntityKinds[K]>(kind).map((e) => {
        const n = normalize[kind]?.(e) ?? e;
        // Persist role renames so stored data matches the current model.
        if (kind === 'user' && (e as User).role !== (n as User).role) db.putEntity(kind, n.id, n);
        return [n.id, n] as const;
      }));
    this.maps = {
      user: load('user'),
      invite: load('invite'),
      building: load('building'),
      floor: load('floor'),
      project: load('project'),
      agent: load('agent'),
      task: load('task'),
      account: load('account'),
      takeover: load('takeover'),
    };
    const saved = db.getKv<Partial<Settings>>('settings') ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...saved, integrations: saved.integrations ?? DEFAULT_INTEGRATIONS, voice: { ...DEFAULT_VOICE, ...saved.voice } };
    for (const [userId, limits] of Object.entries(db.getKv<Record<ID, RateLimits>>('rateLimitsByUser') ?? {})) {
      this.rateLimits.set(userId, limits);
    }
  }

  all<K extends Kind>(kind: K): EntityKinds[K][] {
    return [...this.maps[kind].values()];
  }

  get<K extends Kind>(kind: K, id: ID): EntityKinds[K] | undefined {
    return this.maps[kind].get(id);
  }

  require<K extends Kind>(kind: K, id: ID): EntityKinds[K] {
    const e = this.maps[kind].get(id);
    if (!e) throw new Error(`${kind} ${id} not found`);
    return e;
  }

  put<K extends Kind>(kind: K, entity: EntityKinds[K]): EntityKinds[K] {
    this.maps[kind].set(entity.id, entity);
    const external = this.external[kind] as ExternalPersistence<EntityKinds[K]> | undefined;
    if (external?.owns(entity)) external.save(entity);
    else this.db.putEntity(kind, entity.id, entity);
    if (kind !== 'invite') this.emit('event', { type: kind as PublicKind, [kind]: entity } as unknown as ServerEvent);
    return entity;
  }

  patch<K extends Kind>(kind: K, id: ID, patch: Partial<EntityKinds[K]>): EntityKinds[K] {
    const next = { ...this.require(kind, id), ...patch };
    if (kind === 'task') (next as Task).updatedAt = Date.now();
    return this.put(kind, next);
  }

  remove(kind: 'building' | 'floor' | 'project' | 'agent' | 'task' | 'invite' | 'user' | 'account' | 'takeover', id: ID) {
    const before = this.maps[kind].get(id);
    this.maps[kind].delete(id);
    const external = this.external[kind] as ExternalPersistence<unknown> | undefined;
    if (before && external?.owns(before)) external.delete(id);
    else this.db.deleteEntity(kind, id);
    if (kind === 'building' || kind === 'floor' || kind === 'project' || kind === 'agent' || kind === 'task' || kind === 'account' || kind === 'takeover') {
      this.emit('event', { type: `${kind}_removed`, id });
    }
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch };
    this.db.setKv('settings', this.settings);
    this.emit('event', { type: 'settings', settings: this.settings });
    return this.settings;
  }

  setRateLimits(userId: ID, rateLimits: RateLimits) {
    this.rateLimits.set(userId, rateLimits);
    this.db.setKv('rateLimitsByUser', Object.fromEntries(this.rateLimits));
    this.emit('event', { type: 'rate_limits', userId, rateLimits });
  }

  /** Runtime-only change (not persisted), e.g. online flags. */
  touch<K extends PublicKind>(kind: K, id: ID, patch: Partial<EntityKinds[K]>) {
    const next = { ...this.require(kind, id), ...patch };
    this.maps[kind].set(id, next);
    this.emit('event', { type: kind, [kind]: next } as unknown as ServerEvent);
  }

  /** In memory only, no event: an entity loaded from external persistence. */
  hydrate<K extends Kind>(kind: K, entity: EntityKinds[K]) {
    this.maps[kind].set(entity.id, entity);
  }

  /** Drops an entity from memory only, no event (e.g. moved to external persistence). */
  forget(kind: Kind, id: ID) {
    this.maps[kind].delete(id);
  }

  broadcast(event: ServerEvent) {
    this.emit('event', event);
  }
}
