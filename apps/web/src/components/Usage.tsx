import { useEffect, useState } from 'react';
import type { RateLimitWindow, RateLimits, UsageReport, UsageTotals } from '@agent-hq/protocol';
import { client } from '../api.ts';
import { Modal } from './Modal.tsx';

const fmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });

function Meter(props: { label: string; w: RateLimitWindow | null }) {
  if (!props.w) return null;
  const pct = Math.round(props.w.utilization * 100);
  const resets = new Date(props.w.resetsAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="meter" title={`Resets ${resets}`}>
      <span>{props.label}</span>
      <div className="bar"><div style={{ width: `${pct}%` }} className={pct > 80 ? 'hot' : ''} /></div>
      <span>{pct}%</span>
    </div>
  );
}

export function RateMeters({ limits }: { limits: RateLimits | null }) {
  if (!limits) return <span className="muted small-text">Subscription usage appears after the first turn</span>;
  return (
    <div className="meters">
      <Meter label="5h" w={limits.fiveHour} />
      <Meter label="7d" w={limits.sevenDay} />
    </div>
  );
}

function Row({ name, t }: { name: string; t: UsageTotals }) {
  return (
    <tr>
      <td>{name}</td>
      <td>{t.turns}</td>
      <td>{fmt.format(t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens)}</td>
      <td>{fmt.format(t.outputTokens)}</td>
      <td>{usd.format(t.costUsd)}</td>
    </tr>
  );
}

function Table({ rows }: { rows: Array<{ key: string; name: string; totals: UsageTotals }> }) {
  return (
    <table className="usage">
      <thead><tr><th /><th>Turns</th><th>Input</th><th>Output</th><th>API equiv.</th></tr></thead>
      <tbody>{rows.map((r) => <Row key={r.key} name={r.name} t={r.totals} />)}</tbody>
    </table>
  );
}

function DayChart({ days }: { days: UsageReport['byDay'] }) {
  if (!days.length) return <p className="muted">No usage yet.</p>;
  const max = Math.max(...days.map((d) => d.totals.outputTokens), 1);
  return (
    <div className="chart">
      {days.map((d) => (
        <div key={d.day} className="chart-col" title={`${d.day}: ${fmt.format(d.totals.outputTokens)} output tokens, ${d.totals.turns} turns`}>
          <div className="chart-bar" style={{ height: `${Math.max(2, (d.totals.outputTokens / max) * 100)}%` }} />
          <span>{d.day.slice(8)}</span>
        </div>
      ))}
    </div>
  );
}

export function UsageModal({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  useEffect(() => { client.request('get_usage_report', {}).then(setReport).catch(() => {}); }, []);
  return (
    <Modal title="Usage report" onClose={onClose} wide>
      {!report ? <p className="muted">Loading…</p> : (
        <>
          <p className="hint">
            Token counts come from Claude Code. "API equiv." is what the same usage would cost on the API;
            on a Claude subscription it is not billed — watch the 5h / 7d meters instead.
          </p>
          <h3>Last 30 days</h3>
          <DayChart days={report.byDay} />
          <h3>Total</h3>
          <Table rows={[{ key: 'total', name: 'All agents', totals: report.total }]} />
          <h3>By agent</h3>
          <Table rows={report.byAgent.map((r) => ({ key: r.agentId, name: r.name, totals: r.totals }))} />
          <h3>By project</h3>
          <Table rows={report.byProject.map((r) => ({ key: r.projectId, name: r.name, totals: r.totals }))} />
        </>
      )}
    </Modal>
  );
}
