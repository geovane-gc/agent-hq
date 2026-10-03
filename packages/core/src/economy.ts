import type {
  Agent,
  EconomySummary,
  ID,
  LedgerEntry,
  LedgerFilter,
  LedgerKind,
  OfficeInfo,
  ServerEvent,
  Task,
} from '@agent-hq/protocol';
import type { Db } from './db.ts';
import { fetchOrigin, hasOrigin, inspectBranch } from './delivery.ts';
import { ECONOMY, hiringFeeFor, payoutFor, round2, startingCashFor } from './economy-config.ts';
import type { Store } from './store.ts';

// The office economy (tycoon phase 1): a ledger of transactions per office.
//
// - Revenue: only for verified delivered work, i.e. a task branch merged into
//   the project's default branch (see delivery.ts). Paid once per task.
// - Expenses: the API-equivalent token cost Claude Code reports, rolled up per
//   day, agent and task. Profit = revenue − expenses.
// - Hiring fees (career) are investments: they lower cash, not profit.
// - Career mode gates hiring on cash. Sandbox gates nothing: the ledger is a scoreboard.
//
// The ledger lives in its own tables (created here, not in db.ts migrations)
// so the economy stays a self-contained module.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT NOT NULL,
    agent_id TEXT,
    task_id TEXT,
    project_id TEXT,
    -- Idempotency key: "revenue:<task>", "hire:<agent>", "tokens:<day>:<agent>:<task>"…
    ref TEXT UNIQUE
  );
  CREATE INDEX IF NOT EXISTS ledger_ts ON ledger (ts, id);
  -- What delivery checks learned about each task branch.
  CREATE TABLE IF NOT EXISTS deliveries (
    task_id TEXT PRIMARY KEY,
    base_sha TEXT,
    heads TEXT NOT NULL DEFAULT '[]',
    -- pending | paid | deferred (over the daily cap; retried later)
    state TEXT NOT NULL DEFAULT 'pending',
    lines INTEGER,
    via TEXT,
    note TEXT,
    checked_at INTEGER
  );`;

const KINDS: LedgerKind[] = ['starting_cash', 'revenue', 'commission', 'bonus', 'token_cost', 'hiring_fee', 'adjustment'];
const INCOME: LedgerKind[] = ['revenue', 'commission', 'bonus'];
/** The ledger's "expense" filter: everything that costs cash. */
const EXPENSE: LedgerKind[] = ['token_cost', 'hiring_fee'];
const inList = (kinds: LedgerKind[]) => kinds.map((k) => `'${k}'`).join(', ');

interface EconomyState {
  /** When this office's economy started; work finished before it isn't paid. */
  startedAt: number;
  /** Last row of the usage table already booked as token costs. */
  lastUsageId: number;
}

interface DeliveryRow {
  task_id: string;
  base_sha: string | null;
  heads: string;
  state: string;
}

export const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function localDay(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function toEntry(r: Record<string, unknown>): LedgerEntry {
  return {
    id: Number(r.id),
    ts: Number(r.ts),
    kind: String(r.kind) as LedgerKind,
    amount: round2(Number(r.amount)),
    description: String(r.description),
    agentId: r.agent_id == null ? null : String(r.agent_id),
    taskId: r.task_id == null ? null : String(r.task_id),
    projectId: r.project_id == null ? null : String(r.project_id),
    balance: r.balance == null ? null : round2(Number(r.balance)),
  };
}

export class Economy {
  readonly office: OfficeInfo;
  private readonly db: Db;
  private readonly store: Store;
  private readonly state: EconomyState;
  private timer: NodeJS.Timeout | null = null;
  private usageTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping: Promise<number> | null = null;
  private readonly lastFetch = new Map<ID, number>();
  private stopped = false;

  constructor(db: Db, store: Store, office: OfficeInfo) {
    this.db = db;
    this.store = store;
    this.office = office;
    db.sql.exec(SCHEMA);
    const saved = db.getKv<EconomyState>('economy');
    if (saved) {
      this.state = saved;
    } else {
      // First run for this office (new, or an install from before the economy):
      // start the books now. Earlier token usage is not billed retroactively.
      const max = db.sql.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM usage').get() as { id: number };
      this.state = { startedAt: Date.now(), lastUsageId: Number(max.id) };
      db.setKv('economy', this.state);
      const cash = startingCashFor(office.mode);
      if (cash > 0) this.book({ kind: 'starting_cash', amount: cash, description: `Starting cash for ${office.name}`, ref: 'start' });
    }
    this.store.on('event', this.onStoreEvent);
  }

  start() {
    this.syncUsage();
    this.timer = setInterval(() => {
      this.syncUsage();
      this.checkDeliveries(false).catch((err) => console.warn(`[economy] delivery check failed: ${err.message}`));
    }, ECONOMY.sweepIntervalMs);
    this.timer.unref();
    this.scheduleSweep(10_000);
  }

  stop() {
    this.stopped = true;
    for (const t of [this.timer, this.usageTimer, this.sweepTimer]) if (t) clearTimeout(t);
    this.store.off('event', this.onStoreEvent);
  }

  // ------------------------------------------------------------------ reading

  summary(): EconomySummary {
    const row = this.db.sql.prepare(
      `SELECT
         COALESCE(SUM(amount), 0) AS cash,
         COALESCE(SUM(CASE WHEN kind IN (${inList(INCOME)}) THEN amount END), 0) AS revenue,
         COALESCE(-SUM(CASE WHEN kind = 'token_cost' THEN amount END), 0) AS expenses,
         COALESCE(-SUM(CASE WHEN kind = 'hiring_fee' THEN amount END), 0) AS invested,
         COALESCE(SUM(CASE WHEN kind IN (${inList(INCOME)}) AND ts >= ? THEN amount END), 0) AS today
       FROM ledger`,
    ).get(startOfToday()) as Record<string, number>;
    const revenue = round2(Number(row.revenue));
    const expenses = round2(Number(row.expenses));
    return {
      mode: this.office.mode,
      cash: round2(Number(row.cash)),
      revenue,
      expenses,
      profit: round2(revenue - expenses),
      invested: round2(Number(row.invested)),
      earnedToday: round2(Number(row.today)),
      dailyRevenueCap: ECONOMY.dailyRevenueCap,
      hiringFee: hiringFeeFor(this.office.mode),
      gated: this.office.mode === 'career',
    };
  }

  /** Newest first, with the running balance after each entry. */
  ledger(filter: LedgerFilter | null = null, limit = 200): LedgerEntry[] {
    const kinds = filter === 'income' ? INCOME : filter === 'expense' ? EXPENSE : filter ? [filter] : null;
    if (kinds && !kinds.every((k) => KINDS.includes(k))) throw new Error('Unknown ledger filter');
    const rows = this.db.sql.prepare(
      `SELECT * FROM (
         SELECT *, SUM(amount) OVER (ORDER BY ts, id ROWS UNBOUNDED PRECEDING) AS balance FROM ledger
       ) ${kinds ? `WHERE kind IN (${inList(kinds)})` : ''}
       ORDER BY ts DESC, id DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(limit, 2000))) as Array<Record<string, unknown>>;
    return rows.map(toEntry);
  }

  // ------------------------------------------------------------------ hiring (career gating)

  /** Throws a clear message when the company can't afford a hire. Nothing is gated in sandbox. */
  assertCanHire() {
    const fee = hiringFeeFor(this.office.mode);
    if (!this.summary().gated || fee <= 0) return;
    const { cash } = this.summary();
    if (cash < fee) {
      throw new Error(`Not enough cash to hire: the hiring fee is ${usd(fee)} and you have ${usd(cash)} (${usd(fee - cash)} missing). Merge some delivered work to earn it.`);
    }
  }

  chargeHire(agent: Agent) {
    const fee = hiringFeeFor(this.office.mode);
    if (fee <= 0) return;
    this.book({ kind: 'hiring_fee', amount: -fee, description: `Hiring fee: ${agent.name} (${agent.role})`, agentId: agent.id, ref: `hire:${agent.id}` });
  }

  // ------------------------------------------------------------------ expenses: token costs

  /**
   * Books new usage rows as token costs, one ledger entry per day, agent and
   * task (amounts accumulate). Idempotent: rows are tracked by id.
   */
  syncUsage() {
    if (this.stopped) return;
    const rows = this.db.sql.prepare(
      'SELECT id, agent_id, project_id, task_id, cost_usd, ts FROM usage WHERE id > ? ORDER BY id',
    ).all(this.state.lastUsageId) as Array<Record<string, unknown>>;
    if (!rows.length) return;
    const touched = new Set<string>();
    const upsert = this.db.sql.prepare(
      `INSERT INTO ledger (ts, kind, amount, description, agent_id, task_id, project_id, ref)
       VALUES (?, 'token_cost', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (ref) DO UPDATE SET amount = amount + excluded.amount`,
    );
    this.db.sql.exec('BEGIN');
    try {
      for (const r of rows) {
        const cost = Number(r.cost_usd);
        if (!(cost > 0)) continue;
        const agentId = String(r.agent_id);
        const taskId = r.task_id == null ? null : String(r.task_id);
        const ref = `tokens:${localDay(Number(r.ts))}:${agentId}:${taskId ?? '-'}`;
        const agent = this.store.get('agent', agentId)?.name ?? 'Former agent';
        const task = taskId ? this.store.get('task', taskId)?.title : null;
        upsert.run(Number(r.ts), -cost, `Token costs: ${agent}${task ? ` on "${task}"` : ' (chat)'}`, agentId, taskId, r.project_id == null ? null : String(r.project_id), ref);
        touched.add(ref);
      }
      this.state.lastUsageId = Number(rows.at(-1)!.id);
      this.db.setKv('economy', this.state);
      this.db.sql.exec('COMMIT');
    } catch (err) {
      this.db.sql.exec('ROLLBACK');
      throw err;
    }
    for (const ref of touched) this.emitRef(ref);
  }

  // ------------------------------------------------------------------ revenue: verified merged work

  /**
   * Looks for task branches merged into their project's default branch and
   * pays them. `manual`: fetch every origin now instead of respecting the
   * fetch interval. Resolves to the number of tasks paid.
   */
  checkDeliveries(manual: boolean): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (this.sweeping && !manual) return this.sweeping;
    // One sweep at a time; a manual check waits for a running one, then fetches.
    const run: Promise<number> = (this.sweeping ?? Promise.resolve(0))
      .catch(() => 0)
      .then(() => this.sweep(manual))
      .finally(() => { if (this.sweeping === run) this.sweeping = null; });
    this.sweeping = run;
    return run;
  }

  private async sweep(manual: boolean): Promise<number> {
    const now = Date.now();
    const rows = new Map(
      (this.db.sql.prepare('SELECT task_id, base_sha, heads, state FROM deliveries').all() as unknown as DeliveryRow[]).map((r) => [r.task_id, r]),
    );
    const tasks = this.store.all('task').filter((t) => {
      if (!t.branch || now - t.updatedAt > ECONOMY.maxTaskAgeMs) return false;
      if (t.status !== 'in_progress' && t.status !== 'review' && t.status !== 'done') return false;
      const state = rows.get(t.id)?.state;
      if (state === 'paid') return false;
      // Work finished before the books were opened isn't paid.
      return t.status !== 'done' || t.updatedAt >= this.state.startedAt;
    });

    let paid = 0;
    const fetched = new Set<ID>();
    for (const task of tasks) {
      if (this.stopped) break;
      const project = this.store.get('project', task.projectId);
      if (!project?.git) continue;
      if (!fetched.has(project.id)) {
        fetched.add(project.id);
        const last = this.lastFetch.get(project.id) ?? 0;
        if ((manual || now - last > ECONOMY.fetchMinIntervalMs) && (await hasOrigin(project.repoPath))) {
          this.lastFetch.set(project.id, now);
          await fetchOrigin(project.repoPath);
        }
      }
      const known = rows.get(task.id);
      const check = await inspectBranch(project.repoPath, task.branch!, {
        base: known?.base_sha ?? null,
        heads: known ? (JSON.parse(known.heads) as string[]) : [],
      }).catch((err: Error) => ({ merged: false, via: null, lines: 0, base: known?.base_sha ?? null, heads: [], defaultRef: null, note: err.message }));
      if (this.stopped) break;

      // Unmerged (or merged without changes yet) stays pending: the agent may still add commits.
      let state = 'pending';
      if (check.merged && task.status !== 'in_progress') {
        state = this.payDelivery(task, check.lines) ? 'paid' : 'deferred';
        if (state === 'paid') paid++;
      }
      this.db.sql.prepare(
        `INSERT INTO deliveries (task_id, base_sha, heads, state, lines, via, note, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_id) DO UPDATE SET base_sha = excluded.base_sha, heads = excluded.heads, state = excluded.state,
           lines = excluded.lines, via = excluded.via, note = excluded.note, checked_at = excluded.checked_at`,
      ).run(task.id, check.base, JSON.stringify(check.heads), state, check.lines, check.via, check.note, Date.now());
    }
    return paid;
  }

  /** Books revenue (and the coordinator's commission) once per task. False when today's cap has no room left. */
  private payDelivery(task: Task, lines: number): boolean {
    if (this.hasRef(`revenue:${task.id}`)) return true;
    const payout = payoutFor(lines);
    const coordinator = this.store.get('agent', task.createdBy);
    const commission = coordinator ? round2(payout * ECONOMY.coordinatorCommission) : 0;
    const bonuses = this.bonusesFor(task, payout);
    const total = payout + commission + bonuses.reduce((s, b) => s + b.amount, 0);
    if (this.summary().earnedToday + total > ECONOMY.dailyRevenueCap) return false;

    const project = this.store.get('project', task.projectId);
    const assignee = task.assigneeId ? this.store.get('agent', task.assigneeId) : undefined;
    const refs: string[] = [];
    this.db.sql.exec('BEGIN');
    try {
      refs.push(this.insert({
        kind: 'revenue', amount: payout, ref: `revenue:${task.id}`, agentId: task.assigneeId, taskId: task.id, projectId: task.projectId,
        description: `Shipped "${task.title}"${assignee ? ` by ${assignee.name}` : ''} (${lines} line${lines === 1 ? '' : 's'}${project ? `, ${project.name}` : ''})`,
      }));
      if (coordinator && commission > 0) {
        refs.push(this.insert({
          kind: 'commission', amount: commission, ref: `commission:${task.id}`, agentId: coordinator.id, taskId: task.id, projectId: task.projectId,
          description: `Coordinator commission: ${coordinator.name} delegated "${task.title}" (+${Math.round(ECONOMY.coordinatorCommission * 100)}%)`,
        }));
      }
      for (const b of bonuses) {
        refs.push(this.insert({ kind: 'bonus', amount: b.amount, ref: `bonus:${b.id}:${task.id}`, agentId: task.assigneeId, taskId: task.id, projectId: task.projectId, description: b.description }));
      }
      this.db.sql.exec('COMMIT');
    } catch (err) {
      this.db.sql.exec('ROLLBACK');
      throw err;
    }
    for (const ref of refs) this.emitRef(ref);
    return true;
  }

  /**
   * Extension point for phase 2 bonuses, booked with the revenue.
   * TODO(phase 2): CI green on the merged head (ECONOMY.ciGreenBonus, needs
   * GitHub-linked projects); no revert within ECONOMY.noRevertDays
   * (ECONOMY.noRevertBonus, paid later by a sweep, ref `bonus:no_revert:<task>`).
   */
  private bonusesFor(_task: Task, _payout: number): Array<{ id: string; amount: number; description: string }> {
    return [];
  }

  // ------------------------------------------------------------------ helpers

  private readonly onStoreEvent = (e: ServerEvent) => {
    if (e.type === 'agent') {
      // Turn ends update the agent: book the usage they recorded.
      if (this.usageTimer) clearTimeout(this.usageTimer);
      this.usageTimer = setTimeout(() => this.syncUsage(), 1000);
    } else if (e.type === 'task' && (e.task.status === 'review' || e.task.status === 'done') && e.task.branch) {
      this.scheduleSweep(3000);
    }
  };

  private scheduleSweep(delay: number) {
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => {
      this.checkDeliveries(false).catch((err) => console.warn(`[economy] delivery check failed: ${err.message}`));
    }, delay);
    this.sweepTimer.unref();
  }

  private hasRef(ref: string) {
    return !!this.db.sql.prepare('SELECT 1 FROM ledger WHERE ref = ?').get(ref);
  }

  private insert(e: { kind: LedgerKind; amount: number; description: string; ref: string; agentId?: ID | null; taskId?: ID | null; projectId?: ID | null }): string {
    this.db.sql.prepare(
      `INSERT INTO ledger (ts, kind, amount, description, agent_id, task_id, project_id, ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ref) DO NOTHING`,
    ).run(Date.now(), e.kind, round2(e.amount), e.description, e.agentId ?? null, e.taskId ?? null, e.projectId ?? null, e.ref);
    return e.ref;
  }

  private book(e: Parameters<Economy['insert']>[0]) {
    this.emitRef(this.insert(e));
  }

  private emitRef(ref: string) {
    const row = this.db.sql.prepare('SELECT * FROM ledger WHERE ref = ?').get(ref) as Record<string, unknown> | undefined;
    if (row) this.store.broadcast({ type: 'ledger', entry: toEntry(row), economy: this.summary() });
  }
}
