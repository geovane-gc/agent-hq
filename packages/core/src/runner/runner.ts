import type { ID, Project, RunnerSessionEvent, RunnerStart, Task } from '@agent-hq/protocol';
import type { PermissionDecision } from '../adapters/adapter.ts';
import type { RepoAgentDef } from '../repo-agents.ts';

// A runner executes agent sessions on one user's machine with that user's own
// Claude Code login. The host's owner uses an in-process LocalRunner; other
// players connect a RemoteRunner (see `agent-hq join`).

export interface RunnerSession {
  send(text: string): void;
  interrupt(): void;
  respondPermission(requestId: string, decision: PermissionDecision): void;
  /** Raw keystrokes into the agent's terminal. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): Promise<void>;
}

export interface Runner {
  readonly userId: ID;
  start(start: RunnerStart, onEvent: (e: RunnerSessionEvent) => void): RunnerSession;
  /** Removes the task's worktree if clean. Resolves true when it is gone. */
  cleanup(project: Project, task: Task): Promise<boolean>;
  /** The agents defined in `.claude/agents` of this machine's checkout of the project. */
  scanAgents(project: Project): Promise<RepoAgentDef[]>;
}
