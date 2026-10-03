import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunnerSessionEvent } from '@agent-hq/protocol';
import { claudeCommand, resolveClaudeBinary } from './adapters/claude-code.ts';
import { loadNodePty } from './adapters/claude-code-tui.ts';
import { cleanEnv } from './adapters/env.ts';
import type { RunnerSession } from './runner/runner.ts';

// Claude accounts on this machine. Each extra login lives in its own Claude
// Code config dir (CLAUDE_CONFIG_DIR) under <data>/claude-accounts; the
// default login (configDir null) is whatever `claude` uses without it. Agent
// HQ never reads credentials: it only runs `claude auth status|login` and
// starts agents with the right CLAUDE_CONFIG_DIR.

/** Managed config dirs live here, relative to a runner's data dir. */
export const ACCOUNTS_DIR = 'claude-accounts';

/** What `claude auth status --json` says about one config dir (runner_reply of `account_status`). */
export interface AccountStatus {
  configDir: string | null;
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
  /** Set when the status could not be read (status unknown, not "logged out"). */
  error: string | null;
}

/** The config dir a host-side account path means on this machine (null: default login). */
export function resolveConfigDir(dataDir: string, configDir: string | null): string | null {
  if (!configDir) return null;
  return path.isAbsolute(configDir) ? configDir : path.resolve(dataDir, configDir);
}

const real = (p: string) => (existsSync(p) ? realpathSync(p) : path.resolve(p));

/** True for config dirs Agent HQ created (and may log into, log out of or delete), also after resolving symlinks. */
export function isManagedConfigDir(dataDir: string, dir: string): boolean {
  const root = path.resolve(dataDir, ACCOUNTS_DIR);
  const inside = (p: string, r: string) => p.startsWith(r + path.sep) && p.length > r.length + 1;
  return inside(path.resolve(dir), root) && inside(real(dir), real(root));
}

/**
 * Environment for running `claude` on a managed account: CLAUDE_CONFIG_DIR is
 * always set to that absolute dir. Throws rather than ever falling back to
 * the default login.
 */
export function accountCliEnv(dir: string): Record<string, string> {
  if (typeof dir !== 'string' || !dir.trim() || !path.isAbsolute(dir)) {
    throw new Error('Refusing to run claude without an explicit account config dir');
  }
  const env = cleanEnv({ CLAUDE_CONFIG_DIR: dir });
  if (env.CLAUDE_CONFIG_DIR !== dir) throw new Error('Refusing to run claude: CLAUDE_CONFIG_DIR is not set to the account dir');
  return env;
}

/** Environment for a `claude` process on that account. null keeps the inherited (default) login. */
export function accountEnv(configDir: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return cleanEnv(configDir ? { ...extra, CLAUDE_CONFIG_DIR: configDir } : extra);
}

/** The default login's config dir, where its sessions are stored. */
function defaultConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Creates a managed config dir. Onboarding (theme picker) is marked done so
 * agents started on it go straight to work; login happens with `claude auth login`.
 */
function prepareConfigDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, '.claude.json');
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }, null, 2));
}

export function accountStatus(dataDir: string, configDir: string | null): Promise<AccountStatus> {
  const dir = resolveConfigDir(dataDir, configDir);
  const unknown = (error: string): AccountStatus => ({ configDir, loggedIn: false, email: null, plan: null, error });
  if (dir && !existsSync(dir)) return Promise.resolve({ configDir, loggedIn: false, email: null, plan: null, error: null });
  let bin: string;
  try { bin = resolveClaudeBinary(); } catch (err) { return Promise.resolve(unknown((err as Error).message)); }
  return new Promise((resolve) => {
    // Exits 1 when logged out, still printing the JSON.
    execFile(...claudeCommand(bin, ['auth', 'status', '--json']), { env: accountEnv(dir), timeout: 20000, windowsHide: true }, (err, stdout) => {
      try {
        const j = JSON.parse(stdout);
        const loggedIn = !!j.loggedIn;
        const plan = j.subscriptionType ? String(j.subscriptionType) : loggedIn && j.authMethod && j.authMethod !== 'claude.ai' ? 'api' : null;
        resolve({ configDir, loggedIn, email: loggedIn && j.email ? String(j.email) : null, plan: loggedIn ? plan : null, error: null });
      } catch {
        resolve(unknown(err?.message ?? 'Unreadable `claude auth status` output'));
      }
    });
  });
}

/** `claude auth login` for a managed config dir, in a terminal the player types into from the game. */
export function startAccountLogin(dataDir: string, configDir: string, onEvent: (e: RunnerSessionEvent) => void): RunnerSession {
  const dir = resolveConfigDir(dataDir, configDir)!;
  if (!isManagedConfigDir(dataDir, dir)) throw new Error('Logins only run in Agent HQ account folders');
  prepareConfigDir(dir);
  const bin = resolveClaudeBinary();
  const env = accountEnv(dir, { COLORTERM: 'truecolor', FORCE_COLOR: '3' });
  let exited = false;
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((r) => { resolveExit = r; });
  const onExit = (code: number | null, error: string | null) => {
    if (exited) return;
    exited = true;
    resolveExit();
    onEvent({ type: 'exit', code, error });
  };

  const nodePty = loadNodePty();
  if (nodePty) {
    const p = nodePty.spawn(...claudeCommand(bin, ['auth', 'login']), { name: 'xterm-256color', cols: 100, rows: 30, cwd: dir, env });
    p.onData((data) => onEvent({ type: 'pty', data }));
    p.onExit(({ exitCode }) => onExit(exitCode, exitCode ? `claude auth login exited with code ${exitCode}` : null));
    return {
      send: (text) => p.write(`${text}\r`),
      interrupt: () => p.write('\x03'),
      respondPermission: () => {},
      write: (data) => { if (!exited) p.write(data); },
      resize: (cols, rows) => { if (!exited && cols > 10 && rows > 4) p.resize(Math.floor(cols), Math.floor(rows)); },
      close: () => {
        if (!exited) {
          try { p.kill(); } catch {}
          setTimeout(() => onExit(null, null), 3000).unref();
        }
        return exitPromise;
      },
    };
  }

  // No PTY: a piped process. Enough to show the login URL and paste the code back.
  const child = spawn(...claudeCommand(bin, ['auth', 'login']), { cwd: dir, env, windowsHide: true });
  const out = (d: Buffer) => onEvent({ type: 'pty', data: d.toString('utf8').replace(/\r?\n/g, '\r\n') });
  child.stdout.on('data', out);
  child.stderr.on('data', out);
  child.on('error', (err) => onExit(null, err.message));
  child.on('exit', (code) => onExit(code, code ? `claude auth login exited with code ${code}` : null));
  let line = '';
  return {
    send: (text) => child.stdin.write(`${text}\n`),
    interrupt: () => child.kill(),
    respondPermission: () => {},
    write: (data) => {
      for (const ch of data) {
        if (ch === '\r') { onEvent({ type: 'pty', data: '\r\n' }); child.stdin.write(`${line}\n`); line = ''; }
        else if (ch === '\x7f') { if (line) { line = line.slice(0, -1); onEvent({ type: 'pty', data: '\b \b' }); } }
        else { line += ch; onEvent({ type: 'pty', data: ch }); }
      }
    },
    resize: () => {},
    close: () => {
      if (!exited) child.kill();
      return exitPromise;
    },
  };
}

/** runner_reply of `account_remove`. */
export interface AccountRemoval {
  loggedOut: boolean;
  /** Set when the login could not be removed safely: credentials may remain. */
  warning: string | null;
}

function runClaude(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; error: string | null }> {
  return new Promise((resolve) => {
    execFile(...claudeCommand(resolveClaudeBinary(), args), { env, timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, error: err ? (stderr.trim() || err.message) : null });
    });
  });
}

/**
 * Removes a managed account from this machine: logs it out, so its credential
 * (e.g. the macOS Keychain entry) doesn't stay behind, then deletes its config
 * dir. Guards: never the default login; only dirs under <data>/claude-accounts
 * (symlinks resolved); `claude` always runs with CLAUDE_CONFIG_DIR set to that
 * dir; and the logout only happens when `claude auth status` in that dir
 * reports that same dir and the account's email. Otherwise the dir is still
 * deleted and a warning says credentials may remain.
 */
export async function removeAccount(dataDir: string, configDir: string | null, email: string | null): Promise<AccountRemoval> {
  if (!configDir) throw new Error('The default login is never logged out or removed by Agent HQ');
  const dir = resolveConfigDir(dataDir, configDir)!;
  if (!isManagedConfigDir(dataDir, dir)) throw new Error('Only Agent HQ account folders can be removed');
  if (!existsSync(dir)) return { loggedOut: false, warning: null };
  const target = realpathSync(dir);
  const env = accountCliEnv(target);
  const revoke = 'Credentials may remain on that machine; revoke the session at claude.ai (Settings → Account).';
  let loggedOut = false;
  let warning: string | null = null;

  const status = await runClaude(['auth', 'status', '--json'], env);
  let j: Record<string, unknown> | null = null;
  try { j = JSON.parse(status.stdout); } catch {}
  const statusDir = typeof j?.configDirectory === 'string' ? real(j.configDirectory) : null;
  if (!j) {
    warning = `Couldn't verify the login before logging out (${status.error ?? 'unreadable status'}). ${revoke}`;
  } else if (!j.loggedIn) {
    // Nothing to log out.
  } else if (statusDir !== target || statusDir === real(defaultConfigDir())) {
    warning = `Couldn't verify the login: Claude Code reported another config dir (${statusDir ?? 'none'}), so it was not logged out. ${revoke}`;
  } else if (!email || j.email !== email) {
    warning = `Couldn't verify the login: it is signed in as ${String(j.email ?? 'an unknown account')}, not ${email ?? 'the expected account'}, so it was not logged out. ${revoke}`;
  } else {
    const out = await runClaude(['auth', 'logout'], accountCliEnv(target));
    if (out.code === 0) loggedOut = true;
    else warning = `Logging out failed (${out.error ?? `exit ${out.code}`}). ${revoke}`;
  }
  rmSync(dir, { recursive: true, force: true });
  return { loggedOut, warning };
}

/**
 * Claude Code keeps a session's transcript in <configDir>/projects/<cwd>/<id>.jsonl,
 * so after switching accounts `--resume` only works if it is copied over. Looks
 * for the session in the default login and every managed account on this
 * machine. Returns false when the session can't be found anywhere.
 */
export function ensureSessionInConfigDir(dataDir: string, sessionId: string, target: string | null): boolean {
  const targetDir = target ?? defaultConfigDir();
  const find = (configDir: string): string | null => {
    const projects = path.join(configDir, 'projects');
    if (!existsSync(projects)) return null;
    for (const sub of readdirSync(projects)) {
      if (existsSync(path.join(projects, sub, `${sessionId}.jsonl`))) return path.join(projects, sub);
    }
    return null;
  };
  if (find(targetDir)) return true;
  const managed = path.join(dataDir, ACCOUNTS_DIR);
  const candidates = [defaultConfigDir(), ...(existsSync(managed) ? readdirSync(managed).map((d) => path.join(managed, d)) : [])];
  for (const dir of candidates) {
    if (path.resolve(dir) === path.resolve(targetDir)) continue;
    const from = find(dir);
    if (!from) continue;
    const to = path.join(targetDir, 'projects', path.basename(from));
    mkdirSync(to, { recursive: true });
    cpSync(path.join(from, `${sessionId}.jsonl`), path.join(to, `${sessionId}.jsonl`));
    // Subagent transcripts of that session, if any.
    if (existsSync(path.join(from, sessionId))) cpSync(path.join(from, sessionId), path.join(to, sessionId), { recursive: true });
    return true;
  }
  return false;
}
