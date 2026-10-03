import { useEffect, useState } from 'react';
import type { RateLimitWindow, RateLimits, UsageReport, UsageTotals } from '@agent-hq/protocol';
import { client } from '../api.ts';
import { compact, int, stamp, until, usd } from '../format.ts';
import { Modal } from './Modal.tsx';

/** Severity of a subscription meter: calm, getting close, nearly out. */
const severity = (pct: number) => (pct >= 80 ? 'hot' : pct >= 60 ? 'warm' : 'ok');

function Meter(props: { label: string; hint: string; w: RateLimitWindow | null }) {
  if (!props.w) return null;
  const pct = Math.round(props.w.utilization * 100);
  return (
    <div
      className={`meter ${severity(pct)}`}
      title={`${props.hint}: ${pct}% used. Resets ${stamp(props.w.resetsAt)}.`}
      role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={props.hint}
    >
      <div className="meter-top">
        <span className="meter-label">{props.label}</span>
        <strong>{pct}%</strong>
      </div>
      <div className="bar"><div style={{ width: `${Math.min(100, pct)}%` }} /></div>
      <span className="meter-reset">resets in {until(props.w.resetsAt)}</span>
    </div>
  );
}

/** The player's own Claude subscription windows, as reported by Claude Code. */
export function RateMeters({ limits }: { limits: RateLimits | null }) {
  if (!limits) return <span className="meters-empty" title="Claude Code reports your plan limits after an agent's first turn">Plan usage: no data yet</span>;
  return (
    <div className="meters">
      <Meter label="Session" hint="5-hour session limit" w={limits.fiveHour} />
      <Meter label="Week" hint="7-day weekly limit" w={limits.sevenDay} />
    </div>
  );
}

const inputOf = (t: UsageTotals) => t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens;

function Stat(props: { label: string; value: string; detail?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{props.label}</span>
      <span className="stat-value">{props.value}</span>
      {props.detail && <span className="stat-detail">{props.detail}</span>}
    </div>
  );
}

type Metric = 'cost' | 'output' | 'turns';
const METRICS: Array<{ id: Metric; label: string; of: (t: UsageTotals) => number; fmt: (n: number) => string }> = [
  { id: 'cost', label: 'API cost', of: (t) => t.costUsd, fmt: usd },
  { id: 'output', label: 'Output tokens', of: (t) => t.outputTokens, fmt: compact },
  { id: 'turns', label: 'Turns', of: (t) => t.turns, fmt: int },
];

/** Local YYYY-MM-DD, the same day key the server groups by. */
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayName = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** The last 30 days as a continuous timeline: days without usage show as gaps, not missing columns. */
function DayChart({ days }: { days: UsageReport['byDay'] }) {
  const [metric, setMetric] = useState<Metric>('cost');
  const [hover, setHover] = useState<number | null>(null);
  const m = METRICS.find((x) => x.id === metric)!;
  const byKey = new Map(days.map((d) => [d.day, d.totals]));
  const timeline = Array.from({ length: 30 }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - 29 + i);
    const key = dayKey(date);
    return { key, value: byKey.has(key) ? m.of(byKey.get(key)!) : 0, totals: byKey.get(key) };
  });
  const max = Math.max(...timeline.map((d) => d.value), 0);
  const shown = hover !== null ? timeline[hover] : null;
  const total = timeline.reduce((sum, d) => sum + d.value, 0);

  return (
    <section className="card-section">
      <div className="section-head">
        <h3>Last 30 days</h3>
        <span className="chart-readout">
          {shown
            ? <><strong>{dayName(shown.key)}</strong> · {m.fmt(shown.value)}{shown.totals ? ` · ${int(shown.totals.turns)} turns` : ''}</>
            : <>{m.fmt(total)} total</>}
        </span>
        <span className="spacer" />
        <div className="seg small" role="group" aria-label="Chart metric">
          {METRICS.map((x) => (
            <button key={x.id} className={x.id === metric ? 'active' : ''} aria-pressed={x.id === metric} onClick={() => setMetric(x.id)}>{x.label}</button>
          ))}
        </div>
      </div>
      {max === 0 ? <p className="empty">No usage in the last 30 days.</p> : (
        <>
          <div className="chart" onMouseLeave={() => setHover(null)}>
            {timeline.map((d, i) => (
              <div
                key={d.key}
                className={`chart-col ${hover === i ? 'hover' : ''}`}
                onMouseEnter={() => setHover(i)}
                title={`${dayName(d.key)}: ${m.fmt(d.value)}`}
              >
                {d.value > 0 && <div className="chart-bar" style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }} />}
              </div>
            ))}
          </div>
          <div className="chart-axis">
            <span>{dayName(timeline[0].key)}</span>
            <span>{dayName(timeline[15].key)}</span>
            <span>Today</span>
          </div>
        </>
      )}
    </section>
  );
}

/** A breakdown table, biggest spender first, with each row's share of the total cost. */
function Breakdown(props: { title: string; rows: Array<{ key: string; name: string; totals: UsageTotals }>; total: number }) {
  const rows = [...props.rows].sort((a, b) => b.totals.costUsd - a.totals.costUsd);
  return (
    <section className="card-section">
      <h3>{props.title}</h3>
      {rows.length === 0 ? <p className="empty">Nothing yet.</p> : (
        <table className="usage">
          <thead>
            <tr><th scope="col">Name</th><th scope="col">Turns</th><th scope="col" title="Including cache reads and writes">Input</th><th scope="col">Output</th><th scope="col">API cost</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const share = props.total > 0 ? r.totals.costUsd / props.total : 0;
              return (
                <tr key={r.key}>
                  <th scope="row">{r.name}</th>
                  <td>{int(r.totals.turns)}</td>
                  <td>{compact(inputOf(r.totals))}</td>
                  <td>{compact(r.totals.outputTokens)}</td>
                  <td>
                    <span className="share" title={`${Math.round(share * 100)}% of the total`}>
                      <span className="share-bar"><span style={{ width: `${share * 100}%` }} /></span>
                      {usd(r.totals.costUsd)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function UsageModal({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  useEffect(() => { client.request('get_usage_report', {}).then(setReport).catch(() => {}); }, []);
  const t = report?.total;
  return (
    <Modal title="📊 Usage" subtitle="Tokens and API-equivalent cost of your agents" onClose={onClose} wide>
      {!report || !t ? <p className="muted">Loading…</p> : (
        <div className="usage-report">
          <div className="stats">
            <Stat label="API-equivalent cost" value={usd(t.costUsd)} detail="Not billed on a subscription" />
            <Stat label="Turns" value={int(t.turns)} detail={t.turns ? `${usd(t.costUsd / t.turns)} per turn` : undefined} />
            <Stat label="Input tokens" value={compact(inputOf(t))} detail={`${compact(t.cacheReadTokens)} from cache`} />
            <Stat label="Output tokens" value={compact(t.outputTokens)} />
          </div>
          <DayChart days={report.byDay} />
          <div className="grid2">
            <Breakdown title="By agent" rows={report.byAgent.map((r) => ({ key: r.agentId, name: r.name, totals: r.totals }))} total={t.costUsd} />
            <Breakdown title="By project" rows={report.byProject.map((r) => ({ key: r.projectId, name: r.name, totals: r.totals }))} total={t.costUsd} />
          </div>
          <p className="hint">
            Token counts come from Claude Code. API cost is what the same usage would cost on the Claude API; on a
            subscription you are not charged for it, so watch the Session and Week meters in the top bar instead.
          </p>
        </div>
      )}
    </Modal>
  );
}
