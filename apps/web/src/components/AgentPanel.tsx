import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Approval, ID, Snapshot, TranscriptEntry } from '@agent-hq/protocol';
import { COORDINATOR, levelProgress, modelLabel, STATUS_ICON, STATUS_LABEL } from '../agentUtil.ts';
import { client, run, useClient } from '../api.ts';
import { ago, initials, int, humanize, stamp, toolFields, toolLabel } from '../format.ts';
import { AgentModal, PERMISSION_MODES } from './forms.tsx';

/** The recognizable parts of a tool call (command, file…), then the raw input on demand. */
function ToolInput({ input }: { input: unknown }) {
  const fields = toolFields(input);
  const raw = JSON.stringify(input, null, 2);
  return (
    <>
      {fields.length > 0 && (
        <dl className="kv">
          {fields.map((f) => <div key={f.label}><dt>{f.label}</dt><dd><code>{f.value}</code></dd></div>)}
        </dl>
      )}
      {raw && raw !== '{}' && (fields.length ? <details className="raw"><summary>Full input</summary><pre>{raw}</pre></details> : <pre>{raw}</pre>)}
    </>
  );
}

function ApprovalCard({ approval, canResolve }: { approval: Approval; canResolve: boolean }) {
  const resolve = (decision: 'allow' | 'deny', always = false) =>
    run('resolve_approval', { id: approval.id, decision, always }).catch(() => {});
  return (
    <div className="approval" role="group" aria-label="Approval request">
      <div className="approval-title">
        <span className="bounce" aria-hidden>✋</span> Wants to use <strong>{toolLabel(approval.toolName)}</strong>
        <span className="spacer" />
        <span className="muted small-text" title={stamp(approval.createdAt)}>{ago(approval.createdAt)}</span>
      </div>
      {approval.description && <div className="muted">{approval.description}</div>}
      <ToolInput input={approval.input} />
      {canResolve ? (
        <div className="row">
          <button onClick={() => resolve('allow')}>✓ Allow</button>
          {approval.canAlwaysAllow && <button className="ghost" onClick={() => resolve('allow', true)} title={`Don't ask again for ${toolLabel(approval.toolName)}`}>Always allow</button>}
          <span className="spacer" />
          <button className="ghost danger" onClick={() => resolve('deny')}>✕ Deny</button>
        </div>
      ) : (
        <p className="hint">Only this agent's owner can approve.</p>
      )}
    </div>
  );
}

/** Click or Enter/Space toggles an expandable log line. */
const toggleable = (open: boolean, setOpen: (v: boolean) => void) => ({
  role: 'button',
  tabIndex: 0,
  'aria-expanded': open,
  onClick: () => setOpen(!open),
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); }
  },
});

function Entry({ e }: { e: TranscriptEntry }) {
  const [open, setOpen] = useState(false);
  const when = stamp(e.ts);
  switch (e.kind) {
    case 'user':
      return <div className="msg user" title={when}><span className="who">{String(e.meta?.authorName ?? 'You')} · {ago(e.ts)}</span>{e.text}</div>;
    case 'text':
      return <div className={`msg agent ${e.meta?.subagent ? 'sub' : ''}`} title={when}>{e.text}</div>;
    case 'thinking':
      return <div className="msg thinking" title={when}>💭 {e.text}</div>;
    case 'tool_use':
      return (
        <div className="msg tool" title={when} {...toggleable(open, setOpen)}>
          <div className="tool-line">
            <span className="caret" aria-hidden>{open ? '▾' : '▸'}</span>
            <span className="tool-name">{toolLabel(String(e.meta?.tool ?? 'tool'))}</span>
            <span className="tool-summary">{humanize(e.text)}</span>
          </div>
          {open && <div onClick={(ev) => ev.stopPropagation()}><ToolInput input={e.meta?.input} /></div>}
        </div>
      );
    case 'tool_result': {
      const first = e.text.split('\n')[0].slice(0, 120);
      return (
        <div className={`msg tool-result ${e.meta?.isError ? 'err' : ''}`} title={when} {...toggleable(open, setOpen)}>
          {open
            ? <pre onClick={(ev) => ev.stopPropagation()}>{e.text || '(empty result)'}</pre>
            : <span>{e.meta?.isError ? '✕ ' : '↳ '}{first || 'No output'}</span>}
        </div>
      );
    }
    case 'error':
      return <div className="msg error" title={when}>⚠️ {e.text}</div>;
    case 'result':
    case 'system':
      return <div className="msg system" title={when}><span>{e.text}</span></div>;
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
  const xp = levelProgress(agent.xp);
  const permission = PERMISSION_MODES.find((m) => m.value === agent.permissionMode)?.label ?? agent.permissionMode;
  const integrations = agent.integrations.map((id) => props.world.settings.integrations.find((i) => i.id === id)?.name ?? id);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    await run('send_message', { agentId: props.agentId, text });
    setText('');
  }

  return (
    <aside className="panel" aria-label={`${agent.name}: history and settings`}>
      <header className="panel-head">
        <span className="avatar large" style={{ background: agent.appearance.shirt }} aria-hidden>{initials(agent.name)}</span>
        <div className="panel-title">
          <h2>
            {agent.name}
            {agent.isManager && <span className="badge" title={COORDINATOR.help}>★ {COORDINATOR.label}</span>}
          </h2>
          <div className="muted">{agent.role}</div>
          <span className={`pill status-${agent.status}`}>{STATUS_ICON[agent.status]} {STATUS_LABEL[agent.status]}</span>
        </div>
        <button className="icon-btn close" onClick={props.onClose} aria-label="Close" title="Close">✕</button>
      </header>

      {props.world.settings.gamification && (
        <div className="xp" title={`${int(agent.xp)} XP · ${int(xp.toNext)} XP to level ${xp.level + 1}`}>
          <span className="xp-level">Lv {xp.level}</span>
          <div className="bar"><div style={{ width: `${Math.round(xp.progress * 100)}%` }} /></div>
          <span className="muted small-text">{int(xp.toNext)} XP to Lv {xp.level + 1}</span>
        </div>
      )}

      <dl className="facts">
        {agent.activity && running && <div><dt>Now</dt><dd>{humanize(agent.activity)}</dd></div>}
        <div>
          <dt>Task</dt>
          <dd>
            {task ? <>{task.title}{task.branch && <code className="branch" title={`Branch ${task.branch}`}>{task.branch}</code>}</> : <span className="muted">No task: free to chat</span>}
          </dd>
        </div>
        <div><dt>Model</dt><dd>{agent.model ? modelLabel(agent.model) : <span className="muted">Default (account setting)</span>}</dd></div>
        <div><dt>Permissions</dt><dd>{permission}</dd></div>
        <div>
          <dt>Tools</dt>
          <dd>
            {integrations.length
              ? <span className="chips">{integrations.map((name) => <span key={name} className="chip tiny">🔌 {name}</span>)}</span>
              : <span className="muted">No integrations</span>}
          </dd>
        </div>
        {!mine && <div><dt>Owner</dt><dd>{owner?.name ?? 'Unknown'} <span className="muted">· runs on their machine</span></dd></div>}
      </dl>

      {(mine || canFire) && (
        <div className="panel-actions">
          {mine && <button className="ghost small" onClick={() => setEditing(true)}>✎ Edit</button>}
          <span className="spacer" />
          {canFire && (
            <button className="ghost danger small" onClick={() => { if (window.confirm(`Fire ${agent.name}?`)) run('fire_agent', { id: agent.id }).then(props.onClose).catch(() => {}); }}>
              Fire
            </button>
          )}
        </div>
      )}

      <div className="log" ref={logRef}>
        <h3 className="log-title">Activity</h3>
        {!entries && <p className="muted">Loading…</p>}
        {entries?.length === 0 && <p className="empty">No activity yet. Say hi, or give {agent.name} a task from the board.</p>}
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
            {running && <button type="button" className="ghost small" onClick={() => run('interrupt_agent', { agentId: agent.id }).catch(() => {})}>■ Interrupt</button>}
            <span className="hint">Enter to send · Shift+Enter for a new line</span>
            <span className="spacer" />
            <button type="submit" disabled={!text.trim()}>Send</button>
          </div>
        </form>
      ) : (
        <p className="composer hint">You're watching {owner?.name}'s agent. Assign it work through the board.</p>
      )}

      {editing && <AgentModal world={props.world} floorId={agent.floorId} agent={agent} onClose={() => setEditing(false)} />}
    </aside>
  );
}
