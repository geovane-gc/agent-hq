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
