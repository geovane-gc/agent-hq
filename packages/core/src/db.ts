import { DatabaseSync } from 'node:sqlite';
import type {
  ID,
  TranscriptEntry,
  TranscriptKind,
  UsageReport,
  UsageTotals,
} from '@agent-hq/protocol';

export interface UsageRecord {
  agentId: ID;
  projectId: ID | null;
  taskId: ID | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

const MIGRATIONS = [
  `CREATE TABLE entities (
     kind TEXT NOT NULL,
     id TEXT NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (kind, id)
   );
   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE transcript (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     agent_id TEXT NOT NULL,
     task_id TEXT,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     meta TEXT,
     ts INTEGER NOT NULL
   );
   CREATE INDEX transcript_agent ON transcript (agent_id, id);
   CREATE TABLE usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     agent_id TEXT NOT NULL,
     project_id TEXT,
     task_id TEXT,
     input_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL,
     cache_read_tokens INTEGER NOT NULL,
     cache_creation_tokens INTEGER NOT NULL,
     cost_usd REAL NOT NULL,
     ts INTEGER NOT NULL
   );`,
];

const TOTALS_SQL = `
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
  COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
  COALESCE(SUM(cost_usd), 0) AS costUsd,
  COUNT(*) AS turns`;

function toTotals(row: Record<string, unknown>): UsageTotals {
  return {
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cacheReadTokens: Number(row.cacheReadTokens),
    cacheCreationTokens: Number(row.cacheCreationTokens),
    costUsd: Number(row.costUsd),
    turns: Number(row.turns),
  };
}

export class Db {
  readonly sql: DatabaseSync;

  constructor(file: string) {
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    const version = Number(
      (this.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.sql.exec('BEGIN');
      this.sql.exec(MIGRATIONS[v]);
      this.sql.exec(`PRAGMA user_version = ${v + 1}`);
      this.sql.exec('COMMIT');
    }
  }

  // ---- entities: small JSON documents keyed by kind + id

  loadEntities<T>(kind: string): T[] {
    return this.sql
      .prepare('SELECT data FROM entities WHERE kind = ?')
      .all(kind)
      .map((r) => JSON.parse(String((r as { data: string }).data)) as T);
  }

  putEntity(kind: string, id: ID, data: unknown) {
    this.sql
      .prepare('INSERT INTO entities (kind, id, data) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data')
      .run(kind, id, JSON.stringify(data));
  }

  deleteEntity(kind: string, id: ID) {
    this.sql.prepare('DELETE FROM entities WHERE kind = ? AND id = ?').run(kind, id);
  }

  getKv<T>(key: string): T | null {
    const row = this.sql.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setKv(key: string, value: unknown) {
    this.sql
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  // ---- transcript

  appendTranscript(e: Omit<TranscriptEntry, 'id'>): TranscriptEntry {
    const res = this.sql
      .prepare('INSERT INTO transcript (agent_id, task_id, kind, text, meta, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.agentId, e.taskId, e.kind, e.text, e.meta ? JSON.stringify(e.meta) : null, e.ts);
    return { ...e, id: Number(res.lastInsertRowid) };
  }

  transcript(agentId: ID, limit: number): TranscriptEntry[] {
    const rows = this.sql
      .prepare('SELECT * FROM transcript WHERE agent_id = ? ORDER BY id DESC LIMIT ?')
      .all(agentId, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((r) => ({
      id: Number(r.id),
      agentId: String(r.agent_id),
      taskId: r.task_id == null ? null : String(r.task_id),
      kind: String(r.kind) as TranscriptKind,
      text: String(r.text),
      meta: r.meta == null ? null : JSON.parse(String(r.meta)),
      ts: Number(r.ts),
    }));
  }

  // ---- usage

  recordUsage(u: UsageRecord) {
    this.sql
      .prepare(
        `INSERT INTO usage (agent_id, project_id, task_id, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens, cost_usd, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.agentId, u.projectId, u.taskId, u.inputTokens, u.outputTokens,
        u.cacheReadTokens, u.cacheCreationTokens, u.costUsd, Date.now(),
      );
  }

  usageReport(names: { agents: Map<ID, string>; projects: Map<ID, string> }): UsageReport {
    const total = toTotals(this.sql.prepare(`SELECT ${TOTALS_SQL} FROM usage`).get() as Record<string, unknown>);
    const byAgent = (this.sql.prepare(`SELECT agent_id AS id, ${TOTALS_SQL} FROM usage GROUP BY agent_id`).all() as Array<Record<string, unknown>>)
      .map((r) => ({ agentId: String(r.id), name: names.agents.get(String(r.id)) ?? '(fired)', totals: toTotals(r) }));
    const byProject = (this.sql.prepare(`SELECT project_id AS id, ${TOTALS_SQL} FROM usage WHERE project_id IS NOT NULL GROUP BY project_id`).all() as Array<Record<string, unknown>>)
      .map((r) => ({ projectId: String(r.id), name: names.projects.get(String(r.id)) ?? '(removed)', totals: toTotals(r) }));
    const byDay = (this.sql.prepare(
      `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, ${TOTALS_SQL} FROM usage
       WHERE ts > ? GROUP BY day ORDER BY day`,
    ).all(Date.now() - 30 * 86400_000) as Array<Record<string, unknown>>)
      .map((r) => ({ day: String(r.day), totals: toTotals(r) }));
    return { total, byAgent, byProject, byDay };
  }
}
