import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

/** True when `dir` is inside a git repo that has at least one commit. */
export async function hasCommits(dir: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', 'HEAD'], dir);
    return true;
  } catch {
    return false;
  }
}

/** Initializes a repo with an empty first commit so worktrees can branch from it. */
export async function initRepo(dir: string): Promise<boolean> {
  mkdirSync(dir, { recursive: true });
  try {
    await git(['init'], dir);
    if (!(await hasCommits(dir))) await git(['commit', '--allow-empty', '-m', 'Initial commit'], dir);
    return true;
  } catch {
    return false;
  }
}

export async function originUrl(dir: string): Promise<string | null> {
  try {
    return (await git(['remote', 'get-url', 'origin'], dir)) || null;
  } catch {
    return null;
  }
}

export async function clone(url: string, dir: string): Promise<void> {
  mkdirSync(path.dirname(dir), { recursive: true });
  await git(['clone', url, dir], path.dirname(dir));
}

/** Creates a worktree for `branch`; creates the branch from HEAD unless it already exists. */
export async function addWorktree(repo: string, worktreePath: string, branch: string, existing = false): Promise<void> {
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  const branchExists = existing && (await git(['rev-parse', '--verify', `refs/heads/${branch}`], repo).then(() => true, () => false));
  if (branchExists) {
    await git(['worktree', 'add', worktreePath, branch], repo);
    return;
  }
  try {
    await git(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], repo);
  } catch (err) {
    // `worktree add -b` creates the branch before checking out; don't leave it behind.
    await git(['branch', '-D', branch], repo).catch(() => {});
    throw err;
  }
}

/** Removes a worktree only when it has no uncommitted changes; the branch is kept. */
export async function removeWorktree(repo: string, worktreePath: string): Promise<boolean> {
  try {
    await git(['worktree', 'remove', worktreePath], repo);
    return true;
  } catch {
    return false;
  }
}

/** Brings a task branch from origin: creates it locally if missing, or fast-forwards it. Best effort. */
export async function syncBranchFromOrigin(repo: string, branch: string): Promise<void> {
  if (!(await originUrl(repo))) return;
  try {
    await git(['fetch', 'origin', `refs/heads/${branch}`], repo);
  } catch {
    return; // not on origin (yet)
  }
  const local = await git(['rev-parse', '--verify', `refs/heads/${branch}`], repo).catch(() => null);
  if (!local) {
    await git(['branch', branch, 'FETCH_HEAD'], repo).catch(() => {});
    return;
  }
  const behind = await git(['merge-base', '--is-ancestor', branch, 'FETCH_HEAD'], repo).then(() => true, () => false);
  // Fails harmlessly when the branch is checked out somewhere.
  if (behind) await git(['branch', '-f', branch, 'FETCH_HEAD'], repo).catch(() => {});
}

/** runner_reply of a `handoff` op. */
export interface HandoffResult {
  branch: string | null;
  /** Uncommitted changes were committed as a WIP commit. */
  committed: boolean;
  /** The branch is on origin. */
  pushed: boolean;
  head: string | null;
  /** The agent's notes for the project on that machine, carried into the handoff. */
  notes: string | null;
  error: string | null;
}

/**
 * Before another player takes over a task: commit whatever is uncommitted in
 * the task's worktree and push the branch to origin so it can continue elsewhere.
 */
export async function handoffBranch(repo: string, worktree: string | null, branch: string, message: string): Promise<Omit<HandoffResult, 'notes'>> {
  const result: Omit<HandoffResult, 'notes'> = { branch, committed: false, pushed: false, head: null, error: null };
  try {
    if (worktree && (await git(['status', '--porcelain'], worktree))) {
      await git(['add', '-A'], worktree);
      // Agents never change global config; without an identity, commit as Agent HQ.
      const identity = await git(['config', 'user.email'], worktree).catch(() => '');
      await git([...(identity ? [] : ['-c', 'user.name=Agent HQ', '-c', 'user.email=agent-hq@localhost']), 'commit', '--no-verify', '-m', message], worktree);
      result.committed = true;
    }
    result.head = await git(['rev-parse', `refs/heads/${branch}`], repo).catch(() => null);
    if (result.head && (await originUrl(repo))) {
      await git(['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], repo);
      result.pushed = true;
    }
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}
