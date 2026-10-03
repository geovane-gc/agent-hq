import { useEffect, useState, type FormEvent } from 'react';
import type { OfficeInfo, OfficeMode, Snapshot } from '@agent-hq/protocol';
import { client } from '../api.ts';
import { ago } from '../format.ts';
import { FinancesModal, RevenuePops } from './Finance.tsx';
import '../tycoon.css';

// Tycoon phase 1: the title screen (Continue / New Office / Load office /
// Quit) and <TycoonLayer/>, which mounts everything the economy needs on top
// of the office so App.tsx only has to render it once.

const SEEN_KEY = 'hq-title-seen';
const isDesktopApp = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');

function seen(): boolean {
  try { return sessionStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}
function markSeen() {
  try { sessionStorage.setItem(SEEN_KEY, '1'); } catch {}
}

/** Shows the title screen again (e.g. from a "Main menu" entry). Owner only. */
export function openStartScreen() {
  window.dispatchEvent(new CustomEvent('hq-open-title'));
}

const MODES: Array<{ mode: OfficeMode; icon: string; title: string; pitch: string; bullets: string[] }> = [
  {
    mode: 'sandbox',
    icon: '🧰',
    title: 'Sandbox',
    pitch: 'Use Agent HQ as your everyday work tool.',
    bullets: [
      'Everything unlocked: hire whoever you need, whenever you need',
      'No money gating, ever',
      'Shipped work and token costs still add up on a scoreboard',
    ],
  },
  {
    mode: 'career',
    icon: '📈',
    title: 'Career',
    pitch: 'Grow a studio from a small budget by shipping real work.',
    bullets: [
      'Start with enough cash for about 3 hires',
      'Earn money only when a task’s branch gets merged',
      'Token costs are real expenses: keep the company profitable',
    ],
  },
];

type View = 'menu' | 'new' | 'load';

/**
 * The title screen. `offices` comes from the lobby (no office open yet) or is
 * fetched; `current` is the open office, if any.
 */
export function StartScreen(props: { offices?: OfficeInfo[]; current?: OfficeInfo | null; onContinue?: () => void }) {
  const [offices, setOffices] = useState<OfficeInfo[]>(props.offices ?? []);
  const [view, setView] = useState<View>('menu');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<OfficeMode | null>(null);
  const lobby = !!props.offices;
  const current = props.current ?? null;
  const continueTarget = current ?? offices[0] ?? null;

  useEffect(() => {
    if (lobby) { setOffices(props.offices ?? []); return; }
    client.request('list_offices', {}).then((r) => setOffices(r.offices)).catch(() => {});
  }, [lobby, props.offices]);

  /** After switching, start from a clean page in the new office. */
  const switched = () => {
    markSeen();
    if (lobby) return; // the lobby reconnects into the new office by itself
    setTimeout(() => location.reload(), 250);
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  const onContinue = () => {
    if (!continueTarget) return;
    if (current && continueTarget.id === current.id) {
      markSeen();
      client.request('open_office', { id: current.id }).catch(() => {}); // just marks it as last opened
      props.onContinue?.();
      return;
    }
    run(`Opening ${continueTarget.name}…`, async () => {
      await client.request('open_office', { id: continueTarget.id });
      switched();
    });
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!mode) { setError('Pick a mode'); return; }
    run(`Founding ${name.trim() || 'your office'}…`, async () => {
      await client.request('create_office', { name, mode });
      switched();
    });
  };

  const load = (o: OfficeInfo) => {
    if (current && o.id === current.id) { onContinue(); return; }
    run(`Opening ${o.name}…`, async () => {
      await client.request('open_office', { id: o.id });
      switched();
    });
  };

  return (
    <div className="hq-title" role="dialog" aria-label="Agent HQ">
      <div className="hq-title-sky" aria-hidden>
        <span>🏢</span><span>🏬</span><span>🏙️</span>
      </div>
      <div className="hq-title-card">
        <header className="hq-title-head">
          <div className="hq-title-logo" aria-hidden>🏢</div>
          <h1>Agent HQ</h1>
          <p>Run a software company staffed by AI agents.</p>
        </header>

        {busy ? (
          <div className="hq-title-busy"><span className="hq-spinner" aria-hidden /> {busy}</div>
        ) : view === 'menu' ? (
          <div className="hq-title-menu">
            {continueTarget && (
              <button className="hq-big primary" onClick={onContinue} autoFocus>
                <span>Continue</span>
                <small>{continueTarget.name} · {continueTarget.mode === 'career' ? 'Career' : 'Sandbox'}</small>
              </button>
            )}
            <button className={`hq-big ${continueTarget ? '' : 'primary'}`} onClick={() => { setView('new'); setError(null); }} autoFocus={!continueTarget}>
              <span>New Office</span>
              <small>Start from scratch. Your other offices are kept.</small>
            </button>
            {offices.length > 1 && (
              <button className="hq-big" onClick={() => setView('load')}>
                <span>Load office</span>
                <small>{offices.length} saved offices</small>
              </button>
            )}
            {isDesktopApp && (
              <button className="hq-big quiet" onClick={() => window.close()}>
                <span>Quit</span>
              </button>
            )}
          </div>
        ) : view === 'new' ? (
          <form className="hq-title-new" onSubmit={create}>
            <label className="hq-field">
              <span>Company name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pixel Forge Studios" maxLength={60} autoComplete="off" data-1p-ignore autoFocus required />
            </label>
            <div className="hq-modes" role="radiogroup" aria-label="Mode">
              {MODES.map((m) => (
                <button
                  type="button"
                  key={m.mode}
                  role="radio"
                  aria-checked={mode === m.mode}
                  className={`hq-mode ${m.mode} ${mode === m.mode ? 'on' : ''}`}
                  onClick={() => setMode(m.mode)}
                >
                  <span className="hq-mode-icon" aria-hidden>{m.icon}</span>
                  <b>{m.title}</b>
                  <span className="hq-mode-pitch">{m.pitch}</span>
                  <ul>{m.bullets.map((b) => <li key={b}>{b}</li>)}</ul>
                </button>
              ))}
            </div>
            <footer>
              <button type="button" className="ghost" onClick={() => { setView('menu'); setError(null); }}>Back</button>
              <button type="submit" disabled={!name.trim() || !mode}>Found company</button>
            </footer>
          </form>
        ) : (
          <div className="hq-title-load">
            <ul>
              {offices.map((o) => (
                <li key={o.id}>
                  <button onClick={() => load(o)}>
                    <span className={`hq-mode-badge ${o.mode}`}>{o.mode === 'career' ? '📈 Career' : '🧰 Sandbox'}</span>
                    <b>{o.name}</b>
                    <span className="muted small-text">{current?.id === o.id ? 'open now' : `last played ${ago(o.lastOpenedAt)}`}</span>
                  </button>
                </li>
              ))}
            </ul>
            <footer><button className="ghost" onClick={() => setView('menu')}>Back</button></footer>
          </div>
        )}
        {error && <p className="error hq-title-error">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Everything tycoon on top of the office: the title screen (owner, once per
 * app session), the Finances panel and the revenue pops. Mount once in App.
 */
export function TycoonLayer({ world }: { world: Snapshot }) {
  const owner = world.you.role === 'owner';
  const [title, setTitle] = useState(() => owner && !seen());
  const [finances, setFinances] = useState(false);
  useEffect(() => {
    const openTitle = () => { if (owner) setTitle(true); };
    const openFin = () => setFinances(true);
    // Esc closes the Finances panel like the other overlays (it belongs to Claude Code inside a terminal).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest?.('.xterm')) setFinances(false);
    };
    window.addEventListener('hq-open-title', openTitle);
    window.addEventListener('hq-open-finances', openFin);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('hq-open-title', openTitle);
      window.removeEventListener('hq-open-finances', openFin);
      window.removeEventListener('keydown', onKey);
    };
  }, [owner]);
  return (
    <>
      <RevenuePops />
      {finances && <FinancesModal world={world} onClose={() => setFinances(false)} />}
      {title && owner && <StartScreen current={world.office} onContinue={() => setTitle(false)} />}
    </>
  );
}
