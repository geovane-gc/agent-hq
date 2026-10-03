import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ID, Snapshot } from '@agent-hq/protocol';
import { level, STATUS_LABEL } from '../agentUtil.ts';
import { client, run } from '../api.ts';
import { AccountBadge, AccountsModal, AccountSwitcher, runsFor, TakeOverButton } from './Accounts.tsx';

/**
 * An agent's real Claude Code terminal, shown as if you zoomed into their
 * monitor. The player whose Claude account runs it types straight into it;
 * teammates watch read-only, or take the work over onto their own account.
 */
export function AgentTerminal(props: {
  world: Snapshot;
  agentId: ID;
  onClose: () => void;
  onNewTask: () => void;
  onDetails: () => void;
  /** The agent runs headless on its machine: fall back to the chat panel. */
  onChatOnly: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [canType, setCanType] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'accounts' | null>(null);
  const agent = props.world.agents.find((a) => a.id === props.agentId);
  const task = agent?.currentTaskId ? props.world.tasks.find((t) => t.id === agent.currentTaskId) : undefined;

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "'Cascadia Code', 'Cascadia Mono', Menlo, Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.1,
      scrollback: 5000,
      theme: { background: '#0d1017', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#33415588' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();

    const agentId = props.agentId;
    const onData = (e: Event) => term.write((e as CustomEvent<string>).detail);
    client.agentTerminals.addEventListener(agentId, onData);
    let mine = false;
    client.request('agent_terminal_open', { agentId, cols: term.cols, rows: term.rows }).then((res) => {
      if (!res.interactive) {
        props.onChatOnly();
        return;
      }
      mine = res.canType;
      setCanType(res.canType);
      if (res.history) term.write(res.history);
      term.focus();
    }).catch((err) => setError(err.message));

    const input = term.onData((data) => {
      if (mine) client.request('agent_terminal_input', { agentId, data }).catch((err) => setError(err.message));
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (mine) client.request('agent_terminal_resize', { agentId, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    observer.observe(host.current!);

    return () => {
      observer.disconnect();
      input.dispose();
      client.agentTerminals.removeEventListener(agentId, onData);
      client.request('agent_terminal_close', { agentId }).catch(() => {});
      term.dispose();
    };
    // Reopen when the agent changes hands or accounts: the server restarts its session there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[props.agentId, agent?.ownerId, agent?.accountId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc belongs to Claude Code (it interrupts); leave with Alt+Q or the button.
      if (e.altKey && e.key.toLowerCase() === 'q') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  if (!agent) return null;
  const mine = agent.ownerId === props.world.you.id;
  const ownerName = props.world.users.find((u) => u.id === agent.ownerId)?.name ?? 'their owner';
  const key = (data: string) => run('agent_terminal_input', { agentId: agent.id, data }).catch(() => {});

  return (
    <div className="monitor-overlay">
      <div className="monitor">
        <header className="monitor-bar">
          <button className="ghost small" onClick={props.onClose} title="Back to the office (Alt+Q)">← Office</button>
          <div className="monitor-title">
            <strong>{agent.name}</strong>{agent.isManager ? ' ★' : ''}
            <span className="muted"> · {agent.role}{props.world.settings.gamification ? ` · Lv ${level(agent.xp)}` : ''}</span>
            <span className={`pill status-${agent.status}`}>{STATUS_LABEL[agent.status]}</span>
            {task && <span className="muted small-text"> · {task.title}{task.branch ? ` (${task.branch})` : ''}</span>}
          </div>
          <AccountBadge world={props.world} agent={agent} />
          {mine
            ? <AccountSwitcher world={props.world} agent={agent} onConnect={() => setDialog('accounts')} />
            : <TakeOverButton world={props.world} agent={agent} />}
          <span className="spacer" />
          {agent.status === 'awaiting_approval' && canType && (
            <>
              <button className="small" onClick={() => key('\r')}>✓ Approve</button>
              <button className="small danger" onClick={() => key('\x1b')}>✕ Deny</button>
            </>
          )}
          {agent.status === 'working' && canType && <button className="small ghost" onClick={() => key('\x1b')}>■ Interrupt</button>}
          {runsFor(props.world, agent) === props.world.you.id && <button className="small" onClick={props.onNewTask}>＋ Task</button>}
          <button className="small ghost" onClick={props.onDetails}>History & settings</button>
        </header>
        {error && <div className="monitor-error">{error}</div>}
        {!canType && !error && (
          <div className="monitor-note">
            Watching {agent.name}'s screen. It runs on {ownerName}'s Claude account, so only they can type here.
            {!mine && ' Use Take over to continue this work on your own account.'}
          </div>
        )}
        <div className="monitor-screen" ref={host} />
        <footer className="monitor-foot muted small-text">
          {canType
            ? <>Type to talk to {agent.name} — this is the real Claude Code session. Esc interrupts · Alt+Q goes back to the office.</>
            : <>Read-only view of {agent.name}'s Claude Code session · Alt+Q goes back to the office.</>}
        </footer>
      </div>
      {dialog === 'accounts' && <AccountsModal world={props.world} connectFirst onClose={() => setDialog(null)} />}
    </div>
  );
}
