import type { ID, Snapshot, Task, TaskStatus } from '@agent-hq/protocol';
import { STATUS_ICON, STATUS_LABEL } from '../agentUtil.ts';
import { run } from '../api.ts';
import { ago, stamp } from '../format.ts';

const COLUMNS: Array<{ status: TaskStatus; label: string; empty: string }> = [
  { status: 'todo', label: 'To do', empty: 'Nothing queued. Add a task to give the team work.' },
  { status: 'in_progress', label: 'In progress', empty: 'Nobody is working on a task.' },
  { status: 'review', label: 'Review', empty: 'Finished work waits here for you.' },
  { status: 'done', label: 'Done', empty: 'Nothing shipped yet.' },
  { status: 'failed', label: 'Failed', empty: '' },
];

function TaskCard(props: { task: Task; world: Snapshot; onOpenAgent: (id: ID) => void }) {
  const { task, world } = props;
  const project = world.projects.find((p) => p.id === task.projectId);
  const assignee = world.agents.find((a) => a.id === task.assigneeId);
  const setStatus = (status: TaskStatus) => run('update_task', { id: task.id, patch: { status } }).catch(() => {});

  return (
    <article className={`card task-${task.status}`}>
      <div className="card-title">{task.title}</div>
      <div className="card-meta">
        {project && <span className="chip tiny">{project.name}</span>}
        <span title={`Updated ${stamp(task.updatedAt)}`}>{ago(task.updatedAt)}</span>
      </div>
      {task.description && <p className="card-desc" title={task.description}>{task.description}</p>}
      {task.branch && <code className="branch" title={`Branch ${task.branch}`}>{task.branch}</code>}
      <div className="card-actions">
        {task.status === 'in_progress' || task.status === 'review' ? (
          assignee && (
            <button className="assignee" onClick={() => props.onOpenAgent(assignee.id)} title={`${STATUS_LABEL[assignee.status]}: open ${assignee.name}'s computer`}>
              <span aria-hidden>{STATUS_ICON[assignee.status]}</span> {assignee.name}
            </button>
          )
        ) : task.status !== 'done' ? (
          <select
            aria-label="Assignee"
            value={task.assigneeId ?? ''}
            onChange={(e) => e.target.value && run('assign_task', { taskId: task.id, agentId: e.target.value }).catch(() => {})}
          >
            <option value="">{world.settings.dispatchMode === 'auto' ? 'Auto-assign' : 'Assign…'}</option>
            {world.agents.filter((a) => a.kind !== 'repo').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        ) : (
          assignee && <span className="muted small-text">by {assignee.name}</span>
        )}
        <span className="spacer" />
        {task.status === 'review' && <button className="small" onClick={() => setStatus('done')} title="Accept the work and clean up the worktree (the branch is kept)">✓ Done</button>}
        {(task.status === 'failed' || task.status === 'done') && <button className="small ghost" onClick={() => setStatus('todo')}>↺ Reopen</button>}
        {task.status !== 'in_progress' && task.status !== 'done' && (
          <button className="icon-btn danger" aria-label={`Delete ${task.title}`} title="Delete task" onClick={() => run('remove_task', { id: task.id }).catch(() => {})}>🗑</button>
        )}
      </div>
    </article>
  );
}

export function Board(props: { world: Snapshot; projectIds: ID[]; onNewTask: () => void; onNewProject: (() => void) | null; onOpenAgent: (id: ID) => void }) {
  const { world } = props;
  const tasks = world.tasks.filter((t) => props.projectIds.includes(t.projectId)).sort((a, b) => b.updatedAt - a.updatedAt);
  const projects = world.projects.filter((p) => props.projectIds.includes(p.id));
  // "Failed" only earns a column when something actually failed.
  const columns = COLUMNS.filter((c) => c.status !== 'failed' || tasks.some((t) => t.status === 'failed'));
  const auto = world.settings.dispatchMode === 'auto';
  return (
    <>
      <div className="board-bar">
        <span className="eyebrow">Projects</span>
        {projects.map((p) => (
          <span key={p.id} className="chip" title={`${p.repoPath}${p.git ? '' : '\nNot a git repository: agents share this folder'}`}>
            <span aria-hidden>{p.git ? '📦' : '📁'}</span> {p.name}
          </span>
        ))}
        {projects.length === 0 && <span className="muted small-text">None yet</span>}
        {props.onNewProject && <button className="chip add" onClick={props.onNewProject}>＋ Project</button>}
        <span className="spacer" />
        <span
          className={`pill ${auto ? 'status-working' : ''}`}
          title={auto ? 'Idle agents on this floor pick up unassigned To do tasks. Change it in Settings.' : 'Assign each task to an agent to start it. Change it in Settings.'}
        >
          {auto ? '⚡ Auto-dispatch on' : 'Manual dispatch'}
        </span>
        <button onClick={props.onNewTask}>＋ New task</button>
      </div>
      <div className="board" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(200px, 1fr))` }}>
        {columns.map((col) => {
          const list = tasks.filter((t) => t.status === col.status);
          return (
            <section key={col.status} className={`column col-${col.status}`} aria-label={col.label}>
              <header>
                <span className="col-dot" />
                <h3>{col.label}</h3>
                <span className="count">{list.length}</span>
              </header>
              {list.length === 0 && <p className="column-empty">{col.empty}</p>}
              {list.map((t) => <TaskCard key={t.id} task={t} world={world} onOpenAgent={props.onOpenAgent} />)}
            </section>
          );
        })}
      </div>
    </>
  );
}
