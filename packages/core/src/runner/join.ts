import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostToRunner, Project, RunnerMessage, RunnerOp } from '@agent-hq/protocol';
import { ClaudeCodeAdapter } from '../adapters/claude-code.ts';
import { clone, hasCommits } from '../git.ts';
import { LocalRunner, type Workspace } from './local.ts';
import type { RunnerSession } from './runner.ts';

// `agent-hq join <host-url> --token <invite>`: connects this machine to a
// teammate's office as a runner. Your agents run here, with your own Claude
// Code login, in your own clones of the projects.

interface JoinOptions {
  url: string;
  token: string;
  dataDir: string;
  /** projectId (or project name) -> local checkout. */
  repos: Record<string, string>;
}

function parseArgs(argv: string[]): JoinOptions {
  const url = argv.find((a) => !a.startsWith('--'));
  const get = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const token = get('--token');
  if (!url || !token) {
    console.error('Usage: agent-hq join <host-url> --token <invite-token> [--repo <project>=<path>]... [--data-dir <dir>]');
    process.exit(1);
  }
  const dataDir = path.resolve(get('--data-dir') ?? path.join(os.homedir(), '.agent-hq-runner'));
  mkdirSync(dataDir, { recursive: true });
  const repos: Record<string, string> = {};
  const reposFile = path.join(dataDir, 'repos.json');
  if (existsSync(reposFile)) Object.assign(repos, JSON.parse(readFileSync(reposFile, 'utf8')));
  argv.forEach((a, i) => {
    if (a !== '--repo') return;
    const [key, ...rest] = String(argv[i + 1]).split('=');
    repos[key] = path.resolve(rest.join('='));
  });
  return { url: url.replace(/\/$/, '').replace(/^http/, 'ws'), token, dataDir, repos };
}

export async function join(argv: string[]) {
  const opts = parseArgs(argv);
  const claude = new ClaudeCodeAdapter();
  const health = await claude.check();
  if (!health.ok) {
    console.error(`✖ ${health.error}`);
    process.exit(1);
  }

  const resolveRepo = async (project: Project): Promise<Workspace> => {
    let dir = opts.repos[project.id] ?? opts.repos[project.name];
    if (!dir) {
      if (!project.remoteUrl) {
        throw new Error(`No local checkout for "${project.name}". Restart join with --repo "${project.name}=<path>".`);
      }
      dir = path.join(opts.dataDir, 'repos', project.id.slice(0, 8));
      if (!existsSync(dir)) {
        console.log(`Cloning ${project.remoteUrl} …`);
        await clone(project.remoteUrl, dir);
      }
    }
    return { repoPath: dir, git: await hasCommits(dir) };
  };

  const sessions = new Map<string, RunnerSession>();
  let ws: WebSocket;
  let retry = 1000;
  let runner: LocalRunner | null = null;

  const send = (msg: RunnerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  const handle = async (op: RunnerOp) => {
    switch (op.op) {
      case 'start': {
        const key = op.start.sessionKey;
        const session = runner!.start(op.start, (event) => {
          if (event.type === 'exit') sessions.delete(key);
          send({ type: 'runner_event', sessionKey: key, event });
        });
        sessions.set(key, session);
        console.log(`▶ ${op.start.agent.name}: ${op.start.task?.title ?? 'conversation'}`);
        return;
      }
      case 'send': return sessions.get(op.sessionKey)?.send(op.text);
      case 'interrupt': return sessions.get(op.sessionKey)?.interrupt();
      case 'pty_input': return sessions.get(op.sessionKey)?.write(op.data);
      case 'pty_resize': return sessions.get(op.sessionKey)?.resize(op.cols, op.rows);
      case 'permission':
        return sessions.get(op.sessionKey)?.respondPermission(op.requestId, { allow: op.allow, always: op.always, message: op.message });
      case 'close': {
        const s = sessions.get(op.sessionKey);
        if (s) await s.close();
        else send({ type: 'runner_event', sessionKey: op.sessionKey, event: { type: 'exit', code: 0, error: null } });
        return;
      }
      case 'cleanup': {
        const ok = await runner!.cleanup(op.project, op.task);
        send({ type: 'runner_event', sessionKey: op.requestKey, event: { type: 'exit', code: 0, error: ok ? null : 'not removed' } });
        return;
      }
    }
  };

  const connect = () => {
    ws = new WebSocket(`${opts.url}/ws?token=${encodeURIComponent(opts.token)}&runner=1`);
    ws.onopen = () => {
      retry = 1000;
      console.log(`Connected to ${opts.url} as a runner (Claude Code ${health.version}).`);
      send({ type: 'runner_hello', claudeVersion: health.version });
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === 'snapshot') {
        runner ??= new LocalRunner({
          userId: msg.snapshot.you.id, dataDir: opts.dataDir, adapters: [claude], resolveRepo, remote: true, hqUrl: opts.url,
        });
      } else if (msg.type === 'runner_op') {
        handle((msg as HostToRunner).op).catch((err) => console.error(err));
      }
    };
    ws.onclose = (ev) => {
      for (const s of sessions.values()) s.close();
      sessions.clear();
      if (ev.code === 4001) {
        console.error('✖ The host rejected this token.');
        process.exit(1);
      }
      console.log(`Disconnected; retrying in ${retry / 1000}s…`);
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
    };
    ws.onerror = () => {};
  };
  connect();

  const stop = async () => {
    await Promise.all([...sessions.values()].map((s) => s.close()));
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
