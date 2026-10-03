import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HostCommandName, HostCommands, ID, OfficeInfo, OfficeMode } from '@agent-hq/protocol';
import type { AgentAdapter } from './adapters/adapter.ts';
import type { Config } from './config.ts';
import { Db } from './db.ts';
import { Decor } from './decor.ts';
import { Economy } from './economy.ts';
import { MachineAccounts } from './machine-accounts.ts';
import { Orchestrator } from './orchestrator.ts';
import { LocalRunner } from './runner/local.ts';
import { Store } from './store.ts';
import type { BossTerminal } from './terminal.ts';
import { Whiteboards } from './whiteboards.ts';

// Offices are separate saves. Each one has its own data dir (database,
// worktrees, agent notes) under <root>/offices/<dir>, listed in
// <root>/offices.json. Machine-wide things stay in <root>: the owner token
// (so the printed link and the desktop app keep working whichever office is
// open) and the owner's Claude accounts (see machine-accounts.ts).
//
// Installs from before offices kept their data directly in <root>: that
// becomes the "My office" save, in sandbox mode, without moving any file
// (git worktrees record absolute paths).
//
// The host process opens one office at a time. Switching closes the current
// one (its agents' sessions end) and opens the other in-process; the HTTP
// server and its port stay up and every client reconnects.

interface IndexEntry extends OfficeInfo {
  /** Data dir, relative to the root ("." for the pre-offices office). */
  dir: string;
}

interface IndexFile {
  version: 1;
  offices: IndexEntry[];
}

export interface OpenOffice {
  info: OfficeInfo;
  dataDir: string;
  db: Db;
  store: Store;
  orchestrator: Orchestrator;
  economy: Economy;
  /** Drawing boards (see whiteboards.ts); their commands are routed by the server. */
  whiteboards: Whiteboards;
  decor: Decor;
}

export const HOST_COMMANDS = new Set<string>(['list_offices', 'create_office', 'open_office', 'get_ledger', 'check_deliveries'] satisfies HostCommandName[]);
const OWNER_ONLY = new Set<HostCommandName>(['list_offices', 'create_office', 'open_office']);

const info = ({ dir: _dir, ...rest }: IndexEntry): OfficeInfo => rest;

function slug(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'office';
}

export class OfficeHost extends EventEmitter<{ opened: [OpenOffice]; closed: [OpenOffice] }> {
  current: OpenOffice | null = null;
  private readonly config: Config;
  private readonly adapters: AgentAdapter[];
  private readonly terminal: BossTerminal;
  private readonly indexFile: string;
  /** The owner's Claude accounts, shared by every office on this machine. */
  private readonly accounts: MachineAccounts;
  private index: IndexFile;
  /** Serializes open/close. */
  private switching: Promise<unknown> = Promise.resolve();

  constructor(config: Config, adapters: AgentAdapter[], terminal: BossTerminal) {
    super();
    this.config = config;
    this.adapters = adapters;
    this.terminal = terminal;
    this.indexFile = path.join(config.rootDir, 'offices.json');
    this.accounts = new MachineAccounts(config.rootDir);
    this.index = this.load();
  }

  // ------------------------------------------------------------------ index

  private load(): IndexFile {
    if (existsSync(this.indexFile)) {
      const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8')) as IndexFile;
      return { version: 1, offices: parsed.offices ?? [] };
    }
    const index: IndexFile = { version: 1, offices: [] };
    const legacyDb = path.join(this.config.rootDir, 'agent-hq.db');
    if (existsSync(legacyDb)) {
      // Upgrade: the existing office becomes a sandbox save, so nobody is locked out.
      const created = statSync(legacyDb).birthtimeMs || statSync(legacyDb).mtimeMs;
      index.offices.push({ id: 'default', name: 'My office', mode: 'sandbox', createdAt: Math.round(created), lastOpenedAt: Date.now(), dir: '.' });
    }
    this.save(index);
    return index;
  }

  private save(index = this.index) {
    const tmp = `${this.indexFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
    renameSync(tmp, this.indexFile);
  }

  /** Most recently opened first. */
  list(): OfficeInfo[] {
    return [...this.index.offices].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).map(info);
  }

  mostRecent(): OfficeInfo | null {
    return this.list()[0] ?? null;
  }

  private entry(id: ID): IndexEntry {
    const e = this.index.offices.find((o) => o.id === id);
    if (!e) throw new Error('Office not found');
    return e;
  }

  create(name: string, mode: OfficeMode): OfficeInfo {
    const clean = String(name ?? '').trim();
    if (!clean) throw new Error('Give your office a name');
    if (clean.length > 60) throw new Error('That name is too long (60 characters max)');
    if (mode !== 'sandbox' && mode !== 'career') throw new Error('Pick a mode: sandbox or career');
    const id = randomUUID();
    const dir = path.join('offices', `${slug(clean)}-${id.slice(0, 8)}`);
    mkdirSync(path.join(this.config.rootDir, dir), { recursive: true });
    const now = Date.now();
    const entry: IndexEntry = { id, name: clean, mode, createdAt: now, lastOpenedAt: now, dir };
    this.index.offices.push(entry);
    this.save();
    return info(entry);
  }

  // ------------------------------------------------------------------ open / close

  /** Opens an office, closing the current one. Opening the open one just marks it as last opened. */
  open(id: ID): Promise<OfficeInfo> {
    const run = this.switching.then(() => this.doOpen(id));
    this.switching = run.catch(() => {});
    return run;
  }

  private async doOpen(id: ID): Promise<OfficeInfo> {
    const entry = this.entry(id);
    entry.lastOpenedAt = Date.now();
    this.save();
    if (this.current?.info.id === id) {
      this.current.info.lastOpenedAt = entry.lastOpenedAt;
      return info(entry);
    }
    await this.doClose();

    const dataDir = path.resolve(this.config.rootDir, entry.dir);
    mkdirSync(dataDir, { recursive: true });
    const db = new Db(path.join(dataDir, 'agent-hq.db'));
    // The save describes itself too, so a copied office dir can be recognized.
    if (!db.getKv('office')) db.setKv('office', { id: entry.id, name: entry.name, mode: entry.mode, createdAt: entry.createdAt });
    const store = new Store(db);
    const config = { ...this.config, dataDir };
    const orchestrator = new Orchestrator(store, db, config, this.terminal);
    const officeInfo = info(entry);
    const economy = new Economy(db, store, officeInfo);
    orchestrator.economy = economy;
    const decor = new Decor(db, store, economy);
    orchestrator.decor = decor;
    const owner = orchestrator.ensureOwner();
    this.accounts.attach(store, db, owner.id);
    orchestrator.boot(new LocalRunner({
      userId: owner.id,
      dataDir,
      // Claude account dirs are machine-wide (<root>/claude-accounts); worktrees and notes stay per office.
      accountsRoot: this.config.rootDir,
      adapters: this.adapters,
      remote: false,
      hqUrl: `ws://127.0.0.1:${config.port}`,
      resolveRepo: async (project) => ({ repoPath: project.repoPath, git: project.git }),
    }));
    economy.start();
    const whiteboards = new Whiteboards(db, store);
    this.current = { info: officeInfo, dataDir, db, store, orchestrator, economy, whiteboards, decor };
    this.emit('opened', this.current);
    return officeInfo;
  }

  close(): Promise<void> {
    const run = this.switching.then(() => this.doClose());
    this.switching = run.catch(() => {});
    return run;
  }

  private async doClose() {
    const office = this.current;
    if (!office) return;
    this.current = null;
    office.economy.stop();
    office.whiteboards.flush();
    office.decor.stop();
    this.emit('closed', office);
    // Let agent processes exit cleanly, but never hang the switch. The old
    // database stays open: late session events may still write to it.
    await Promise.race([office.orchestrator.shutdown(), new Promise((r) => setTimeout(r, 6000).unref())]);
  }

  // ------------------------------------------------------------------ commands

  /**
   * Host commands. `after` runs once the reply was sent (switching offices
   * disconnects every client, including the one asking).
   */
  async handle<K extends HostCommandName>(
    command: K,
    args: HostCommands[K]['args'],
    isOwner: boolean,
  ): Promise<{ result: HostCommands[K]['result']; after?: () => Promise<unknown> }> {
    if (OWNER_ONLY.has(command) && !isOwner) throw new Error('Only the office owner can do that');
    const a = (args ?? {}) as Record<string, unknown>;
    type R = HostCommands[K]['result'];
    switch (command) {
      case 'list_offices':
        return { result: { offices: this.list(), currentId: this.current?.info.id ?? null } as R };
      case 'create_office': {
        const created = this.create(String(a.name ?? ''), a.mode as OfficeMode);
        return { result: created as R, after: () => this.open(created.id) };
      }
      case 'open_office': {
        const target = info(this.entry(String(a.id)));
        if (this.current?.info.id === target.id) return { result: (await this.open(target.id)) as R };
        return { result: target as R, after: () => this.open(target.id) };
      }
      case 'get_ledger': {
        const economy = this.requireOpen().economy;
        const limit = typeof a.limit === 'number' ? a.limit : 200;
        return { result: { entries: economy.ledger((a.filter as never) ?? null, limit), economy: economy.summary() } as R };
      }
      case 'check_deliveries': {
        const economy = this.requireOpen().economy;
        const paid = await economy.checkDeliveries(true);
        return { result: { paid, economy: economy.summary() } as R };
      }
    }
    throw new Error(`Unknown command: ${command}`);
  }

  private requireOpen(): OpenOffice {
    if (!this.current) throw new Error('No office is open');
    return this.current;
  }
}
