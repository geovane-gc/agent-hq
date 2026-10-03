import type { ID, Snapshot, Task, TaskStatus } from '@agent-hq/protocol';
import { run } from '../api.ts';

const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
  { status: 'todo', label: 'To do' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'review', label: 'Review' },
  { status: 'done', label: 'Done' },
  { status: 'failed', label: 'Failed' },
];

function TaskCard(props: { task: Task; world: Snapshot; onOpenAgent: (id: ID) => void }) {
  const { task, world } = props;
  const project = world.projects.find((p) => p.id === task.projectId);
  const assignee = world.agents.find((a) => a.id === task.assigneeId);
  const setStatus = (status: TaskStatus) => run('update_task', { id: task.id, patch: { status } }).catch(() => {});

  return (
    <div className="card">
      <div className="card-title">{task.title}</div>
      <div className="card-meta">
        {project?.name}
        {task.branch && <> · <code>{task.branch}</code></>}
      </div>
      {task.description && <p className="card-desc">{task.description}</p>}
      <div className="card-actions">
        {task.status === 'in_progress' || task.status === 'review' ? (
          assignee && <button className="link" onClick={() => props.onOpenAgent(assignee.id)}>{assignee.name}</button>
        ) : task.status !== 'done' ? (
          <select
            value={task.assigneeId ?? ''}
            onChange={(e) => e.target.value && run('assign_task', { taskId: task.id, agentId: e.target.value }).catch(() => {})}
          >
            <option value="">{world.settings.dispatchMode === 'auto' ? 'Auto-assign' : 'Assign…'}</option>
            {world.agents.filter((a) => a.kind !== 'repo').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        ) : (
          assignee && <span className="muted">{assignee.name}</span>
        )}
        <span className="spacer" />
        {task.status === 'review' && <button className="small" onClick={() => setStatus('done')}>Done</button>}
        {(task.status === 'failed' || task.status === 'done') && <button className="small ghost" onClick={() => setStatus('todo')}>Reopen</button>}
        {task.status !== 'in_progress' && task.status !== 'done' && (
          <button className="small ghost" title="Delete" onClick={() => run('remove_task', { id: task.id }).catch(() => {})}>🗑</button>
        )}
      </div>
    </div>
  );
}

export function Board(props: { world: Snapshot; projectIds: ID[]; onNewTask: () => void; onOpenAgent: (id: ID) => void }) {
  const tasks = props.world.tasks.filter((t) => props.projectIds.includes(t.projectId)).sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="board">
      {COLUMNS.map((col) => (
        <section key={col.status} className="column">
          <header>
            <h3>{col.label}</h3>
            <span className="count">{tasks.filter((t) => t.status === col.status).length}</span>
            {col.status === 'todo' && (
              <button className="small" onClick={props.onNewTask}>+ Task</button>
            )}
          </header>
          {tasks.filter((t) => t.status === col.status).map((t) => (
            <TaskCard key={t.id} task={t} world={props.world} onOpenAgent={props.onOpenAgent} />
          ))}
        </section>
      ))}
    </div>
  );
}
