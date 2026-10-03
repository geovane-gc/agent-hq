import { randomUUID } from 'node:crypto';
import type { HostToRunner, ID, Project, RunnerMessage, RunnerOp, RunnerSessionEvent, RunnerStart, Task } from '@agent-hq/protocol';
import type { AccountRemoval, AccountStatus } from '../accounts.ts';
import type { HandoffResult } from '../git.ts';
import type { RepoAgentDef } from '../repo-agents.ts';
import type { Runner, RunnerSession } from './runner.ts';

type Reply = Extract<RunnerMessage, { type: 'runner_reply' }>;

/**
 * Host-side proxy for a teammate's runner process. Operations go down the
 * runner's WebSocket; session events come back through `deliver`.
 */
export class RemoteRunner implements Runner {
  readonly userId: ID;
  private readonly sendOp: (msg: HostToRunner) => void;
  private readonly sessions = new Map<string, (e: RunnerSessionEvent) => void>();
  private readonly closing = new Map<string, () => void>();
  private readonly cleanups = new Map<string, (ok: boolean) => void>();
  /** Ops answered with a runner_reply, by requestKey. */
  private readonly requests = new Map<string, (reply: Reply) => void>();

  constructor(userId: ID, sendOp: (msg: HostToRunner) => void) {
    this.userId = userId;
    this.sendOp = sendOp;
  }

  private op(op: RunnerOp) {
    this.sendOp({ type: 'runner_op', op });
  }

  start(start: RunnerStart, onEvent: (e: RunnerSessionEvent) => void): RunnerSession {
    this.sessions.set(start.sessionKey, onEvent);
    this.op({ op: 'start', start });
    return this.remoteSession(start.sessionKey);
  }

  /** Controls for a terminal-like session on the teammate's machine. */
  private remoteSession(key: string): RunnerSession {
    return {
      send: (text) => this.op({ op: 'send', sessionKey: key, text }),
      interrupt: () => this.op({ op: 'interrupt', sessionKey: key }),
      respondPermission: (requestId, d) => this.op({ op: 'permission', sessionKey: key, requestId, allow: d.allow, always: d.always, message: d.message }),
      write: (data) => this.op({ op: 'pty_input', sessionKey: key, data }),
      resize: (cols, rows) => this.op({ op: 'pty_resize', sessionKey: key, cols, rows }),
      close: () => new Promise<void>((resolve) => {
        if (!this.sessions.has(key)) return resolve();
        this.closing.set(key, resolve);
        this.op({ op: 'close', sessionKey: key });
        setTimeout(resolve, 8000).unref();
      }),
    };
  }

  cleanup(project: Project, task: Task): Promise<boolean> {
    return new Promise((resolve) => {
      const id = randomUUID();
      this.cleanups.set(id, resolve);
      this.op({ op: 'cleanup', requestKey: id, project, task });
      setTimeout(() => { this.cleanups.delete(id); resolve(false); }, 15000).unref();
    });
  }

  /** Sends an op answered with a runner_reply; rejects on error, timeout or disconnect. */
  private request<T>(make: (requestKey: string) => RunnerOp, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const key = randomUUID();
      const timer = setTimeout(() => {
        this.requests.delete(key);
        reject(new Error('The teammate\'s runner did not answer (is it up to date?)'));
      }, timeoutMs);
      timer.unref();
      this.requests.set(key, (reply) => {
        clearTimeout(timer);
        this.requests.delete(key);
        if (reply.ok) resolve(reply.result as T);
        else reject(new Error(reply.error ?? 'Runner error'));
      });
      this.op(make(key));
    });
  }

  accountStatus(configDirs: Array<string | null>): Promise<AccountStatus[]> {
    return this.request((requestKey) => ({ op: 'account_status', requestKey, configDirs }), 60000);
  }

  accountLogin(key: string, configDir: string, onEvent: (e: RunnerSessionEvent) => void): RunnerSession {
    this.sessions.set(key, onEvent);
    this.op({ op: 'account_login', requestKey: key, configDir });
    return this.remoteSession(key);
  }

  accountRemove(configDir: string, email: string | null): Promise<AccountRemoval> {
    return this.request((requestKey) => ({ op: 'account_remove', requestKey, configDir, email }), 90000);
  }

  scanAgents(project: Project): Promise<RepoAgentDef[]> {
    return this.request<RepoAgentDef[]>((requestKey) => ({ op: 'scan_agents', requestKey, project }), 30000)
      .then((defs) => (Array.isArray(defs) ? defs : []));
  }

  handoff(project: Project, task: Task): Promise<HandoffResult> {
    return this.request((requestKey) => ({ op: 'handoff', requestKey, project, task }), 120000);
  }

  /** Called for every runner_reply received from the teammate's machine. */
  reply(msg: Reply) {
    this.requests.get(msg.requestKey)?.(msg);
  }

  /** Called for every runner_event received from the teammate's machine. */
  deliver(sessionKey: string, event: RunnerSessionEvent) {
    const cleanup = this.cleanups.get(sessionKey);
    if (cleanup && event.type === 'exit') {
      this.cleanups.delete(sessionKey);
      cleanup(event.error === null);
      return;
    }
    this.sessions.get(sessionKey)?.(event);
    if (event.type === 'exit') {
      this.sessions.delete(sessionKey);
      this.closing.get(sessionKey)?.();
      this.closing.delete(sessionKey);
    }
  }

  /** The runner disconnected: every live session is gone. */
  disconnect() {
    for (const [key, onEvent] of this.sessions) {
      onEvent({ type: 'exit', code: null, error: 'The teammate\'s runner disconnected.' });
      this.closing.get(key)?.();
    }
    this.sessions.clear();
    this.closing.clear();
    for (const done of this.cleanups.values()) done(false);
    this.cleanups.clear();
    for (const [key, done] of this.requests) done({ type: 'runner_reply', requestKey: key, ok: false, result: null, error: 'The teammate\'s runner disconnected.' });
    this.requests.clear();
  }
}
