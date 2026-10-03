import type { ID, Project, RunnerSessionEvent, RunnerStart, Task } from '@agent-hq/protocol';
import type { AccountRemoval, AccountStatus } from '../accounts.ts';
import type { PermissionDecision } from '../adapters/adapter.ts';
import type { HandoffResult } from '../git.ts';

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
  /** `claude auth status` of each Claude config dir on this machine (null = default login). */
  accountStatus(configDirs: Array<string | null>): Promise<AccountStatus[]>;
  /** `claude auth login` for an account's config dir, as a terminal ('pty' events, then 'exit'). */
  accountLogin(key: string, configDir: string, onEvent: (e: RunnerSessionEvent) => void): RunnerSession;
  /** Logs an account out (when its email checks out) and deletes its config dir on this machine. */
  accountRemove(configDir: string, email: string | null): Promise<AccountRemoval>;
  /** Commits the task's uncommitted work and pushes its branch, before someone else takes it over. */
  handoff(project: Project, task: Task): Promise<HandoffResult>;
}
