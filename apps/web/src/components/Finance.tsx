import { useEffect, useRef, useState } from 'react';
import type { EconomySummary, LedgerEntry, LedgerFilter, Snapshot } from '@agent-hq/protocol';
import { client } from '../api.ts';
import { stamp, usd } from '../format.ts';
import { Modal } from './Modal.tsx';
import '../tycoon.css';

// Tycoon phase 1 UI: the cash badge (in the HUD status card), the Finances
// panel (ledger) and a floating "+$X" when revenue is booked (the HUD's
// notification cards tell what it was for). <TycoonLayer/> in StartScreen.tsx
// mounts the panel and the floating text.


const usdCompact = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

/** "$1,234.50"; `short` gives "$12.3K" for big numbers. */
export function formatMoney(n: number, short = false): string {
  return short && Math.abs(n) >= 10_000 ? usdCompact.format(n) : usd(n);
}

const signed = (n: number) => `${n > 0 ? '+' : ''}${usd(n)}`;

/** Opens the Finances panel from anywhere (HUD menus, badges…). */
export function openFinances() {
  window.dispatchEvent(new CustomEvent('hq-open-finances'));
}

const INCOME_KINDS = new Set(['revenue', 'commission', 'bonus']);

// ---------------------------------------------------------------- HUD badge

/**
 * Compact cash indicator for the status card: cash, plus profit as a small
 * trend. Click opens the Finances panel. Renders nothing without an office.
 */
export function CashBadge({ world, onOpen = openFinances }: { world: Snapshot; onOpen?: () => void }) {
  const eco = world.economy;
  const [bump, setBump] = useState(false);
  const last = useRef(eco?.cash ?? 0);
  useEffect(() => {
    if (!eco) return;
    if (eco.cash > last.current + 0.005) {
      setBump(true);
      const t = setTimeout(() => setBump(false), 700);
      last.current = eco.cash;
      return () => clearTimeout(t);
    }
    last.current = eco.cash;
  }, [eco?.cash]);
  if (!eco) return null;
  const sandbox = eco.mode === 'sandbox';
  const title = sandbox
    ? `Sandbox: money is a scoreboard. Profit ${usd(eco.profit)} (revenue ${usd(eco.revenue)} − expenses ${usd(eco.expenses)})`
    : `Cash ${usd(eco.cash)} · profit ${usd(eco.profit)} (revenue ${usd(eco.revenue)} − expenses ${usd(eco.expenses)})`;
  return (
    <button type="button" className={`hq-cash ${eco.cash < 0 ? 'negative' : ''} ${bump ? 'bump' : ''}`} onClick={onOpen} title={title} data-hq-cash>
      <span className="hq-cash-icon" aria-hidden>{sandbox ? '🏆' : '💰'}</span>
      <span className="hq-cash-amount">{formatMoney(sandbox ? eco.profit : eco.cash, true)}</span>
      {!sandbox && (
        <span className={`hq-cash-trend ${eco.profit >= 0 ? 'up' : 'down'}`}>
          {eco.profit >= 0 ? '▲' : '▼'} {formatMoney(Math.abs(eco.profit), true)}
        </span>
      )}
    </button>
  );
}

/** Shown in the recruit form: what a hire costs and whether you can afford it. */
export function HiringFeeNote({ world }: { world: Snapshot }) {
  const eco = world.economy;
  if (!eco || !eco.gated || eco.hiringFee <= 0) return null;
  const missing = eco.hiringFee - eco.cash;
  return (
    <p className={`hq-fee-note ${missing > 0 ? 'short' : ''}`}>
      Hiring fee <b>{usd(eco.hiringFee)}</b> · cash {usd(eco.cash)}
      {missing > 0 && <> · <b>{usd(missing)} missing</b>: merge some delivered work first</>}
    </p>
  );
}

// ---------------------------------------------------------------- Finances panel

const FILTERS: Array<{ value: LedgerFilter | null; label: string }> = [
  { value: null, label: 'All' },
  { value: 'income', label: 'Income' },
  { value: 'expense', label: 'Spending' },
  { value: 'revenue', label: 'Shipped work' },
  { value: 'token_cost', label: 'Token costs' },
  { value: 'hiring_fee', label: 'Hiring' },
  { value: 'furnishing', label: 'Furnishing' },
];

const KIND_ICON: Record<LedgerEntry['kind'], string> = {
  starting_cash: '🏦',
  revenue: '🚀',
  commission: '🧭',
  bonus: '⭐',
  token_cost: '🔥',
  hiring_fee: '🤝',
  furnishing: '🛋️',
  adjustment: '✏️',
};

function Stat(props: { label: string; value: number; tone?: 'good' | 'bad' | 'auto'; hint?: string }) {
  const tone = props.tone === 'auto' ? (props.value >= 0 ? 'good' : 'bad') : props.tone;
  return (
    <div className={`hq-stat ${tone ?? ''}`} title={props.hint}>
      <span>{props.label}</span>
      <b>{usd(props.value)}</b>
    </div>
  );
}

export function FinancesModal({ world, onClose }: { world: Snapshot; onClose: () => void }) {
  const [filter, setFilter] = useState<LedgerFilter | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const eco: EconomySummary | null = world.economy;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => client.request('get_ledger', { filter, limit: 300 }).then((r) => { if (alive) setEntries(r.entries); }).catch(() => {});
    load();
    // New bookings refresh the list (debounced: token costs update every turn).
    const onLedger = () => { clearTimeout(timer); timer = setTimeout(load, 400); };
    window.addEventListener('hq-ledger', onLedger);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener('hq-ledger', onLedger); };
  }, [filter]);

  const check = async () => {
    setChecking(true);
    setNote(null);
    try {
      const r = await client.request('check_deliveries', {});
      setNote(r.paid ? `Paid ${r.paid} merged task${r.paid === 1 ? '' : 's'}!` : 'No newly merged work found. Tasks pay once their branch is merged into the default branch.');
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <Modal title="💼 Finances" onClose={onClose} wide>
      {!eco ? <p className="muted">No office is open.</p> : (
        <div className="hq-finances">
          <div className="hq-finances-head">
            <span className={`hq-mode-badge ${eco.mode}`}>{eco.mode === 'career' ? '📈 Career' : '🧰 Sandbox'}</span>
            <span className="muted small-text">
              {eco.mode === 'career'
                ? `Hiring costs ${usd(eco.hiringFee)}. Earn by getting tasks merged.`
                : 'Nothing is gated here: the books are a scoreboard of shipped work vs. token costs.'}
            </span>
            <span className="spacer" />
            <button className="small" onClick={check} disabled={checking}>{checking ? 'Checking…' : '🔎 Check merged work'}</button>
          </div>
          {note && <p className="hq-finances-note">{note}</p>}
          <div className="hq-stats">
            <Stat label="Cash" value={eco.cash} tone="auto" />
            <Stat label="Revenue" value={eco.revenue} tone="good" hint="Merged work, coordinator commissions and bonuses" />
            <Stat label="Expenses" value={-eco.expenses} tone={eco.expenses > 0 ? 'bad' : undefined} hint="API-equivalent token costs" />
            <Stat label="Profit" value={eco.profit} tone="auto" hint="Revenue − expenses (hiring fees are investments: they lower cash, not profit)" />
          </div>
          <div className="hq-cap" title="Income per day is capped; deliveries beyond it are paid on a later day">
            <span className="muted small-text">Today {usd(eco.earnedToday)} of {usd(eco.dailyRevenueCap)} daily cap</span>
            <div className="hq-cap-bar"><div style={{ width: `${Math.min(100, (eco.earnedToday / eco.dailyRevenueCap) * 100)}%` }} /></div>
          </div>

          <div className="tabs inline hq-filter">
            {FILTERS.map((f) => (
              <button key={f.label} className={filter === f.value ? 'active' : ''} onClick={() => setFilter(f.value)}>{f.label}</button>
            ))}
          </div>

          {!entries ? <p className="muted">Loading…</p> : entries.length === 0 ? (
            <p className="muted">No entries yet. Revenue arrives when a task's branch is merged; token costs as agents work.</p>
          ) : (
            <div className="hq-ledger-wrap">
              <table className="hq-ledger">
                <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Balance</th></tr></thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="nowrap">{stamp(e.ts)}</td>
                      <td><span aria-hidden>{KIND_ICON[e.kind]}</span> {e.description}</td>
                      <td className={`num ${e.amount >= 0 ? 'pos' : 'neg'}`}>{signed(e.amount)}</td>
                      <td className={`num ${(e.balance ?? 0) < 0 ? 'neg' : ''}`}>{e.balance === null ? '' : usd(e.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint">
            Revenue is paid once per task, when its branch is merged into the project's default branch (checked with
            git every few minutes, or with the button above). Bigger changes pay more, up to a cap; tiny diffs pay very
            little. Delegated tasks add a commission for the coordinator. Token costs are the API-equivalent cost Claude
            Code reports and never earn anything.
          </p>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- revenue pops

/** A floating "+$X" under the status card when revenue is booked. */
export function RevenuePops() {
  const [pops, setPops] = useState<Array<{ id: number; amount: number }>>([]);
  useEffect(() => {
    const on = (ev: Event) => {
      const entry = (ev as CustomEvent<LedgerEntry>).detail;
      if (!INCOME_KINDS.has(entry.kind) || entry.amount <= 0) return;
      const id = Date.now() + Math.random();
      setPops((p) => [...p.slice(-3), { id, amount: entry.amount }]);
      setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), 2600);
    };
    window.addEventListener('hq-ledger', on);
    return () => window.removeEventListener('hq-ledger', on);
  }, []);
  return <>{pops.map((p, i) => <div key={p.id} className="hq-float" style={{ animationDelay: `${i * 140}ms` }} aria-hidden>+{usd(p.amount)}</div>)}</>;
}
