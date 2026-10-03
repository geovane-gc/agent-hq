import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Approval, ID, Snapshot, TranscriptEntry } from '@agent-hq/protocol';
import { level, STATUS_LABEL } from '../agentUtil.ts';
import { client, run, useClient } from '../api.ts';
import { AgentModal } from './forms.tsx';

function ApprovalCard({ approval, canResolve }: { approval: Approval; canResolve: boolean }) {
  const resolve = (decision: 'allow' | 'deny', always = false) =>
    run('resolve_approval', { id: approval.id, decision, always }).catch(() => {});
  return (
    <div className="approval">
      <div className="approval-title">✋ Wants to use <strong>{approval.toolName}</strong></div>
      {approval.description && <div className="muted">{approval.description}</div>}
      <pre>{JSON.stringify(approval.input, null, 2)}</pre>
      {canResolve ? (
        <div className="row">
          <button onClick={() => resolve('allow')}>Allow</button>
          {approval.canAlwaysAllow && <button className="ghost" onClick={() => resolve('allow', true)}>Always allow</button>}
          <button className="danger" onClick={() => resolve('deny')}>Deny</button>
        </div>
      ) : (
        <p className="hint">Only the player whose Claude account runs this agent can approve.</p>
      )}
    </div>
  );
}

function Entry({ e }: { e: TranscriptEntry }) {
  const [open, setOpen] = useState(false);
  switch (e.kind) {
    case 'user':
      return <div className="msg user"><span className="who">{String(e.meta?.authorName ?? 'You')}</span>{e.text}</div>;
    case 'text':
      return <div className={`msg agent ${e.meta?.subagent ? 'sub' : ''}`}>{e.text}</div>;
    case 'thinking':
      return <div className="msg thinking">{e.text}</div>;
    case 'tool_use':
      return (
        <div className="msg tool" onClick={() => setOpen(!open)}>
          <span className="tool-name">{String(e.meta?.tool ?? 'tool')}</span> {e.text}
          {open && <pre>{JSON.stringify(e.meta?.input, null, 2)}</pre>}
        </div>
      );
    case 'tool_result':
      return (
        <div className={`msg tool-result ${e.meta?.isError ? 'err' : ''}`} onClick={() => setOpen(!open)}>
          {open ? <pre>{e.text}</pre> : <span className="muted">↳ {e.text.split('\n')[0].slice(0, 120) || '(empty result)'}</span>}
        </div>
      );
    case 'error':
      return <div className="msg error">{e.text}</div>;
    case 'result':
    case 'system':
      return <div className="msg system">{e.text}</div>;
  }
}

export function AgentPanel(props: { world: Snapshot; agentId: ID; onClose: () => void }) {
  const { transcripts } = useClient();
  const agent = props.world.agents.find((a) => a.id === props.agentId);
  const entries = transcripts[props.agentId];
  const approvals = props.world.approvals.filter((a) => a.agentId === props.agentId);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!entries) client.loadTranscript(props.agentId).catch(() => {});
  }, [props.agentId, entries]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries?.length, approvals.length]);

  if (!agent) return null;
  const task = agent.currentTaskId ? props.world.tasks.find((t) => t.id === agent.currentTaskId) : undefined;
  const running = agent.status === 'working' || agent.status === 'awaiting_approval';
  const mine = agent.ownerId === props.world.you.id;
  const owner = props.world.users.find((u) => u.id === agent.ownerId);
  const canFire = mine || props.world.you.role === 'owner';

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    await run('send_message', { agentId: props.agentId, text });
    setText('');
  }

  return (
    <aside className="panel">
      <header className="panel-head">
        <div>
          <h2>{agent.name}{agent.isManager ? ' ★' : ''}</h2>
          <div className="muted">
            {agent.role}{props.world.settings.gamification && <> · Lv {level(agent.xp)} ({agent.xp} XP)</>} · <span className={`pill status-${agent.status}`}>{agent.status === 'offline' ? 'Offline' : STATUS_LABEL[agent.status]}</span>
          </div>
          {!mine && <div className="muted">Works for {owner?.name ?? '?'}</div>}
          {task && <div className="muted">Task: {task.title}{task.branch && <> · <code>{task.branch}</code></>}</div>}
        </div>
        <button className="ghost" onClick={props.onClose} aria-label="Close">✕</button>
      </header>

      <div className="panel-settings">
        {mine && <button className="ghost small" onClick={() => setEditing(true)}>Edit</button>}
        <span className="muted small-text">
          {agent.integrations.length ? `🔌 ${agent.integrations.join(', ')}` : 'No integrations'}
        </span>
        <span className="spacer" />
        {canFire && (
          <button className="ghost danger small" onClick={() => { if (window.confirm(`Fire ${agent.name}?`)) run('fire_agent', { id: agent.id }).then(props.onClose).catch(() => {}); }}>
            Fire
          </button>
        )}
      </div>

      <div className="log" ref={logRef}>
        {!entries && <p className="muted">Loading…</p>}
        {entries?.length === 0 && <p className="muted">No activity yet. Say hi, or give {agent.name} a task from the board.</p>}
        {entries?.map((e) => <Entry key={e.id} e={e} />)}
        {approvals.map((a) => <ApprovalCard key={a.id} approval={a} canResolve={mine} />)}
      </div>

      {mine ? (
        <form className="composer" onSubmit={send}>
          <textarea
            value={text}
            rows={3}
            placeholder={`Message ${agent.name}…`}
            disabled={agent.status === 'offline'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e); } }}
          />
          <div className="row">
            {running && <button type="button" className="ghost" onClick={() => run('interrupt_agent', { agentId: agent.id }).catch(() => {})}>Interrupt</button>}
            <span className="spacer" />
            <button type="submit" disabled={!text.trim()}>Send</button>
          </div>
        </form>
      ) : (
        <p className="composer hint">
          You're watching {owner?.name}'s agent: it runs on their Claude account, so only they can message it. Assign it work
          through the board, or take it over from its computer to continue on your own account.
        </p>
      )}

      {editing && <AgentModal world={props.world} floorId={agent.floorId} agent={agent} onClose={() => setEditing(false)} />}
    </aside>
  );
}
