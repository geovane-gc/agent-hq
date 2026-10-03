import { randomUUID } from 'node:crypto';
import type { HostToRunner, ID, Project, RunnerOp, RunnerSessionEvent, RunnerStart, Task } from '@agent-hq/protocol';
import type { Runner, RunnerSession } from './runner.ts';

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

  constructor(userId: ID, sendOp: (msg: HostToRunner) => void) {
    this.userId = userId;
    this.sendOp = sendOp;
  }

  private op(op: RunnerOp) {
    this.sendOp({ type: 'runner_op', op });
  }

  start(start: RunnerStart, onEvent: (e: RunnerSessionEvent) => void): RunnerSession {
    const key = start.sessionKey;
    this.sessions.set(key, onEvent);
    this.op({ op: 'start', start });
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
  }
}
