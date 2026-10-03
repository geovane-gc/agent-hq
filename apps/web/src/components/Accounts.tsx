import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Agent, ClaudeAccount, ID, Snapshot } from '@agent-hq/protocol';
import { client, run } from '../api.ts';
import { notify } from '../notify.ts';
import { Modal } from './Modal.tsx';

// Claude accounts: each player connects their own logins (one Claude Code
// config dir each) on their own machine. Agents run on one of their owner's
// accounts; only that account's player can type into them.

/** The account an agent runs on: the one it picked, or its owner's default login. */
export function accountOf(world: Snapshot, agent: Agent): ClaudeAccount | undefined {
  const picked = agent.accountId ? world.accounts.find((a) => a.id === agent.accountId) : undefined;
  return picked?.userId === agent.ownerId ? picked : world.accounts.find((a) => a.userId === agent.ownerId && a.configDir === null);
}

/** The player whose Claude account runs an agent: the only one who may type into it or give it work. */
export function runsFor(world: Snapshot, agent: Agent): ID {
  return accountOf(world, agent)?.userId ?? agent.ownerId;
}

/** Why you can't hand this agent board work (null: you can). */
export function assignBlocked(world: Snapshot, agent: Agent): string | null {
  const owner = runsFor(world, agent);
  if (owner === world.you.id) return null;
  const name = world.users.find((u) => u.id === owner)?.name ?? 'another player';
  return `${agent.name} runs on ${name}'s Claude account. Take it over from its computer to give it work.`;
}

export function planLabel(plan: string | null): string {
  if (!plan) return '';
  return plan === 'api' ? 'API' : plan.charAt(0).toUpperCase() + plan.slice(1);
}

function accountText(account: ClaudeAccount | undefined): string {
  if (!account) return 'Default login';
  if (!account.checkedAt) return `${account.label} (checking…)`;
  if (!account.loggedIn) return `${account.label} (not logged in)`;
  return account.email ?? account.label;
}

/** Email · plan · player, shown on every employee's monitor. */
export function AccountBadge({ world, agent }: { world: Snapshot; agent: Agent }) {
  const account = accountOf(world, agent);
  const owner = world.users.find((u) => u.id === agent.ownerId);
  return (
    <span className="account-badge" title={`Claude Code runs on ${owner?.name ?? '?'}'s account${account?.configDir ? ` (${account.label})` : ' (default login)'}`}>
      🔑 {accountText(account)}
      {account?.plan && <span className="plan">{planLabel(account.plan)}</span>}
      <span className="muted">· {owner?.id === world.you.id ? 'you' : owner?.name ?? '?'}</span>
    </span>
  );
}

/** Which of your accounts your employee runs on. Switching restarts (and resumes) its session there. */
export function AccountSwitcher({ world, agent, onConnect }: { world: Snapshot; agent: Agent; onConnect: () => void }) {
  const mine = world.accounts.filter((a) => a.userId === world.you.id);
  const current = accountOf(world, agent);
  return (
    <select
      className="account-switch small"
      value={current?.id ?? ''}
      title="Claude account this employee runs on"
      onChange={(e) => {
        if (e.target.value === '+') { onConnect(); return; }
        const next = mine.find((a) => a.id === e.target.value);
        if (agent.live && !window.confirm(`Restart ${agent.name}'s session on ${next ? accountText(next) : 'that account'}? It resumes where it was.`)) return;
        run('set_agent_account', { agentId: agent.id, accountId: next?.configDir === null ? null : e.target.value }).catch(() => {});
      }}
    >
      {mine.map((a) => (
        <option key={a.id} value={a.id} disabled={a.configDir !== null && !a.loggedIn}>
          {accountText(a)}{a.plan ? ` · ${planLabel(a.plan)}` : ''}
        </option>
      ))}
      <option value="+">＋ Connect another account…</option>
    </select>
  );
}

/** "Take over": move another player's employee, its task and branch onto your machine and account. */
export function TakeOverModal({ world, agent, onClose }: { world: Snapshot; agent: Agent; onClose: () => void }) {
  const mine = world.accounts.filter((a) => a.userId === world.you.id && (a.configDir === null || a.loggedIn));
  const [accountId, setAccountId] = useState<ID>(mine.find((a) => a.configDir === null)?.id ?? mine[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = world.users.find((u) => u.id === agent.ownerId);
  const task = agent.currentTaskId ? world.tasks.find((t) => t.id === agent.currentTaskId) : undefined;
  const chosen = mine.find((a) => a.id === accountId);
  const approval = world.settings.takeoverPolicy === 'approval';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await client.request('take_over_agent', { agentId: agent.id, accountId: chosen && chosen.configDir !== null ? chosen.id : null });
      if (res.request) notify({ icon: '⇄', title: 'Takeover', text: `Asked ${owner?.name ?? 'the owner'} to approve. You'll be told when they decide.` });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`⇄ Take over ${agent.name}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="hint">
          {agent.name} runs on {owner?.name ?? 'a teammate'}'s Claude account, and accounts are personal: you can watch, not type.
          Taking over moves the work to <strong>your</strong> machine and subscription:
        </p>
        <ul className="hint">
          <li>The session on {owner?.name ?? 'their'}'s machine stops.</li>
          {task?.branch
            ? <li>Uncommitted work on <code>{task.branch}</code> is committed as WIP and pushed to origin, then checked out on your machine.</li>
            : <li>{task ? 'The task has no branch yet; it starts fresh on your machine.' : `${agent.name} has no task right now; only the employee moves.`}</li>}
          {task && <li>A new session on your account continues "{task.title}" from a summary of what was done.</li>}
          {agent.kind === 'repo' && <li>Its report for this run comes to your inbox.</li>}
          <li>{agent.name} then works for you.</li>
        </ul>
        {approval && <p className="hint">The boss requires approval: {owner?.name ?? 'the owner'} gets your request and decides. It waits while they're away, and you can cancel it.</p>}
        {mine.length > 1 && (
          <label>Run on
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {mine.map((a) => <option key={a.id} value={a.id}>{accountText(a)}{a.plan ? ` · ${planLabel(a.plan)}` : ''}</option>)}
            </select>
          </label>
        )}
        {!world.you.runnerOnline && <p className="error">Your machine isn't connected. Start your runner first (Team tab).</p>}
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy || !world.you.runnerOnline}>{busy ? (approval ? 'Asking…' : 'Handing off…') : approval ? 'Ask to take over' : 'Take over'}</button>
        </footer>
      </form>
    </Modal>
  );
}

/** "Take over" on another player's monitor, or your pending request with a Cancel button. */
export function TakeOverButton({ world, agent }: { world: Snapshot; agent: Agent }) {
  const [open, setOpen] = useState(false);
  const pending = world.takeovers.find((t) => t.agentId === agent.id && t.requesterId === world.you.id && t.status === 'pending');
  const owner = world.users.find((u) => u.id === agent.ownerId);
  if (pending) {
    return (
      <span className="takeover-pending">
        ⏳ Waiting for {owner?.name ?? 'the owner'}{owner && !owner.online ? ' (offline)' : ''}
        <button className="small ghost" onClick={() => run('cancel_takeover', { id: pending.id }).catch(() => {})}>Cancel</button>
      </span>
    );
  }
  return (
    <>
      <button className="small" onClick={() => setOpen(true)} title="Continue this work on your own machine and Claude account">⇄ Take over</button>
      {open && <TakeOverModal world={world} agent={agent} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Takeover requests: ones you must decide (approve / deny) and your own pending ones (cancel). */
export function TakeoverAlerts({ world, onOpen }: { world: Snapshot; onOpen: (agentId: ID) => void }) {
  const mine = world.takeovers.filter((t) => t.status === 'pending' && (t.ownerId === world.you.id || t.requesterId === world.you.id));
  if (!mine.length) return null;
  const name = (id: ID) => world.users.find((u) => u.id === id)?.name ?? '?';
  return (
    <div className="takeover-alerts">
      {mine.map((t) => {
        const agent = world.agents.find((a) => a.id === t.agentId);
        const task = agent?.currentTaskId ? world.tasks.find((x) => x.id === agent.currentTaskId) : undefined;
        return t.ownerId === world.you.id ? (
          <div key={t.id} className="takeover-card">
            <span>⇄ <strong>{name(t.requesterId)}</strong> wants to take over <button className="link" onClick={() => onOpen(t.agentId)}>{agent?.name ?? 'an agent'}</button>{task ? ` (${task.title})` : ''} onto their own account.</span>
            <button className="small" onClick={() => run('respond_takeover', { id: t.id, approve: true }).catch(() => {})}>Approve</button>
            <button className="small danger" onClick={() => run('respond_takeover', { id: t.id, approve: false }).catch(() => {})}>Deny</button>
          </div>
        ) : (
          <div key={t.id} className="takeover-card mine">
            <span>⏳ Asked {name(t.ownerId)} to take over {agent?.name ?? 'an agent'}{world.users.find((u) => u.id === t.ownerId)?.online ? '' : ' (they are offline)'}</span>
            <button className="small ghost" onClick={() => run('cancel_takeover', { id: t.id }).catch(() => {})}>Cancel</button>
          </div>
        );
      })}
    </div>
  );
}

/** The `claude auth login` terminal of one of your accounts, running on your machine. */
function LoginTerminal({ accountId }: { accountId: ID }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "'Cascadia Code', Menlo, Consolas, monospace",
      fontSize: 13,
      theme: { background: '#0f1117', foreground: '#d8dee9' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();
    term.write(client.loginHistory.get(accountId) ?? '');
    term.focus();
    const onData = (e: Event) => term.write((e as CustomEvent<string>).detail);
    client.accountLogins.addEventListener(accountId, onData);
    const input = term.onData((data) => { client.request('account_login_input', { accountId, data }).catch(() => {}); });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current!);
    return () => {
      observer.disconnect();
      input.dispose();
      client.accountLogins.removeEventListener(accountId, onData);
      term.dispose();
    };
  }, [accountId]);
  return <div className="terminal" ref={host} />;
}

/** Your Claude accounts (connect, re-check, remove), and which accounts your teammates use. */
export function AccountsPanel({ world, connectFirst = false }: { world: Snapshot; connectFirst?: boolean }) {
  const mine = world.accounts.filter((a) => a.userId === world.you.id);
  const others = world.accounts.filter((a) => a.userId !== world.you.id && (a.loggedIn || a.configDir !== null));
  const [loginId, setLoginId] = useState<ID | null>(null);
  const [label, setLabel] = useState('');
  const [adding, setAdding] = useState(connectFirst);
  const [busy, setBusy] = useState(false);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const account = await run('add_account', { label: label.trim() || 'Claude account' });
      setLoginId(account.id);
      setAdding(false);
      setLabel('');
    } catch {} finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      <p className="hint">
        Each employee runs Claude Code on one of its owner's Claude accounts. Connect more logins (one Claude Code config dir
        each) to spread work across subscriptions. Logins stay on your machine; Agent HQ only sees the email and plan.
      </p>
      <ul className="people">
        {mine.map((a) => (
          <li key={a.id}>
            <strong>{a.label}</strong>
            <span className="muted">
              {a.checkedAt ? (a.loggedIn ? `${a.email ?? 'logged in'}${a.plan ? ` · ${planLabel(a.plan)}` : ''}` : 'not logged in') : 'checking…'}
            </span>
            {a.configDir && <code className="small-text">{a.configDir}</code>}
            <span className="spacer" />
            {a.configDir && <button className="small ghost" onClick={() => setLoginId(loginId === a.id ? null : a.id)}>{loginId === a.id ? 'Hide login' : 'Login terminal'}</button>}
            {a.configDir && (
              <button className="small ghost danger" onClick={() => {
                if (!window.confirm(`Remove ${a.label}? It is logged out on your machine, its config dir is deleted, and employees on it go back to your default login.`)) return;
                run('remove_account', { id: a.id }).then((r) => { if (r.warning) window.alert(`${a.label} was removed, but: ${r.warning}`); }).catch(() => {});
              }}>Remove</button>
            )}
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="ghost" onClick={() => run('refresh_accounts', {}).catch(() => {})}>↻ Re-check</button>
        {!adding && <button onClick={() => setAdding(true)} disabled={!world.you.runnerOnline}>＋ Connect account</button>}
      </div>
      {!world.you.runnerOnline && <p className="hint">Start your runner to manage the Claude accounts on your machine.</p>}
      {adding && (
        <form className="row" onSubmit={connect}>
          <input autoFocus value={label} placeholder="Name it, e.g. Work Max" onChange={(e) => setLabel(e.target.value)} />
          <button type="submit" disabled={busy}>{busy ? 'Starting…' : 'Log in'}</button>
          <button type="button" className="ghost" onClick={() => setAdding(false)}>Cancel</button>
        </form>
      )}
      {loginId && (
        <>
          <p className="hint">
            This is <code>claude auth login</code> running on your machine for that account. Follow it here (open the link, paste
            the code back). The account updates when it finishes.
          </p>
          <LoginTerminal key={loginId} accountId={loginId} />
        </>
      )}
      {others.length > 0 && (
        <>
          <h3>Teammates' accounts</h3>
          <ul className="people">
            {others.map((a) => (
              <li key={a.id}>
                <strong>{world.users.find((u) => u.id === a.userId)?.name ?? '?'}</strong>
                <span className="muted">{a.loggedIn ? `${a.email ?? a.label}${a.plan ? ` · ${planLabel(a.plan)}` : ''}` : `${a.label} (not logged in)`}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function AccountsModal({ world, onClose, connectFirst }: { world: Snapshot; onClose: () => void; connectFirst?: boolean }) {
  return (
    <Modal title="🔑 Claude accounts" onClose={onClose} wide>
      <AccountsPanel world={world} connectFirst={connectFirst} />
    </Modal>
  );
}
