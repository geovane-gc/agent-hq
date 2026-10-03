import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ClaudeAccount, ID } from '@agent-hq/protocol';
import type { Db } from './db.ts';
import type { Store } from './store.ts';

// The host owner's Claude accounts are machine-wide: the same logins (and
// their config dirs under <root>/claude-accounts) show up in every office.
// They live in <root>/claude-accounts.json instead of an office database.
// Each office has its own owner user id, so records are stored without one
// and take the open office's owner id in memory.
//
// Teammates' accounts stay in the office database: those players (and the
// machines their runners connect from) belong to that office.

type StoredAccount = Omit<ClaudeAccount, 'userId'>;

interface AccountsFile {
  version: 1;
  accounts: StoredAccount[];
}

const strip = ({ userId: _userId, ...rest }: ClaudeAccount): StoredAccount => rest;

export class MachineAccounts {
  private readonly file: string;

  constructor(rootDir: string) {
    this.file = path.join(rootDir, 'claude-accounts.json');
  }

  private read(): StoredAccount[] {
    if (!existsSync(this.file)) return [];
    try {
      return (JSON.parse(readFileSync(this.file, 'utf8')) as AccountsFile).accounts ?? [];
    } catch {
      throw new Error(`${this.file} is unreadable; fix or remove it`);
    }
  }

  private write(accounts: StoredAccount[]) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, accounts } satisfies AccountsFile, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /**
   * Makes an office use the machine-wide accounts for its owner. The owner's
   * account records found in that office's database (installs from before
   * offices, or the first office to connect one) move to the machine file;
   * agents pointing at a duplicate record are repointed to the kept one.
   */
  attach(store: Store, db: Db, ownerId: ID) {
    const machine = this.read();
    const remap = new Map<ID, ID>();
    let changed = false;
    for (const local of store.all('account').filter((a) => a.userId === ownerId)) {
      const same = machine.find((m) => m.id === local.id)
        ?? machine.find((m) => m.configDir === local.configDir); // one default login (null) per machine, one record per dir
      if (!same) {
        machine.push(strip(local));
        changed = true;
      } else if (same.id !== local.id) {
        remap.set(local.id, same.id);
      }
      db.deleteEntity('account', local.id);
      store.forget('account', local.id);
    }
    if (changed || !existsSync(this.file)) this.write(machine);
    for (const a of machine) store.hydrate('account', { ...a, userId: ownerId });
    for (const agent of store.all('agent')) {
      const to = agent.accountId ? remap.get(agent.accountId) : undefined;
      if (to) store.patch('agent', agent.id, { accountId: to });
    }
    // From now on the owner's accounts are saved here, everyone else's in the office.
    store.external.account = {
      owns: (a) => a.userId === ownerId,
      save: (a) => {
        const list = this.read();
        const i = list.findIndex((x) => x.id === a.id);
        if (i >= 0) list[i] = strip(a);
        else list.push(strip(a));
        this.write(list);
      },
      delete: (id) => this.write(this.read().filter((x) => x.id !== id)),
    };
  }
}
