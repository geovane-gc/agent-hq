import type {
  DecorCommandName,
  DecorCommands,
  DecorItem,
  DeskSetup,
  DeskStyle,
  ID,
  ServerEvent,
  User,
} from '@agent-hq/protocol';
import { CHAIR_MODELS, catalogItem, DESK_ITEMS, DESK_MODELS, deskStyleCost } from '@agent-hq/protocol/catalog';
import type { Db } from './db.ts';
import type { Economy } from './economy.ts';
import { round2 } from './economy-config.ts';
import type { Store } from './store.ts';

// Office customization on the host: decorations placed on floors and desk
// upgrades per agent. Both are small JSON documents in the office database's
// entities table (kinds 'decor' and 'desk_setup'), broadcast to every player
// as they change.
//
// Career offices pay the catalog price through the ledger when an item is
// bought and get it back when it is sold (removed), so the ledger always
// mirrors what the furniture is worth and undo/redo never loses money. Desk
// upgrades work the same way on the difference in value. Moving, turning and
// recoloring are free. Sandbox offices pay nothing.
//
// The host trusts the owner's client for collisions (the floor plan lives in
// the web app) and only checks that requests are sane.

const COMMANDS = new Set<string>(['place_decor', 'update_decor', 'remove_decor', 'set_desk_style'] satisfies DecorCommandName[]);
/** Keeps a runaway client from filling the database. */
const MAX_ITEMS_PER_FLOOR = 600;
const COLOR = /^#[0-9a-f]{6}$/i;

const finite = (n: unknown, field: string): number => {
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 500) throw new Error(`Invalid ${field}`);
  return Math.round(n * 1000) / 1000;
};

const quarterTurns = (n: unknown): number => {
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new Error('Invalid rotation');
  return ((n % 4) + 4) % 4;
};

const color = (c: unknown): string | null => {
  if (c == null) return null;
  if (typeof c !== 'string' || !COLOR.test(c)) throw new Error('Invalid color');
  return c.toLowerCase();
};

function deskStyle(style: DeskStyle): DeskStyle {
  if (!style || typeof style !== 'object') throw new Error('Invalid desk style');
  if (!DESK_MODELS.some((d) => d.id === style.desk)) throw new Error('Unknown desk');
  if (!CHAIR_MODELS.some((c) => c.id === style.chair)) throw new Error('Unknown chair');
  if (![1, 2, 3].includes(style.monitors)) throw new Error('A desk has one to three monitors');
  if (!Array.isArray(style.items) || style.items.some((i) => !DESK_ITEMS.some((d) => d.id === i))) throw new Error('Unknown desk item');
  return { desk: style.desk, chair: style.chair, monitors: style.monitors, items: [...new Set(style.items)] };
}

export class Decor {
  private readonly db: Db;
  private readonly store: Store;
  private readonly economy: Economy | null;
  private readonly decor: Map<ID, DecorItem>;
  private readonly desks: Map<ID, DeskSetup>;

  constructor(db: Db, store: Store, economy: Economy | null) {
    this.db = db;
    this.store = store;
    this.economy = economy;
    this.decor = new Map(db.loadEntities<DecorItem>('decor').map((d) => [d.id, d]));
    this.desks = new Map(db.loadEntities<DeskSetup>('desk_setup').map((d) => [d.agentId, d]));
    store.on('event', this.onStoreEvent);
  }

  stop() {
    this.store.off('event', this.onStoreEvent);
  }

  items(): DecorItem[] {
    return [...this.decor.values()];
  }

  deskSetups(): DeskSetup[] {
    return [...this.desks.values()];
  }

  handles(command: string): command is DecorCommandName {
    return COMMANDS.has(command);
  }

  handle<K extends DecorCommandName>(command: K, args: DecorCommands[K]['args'], user: User): DecorCommands[K]['result'] {
    const a = args as Record<string, unknown>;
    type R = DecorCommands[K]['result'];
    if (command === 'set_desk_style') return this.setDeskStyle(String(a.agentId), (a.style ?? null) as DeskStyle | null, user) as R;
    if (user.role !== 'owner') throw new Error('Only the office owner can decorate');
    switch (command) {
      case 'place_decor': return this.place(args as DecorCommands['place_decor']['args']) as R;
      case 'update_decor': return this.update(String(a.id), (a.patch ?? {}) as DecorCommands['update_decor']['args']['patch']) as R;
      case 'remove_decor': return this.remove(String(a.id)) as R;
    }
    throw new Error(`Unknown command: ${command}`);
  }

  // ------------------------------------------------------------------ decorations

  private place(args: DecorCommands['place_decor']['args']): DecorItem {
    const id = String(args.id ?? '');
    if (!/^[\w-]{8,64}$/.test(id)) throw new Error('Invalid item id');
    if (this.decor.has(id)) throw new Error('That item is already placed');
    const floor = this.store.require('floor', String(args.floorId));
    const entry = catalogItem(String(args.itemId));
    if (!entry) throw new Error('Unknown catalog item');
    if (this.items().filter((d) => d.floorId === floor.id).length >= MAX_ITEMS_PER_FLOOR) {
      throw new Error(`This floor is full (${MAX_ITEMS_PER_FLOOR} items)`);
    }
    const cost = this.economy?.furnishingCost(entry.price) ?? 0;
    this.economy?.assertCanAfford(cost, `a ${entry.name.toLowerCase()}`);
    const item: DecorItem = {
      id, floorId: floor.id, itemId: entry.id,
      x: finite(args.x, 'position'), z: finite(args.z, 'position'), rotation: quarterTurns(args.rotation ?? 0),
      color: entry.tint ? color(args.color) : null, paid: cost, createdAt: Date.now(),
    };
    this.save(item);
    this.economy?.bookFurnishing(-cost, `Bought: ${entry.name} (${floor.name})`, id);
    return item;
  }

  private update(id: ID, patch: DecorCommands['update_decor']['args']['patch']): DecorItem {
    const current = this.decor.get(id);
    if (!current) throw new Error('That item is gone');
    const next: DecorItem = { ...current };
    if (patch.x !== undefined) next.x = finite(patch.x, 'position');
    if (patch.z !== undefined) next.z = finite(patch.z, 'position');
    if (patch.rotation !== undefined) next.rotation = quarterTurns(patch.rotation);
    if (patch.color !== undefined) next.color = catalogItem(current.itemId)?.tint ? color(patch.color) : null;
    this.save(next);
    return next;
  }

  private remove(id: ID): null {
    const item = this.decor.get(id);
    if (!item) return null; // already gone: removing is idempotent (undo after someone else's delete)
    this.decor.delete(id);
    this.db.deleteEntity('decor', id);
    this.store.broadcast({ type: 'decor_removed', id });
    const name = catalogItem(item.itemId)?.name ?? 'item';
    this.economy?.bookFurnishing(item.paid, `Sold: ${name}`, id);
    return null;
  }

  private save(item: DecorItem) {
    this.decor.set(item.id, item);
    this.db.putEntity('decor', item.id, item);
    this.store.broadcast({ type: 'decor', item });
  }

  // ------------------------------------------------------------------ desks

  private setDeskStyle(agentId: ID, style: DeskStyle | null, user: User): DeskSetup | null {
    const agent = this.store.require('agent', agentId);
    if (agent.kind === 'repo') throw new Error('The balcony crew uses hot desks');
    if (user.role !== 'owner' && agent.ownerId !== user.id) throw new Error(`Only the boss or ${agent.name}'s owner can change this desk`);
    const before = this.desks.get(agentId);
    const paid = before?.paid ?? 0;
    if (!style) {
      this.dropDesk(agentId, `Desk reset: ${agent.name}`);
      return null;
    }
    const clean = deskStyle(style);
    const value = this.economy?.furnishingCost(deskStyleCost(clean)) ?? 0;
    const delta = round2(value - paid);
    this.economy?.assertCanAfford(delta, `${agent.name}'s desk upgrade`);
    const setup: DeskSetup = { agentId, style: clean, paid: value };
    this.desks.set(agentId, setup);
    this.db.putEntity('desk_setup', agentId, setup);
    this.store.broadcast({ type: 'desk_setup', setup });
    this.economy?.bookFurnishing(-delta, delta > 0 ? `Desk upgrade: ${agent.name}` : `Desk downgrade: ${agent.name}`, `desk:${agentId}`, agentId);
    return setup;
  }

  /** Removes a desk setup and refunds what it cost. */
  private dropDesk(agentId: ID, description: string) {
    const setup = this.desks.get(agentId);
    if (!setup) return;
    this.desks.delete(agentId);
    this.db.deleteEntity('desk_setup', agentId);
    this.store.broadcast({ type: 'desk_setup_removed', agentId });
    this.economy?.bookFurnishing(setup.paid, description, `desk:${agentId}`);
  }

  private readonly onStoreEvent = (e: ServerEvent) => {
    // A fired agent's desk upgrades are sold; a removed floor's decorations too.
    if (e.type === 'agent_removed') this.dropDesk(e.id, 'Sold: desk upgrades of a former agent');
    if (e.type === 'floor_removed') for (const item of this.items()) if (item.floorId === e.id) this.remove(item.id);
  };
}
