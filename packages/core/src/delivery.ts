import { execFile } from 'node:child_process';
import { ECONOMY } from './economy-config.ts';

// Verifies delivered work with git: is a task's branch merged into the
// project's default branch, and how big was the change? Used by the economy
// to pay revenue only for work that really landed.
//
// "Merged" means one of:
// - ancestor: the branch head is reachable from the default branch (merge commit or fast-forward);
// - rebase:   every commit of the branch has an equivalent patch upstream (`git cherry`);
// - squash:   one upstream commit carries exactly the branch's whole diff (same patch-id).
// With an `origin`, only origin's default branch counts (after a fetch). Without one, the local default branch.

export interface DeliveryCheck {
  merged: boolean;
  via: 'ancestor' | 'rebase' | 'squash' | null;
  /** Changed lines (insertions + deletions) between base and head, ignoring lockfiles and the like. */
  lines: number;
  /** Where the branch started; recorded while it is unmerged, since that's when it's easy to know. */
  base: string | null;
  /** Head commits seen for the branch (local and origin). */
  heads: string[];
  /** e.g. "origin/main". */
  defaultRef: string | null;
  note: string;
}

interface GitOpts {
  timeout?: number;
  input?: string;
}

function git(args: string[], cwd: string, opts: GitOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeout ?? 20_000,
        // Never wait for credentials: a background check must not hang.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr).trim() || err.message));
        else resolve(String(stdout));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

const ok = (p: Promise<unknown>) => p.then(() => true, () => false);
const out = (p: Promise<string>) => p.then((s) => s.trim() || null, () => null);

export async function hasOrigin(repo: string): Promise<boolean> {
  return ok(git(['remote', 'get-url', 'origin'], repo));
}

/** `git fetch origin`; false when it failed (offline, no access…). Never prunes: merged branches deleted on the server stay checkable. */
export async function fetchOrigin(repo: string): Promise<boolean> {
  return ok(git(['fetch', 'origin', '--quiet', '--no-tags'], repo, { timeout: ECONOMY.fetchTimeoutMs }));
}

const commitExists = (repo: string, ref: string) => out(git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo));

/** The ref work must land on: origin's default branch, or the local one when there is no origin. */
export async function defaultBranchRef(repo: string): Promise<string | null> {
  if (await hasOrigin(repo)) {
    const head = await out(git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repo));
    if (head && (await commitExists(repo, head))) return head;
    for (const name of ['origin/main', 'origin/master', 'origin/trunk', 'origin/develop']) {
      if (await commitExists(repo, name)) return name;
    }
    return null;
  }
  for (const name of ['main', 'master', 'trunk']) {
    if (await commitExists(repo, `refs/heads/${name}`)) return name;
  }
  // Whatever the main checkout is on.
  return out(git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo));
}

/** insertions + deletions between two commits, skipping files from ECONOMY.ignoredFiles and binaries. */
export async function changedLines(repo: string, base: string, head: string): Promise<number> {
  const numstat = await git(['diff', '--numstat', '--no-renames', base, head], repo);
  let lines = 0;
  for (const row of numstat.split('\n')) {
    const [added, deleted, file] = row.split('\t');
    if (!file || added === '-' || ECONOMY.ignoredFiles.some((re) => re.test(file))) continue;
    lines += Number(added) + Number(deleted);
  }
  return lines;
}

/** The commit a local branch was created from, from its reflog (oldest entry). */
async function reflogBase(repo: string, branch: string): Promise<string | null> {
  const log = await out(git(['reflog', 'show', '--format=%H', `refs/heads/${branch}`, '--'], repo));
  return log ? log.split('\n').at(-1) ?? null : null;
}

/** For a branch merged with a merge commit M: where it forked from M's first parent. */
async function mergeCommitBase(repo: string, head: string, target: string): Promise<string | null> {
  const merges = await out(git(['rev-list', '--ancestry-path', '--merges', '--reverse', `${head}..${target}`], repo));
  const merge = merges?.split('\n')[0];
  return merge ? out(git(['merge-base', `${merge}^1`, head], repo)) : null;
}

async function patchIds(repo: string, input: string): Promise<string[]> {
  if (!input.trim()) return [];
  const ids = await git(['patch-id', '--stable'], repo, { input });
  return ids.split('\n').map((l) => l.split(' ')[0]).filter(Boolean);
}

/** Squash merge: an upstream commit since `base` whose patch equals the branch's whole diff. */
async function squashMerged(repo: string, base: string, head: string, target: string): Promise<boolean> {
  const [mine] = await patchIds(repo, await git(['diff', '--no-color', base, head], repo));
  if (!mine) return false;
  const upstream = await git(['log', '-p', '--no-color', '--no-merges', '--max-count=300', `${base}..${target}`], repo);
  return (await patchIds(repo, upstream)).includes(mine);
}

/** Rebase merge: every commit of base..head has an equivalent upstream (`git cherry` marks them with "-"). */
async function rebaseMerged(repo: string, base: string, head: string, target: string): Promise<boolean> {
  const cherry = await out(git(['cherry', target, head, base], repo));
  if (!cherry) return false;
  return cherry.split('\n').every((l) => l.startsWith('-'));
}

/**
 * Checks whether `branch` landed on the default branch. `known` carries what
 * earlier checks recorded (base and heads), so a branch deleted after its
 * merge can still be verified from its last known head.
 */
export async function inspectBranch(repo: string, branch: string, known: { base: string | null; heads: string[] }): Promise<DeliveryCheck> {
  const result: DeliveryCheck = { merged: false, via: null, lines: 0, base: known.base, heads: [], defaultRef: null, note: '' };
  const target = await defaultBranchRef(repo);
  result.defaultRef = target;
  if (!target) return { ...result, note: 'No default branch found' };

  const candidates = new Set<string>();
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`, ...known.heads]) {
    const sha = await commitExists(repo, ref);
    if (sha) candidates.add(sha);
  }
  result.heads = [...new Set([...candidates, ...known.heads])].slice(-8);
  if (!candidates.size) return { ...result, note: 'Branch not found' };

  for (const head of candidates) {
    const ancestor = await ok(git(['merge-base', '--is-ancestor', head, target], repo));
    let base = result.base;
    let via: DeliveryCheck['via'] = null;
    if (ancestor) {
      base ??= (await reflogBase(repo, branch)) ?? (await mergeCommitBase(repo, head, target));
      via = 'ancestor';
    } else {
      // Not (yet) reachable: the fork point is easy to know now, remember it.
      const forkPoint = await out(git(['merge-base', head, target], repo));
      if (forkPoint) result.base = base = forkPoint;
      if (base && (await rebaseMerged(repo, base, head, target))) via = 'rebase';
      else if (base && (await squashMerged(repo, base, head, target).catch(() => false))) via = 'squash';
    }
    if (!via) continue;
    if (!base) {
      result.note = 'Merged, but the size of the change could not be measured';
      continue;
    }
    const lines = await changedLines(repo, base, head);
    if (lines === 0) {
      result.note = 'Merged, but the branch has no changes of its own';
      continue;
    }
    return { ...result, merged: true, via, lines, base, note: `Merged into ${target} (${via})` };
  }
  return { ...result, note: result.note || `Not merged into ${target} yet` };
}
