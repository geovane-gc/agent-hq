import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { cleanEnv } from './adapters/env.ts';

// Every project is linked to a GitHub repository: either a local clone whose
// `origin` is on GitHub, or a new repository created from the game with the
// GitHub CLI (`gh`). Credentials stay with git and gh; a token saved in the
// settings is only handed to gh as GH_TOKEN.

export type GithubSource = 'gh' | 'env' | 'settings';

export interface GithubStatus {
  ghInstalled: boolean;
  configured: boolean;
  source: GithubSource | null;
  login: string | null;
}

class MissingCommand extends Error {}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, env: cleanEnv(opts.env), windowsHide: true, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') reject(new MissingCommand(`${cmd} not found`));
      else if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve(String(stdout).trim());
    });
  });
}

/** Normalizes any GitHub remote (https, ssh, scp-like) to https://github.com/<owner>/<repo>; null when not GitHub. */
export function githubUrl(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const m = remote.trim().match(
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/]|ssh:\/\/git@github\.com:\d+\/|git:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
  );
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

export const GIT_MISSING = 'Git is not installed (or not on PATH). Install git and try again.';
export const GH_MISSING = 'The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, run `gh auth login`, then try again.';
export const GH_NOT_AUTHENTICATED = 'The GitHub CLI is not logged in. Run `gh auth login` (the boss terminal works), or save a GitHub token, then try again.';

/** The root of the git repository containing `dir`, or null when it isn't in one. */
async function repoRoot(dir: string): Promise<string | null> {
  try {
    return realpathSync(await run('git', ['rev-parse', '--show-toplevel'], { cwd: dir }));
  } catch (err) {
    if (err instanceof MissingCommand) throw new Error(GIT_MISSING);
    return null;
  }
}

/** True when `dir` is the root folder of a git repository (not just somewhere inside one). */
export async function isRepoRoot(dir: string): Promise<boolean> {
  return (await repoRoot(dir)) === realpathSync(dir);
}

/**
 * Checks that `dir` is the root of a git repository whose origin is on
 * GitHub and returns that origin. Throws an explanation of what to fix otherwise.
 */
export async function requireGithubOrigin(dir: string): Promise<{ remoteUrl: string; githubUrl: string }> {
  const root = await repoRoot(dir);
  if (!root) throw new Error(`${dir} is not a git repository. Clone your GitHub repository there, or choose "Create a new GitHub repository".`);
  if (root !== realpathSync(dir)) throw new Error(`${dir} is inside the repository at ${root}. Choose the repository's root folder.`);
  // The configured URL, before any `url.<base>.insteadOf` rewriting (which `remote get-url` applies).
  const origin = await run('git', ['config', '--get', 'remote.origin.url'], { cwd: dir }).catch(() => '');
  if (!origin) {
    throw new Error(`${dir} has no "origin" remote. Add your GitHub repository with \`git remote add origin https://github.com/<owner>/<repo>.git\`, or choose "Create a new GitHub repository".`);
  }
  const url = githubUrl(origin);
  if (!url) throw new Error(`The origin of ${dir} is ${origin}, which is not on GitHub. Agent HQ projects must be linked to a GitHub repository.`);
  return { remoteUrl: origin, githubUrl: url };
}

/** Where gh gets its credentials from, and who that is. `token` is the one saved in the settings, if any. */
export async function githubStatus(token: string | null): Promise<GithubStatus> {
  const ghInstalled = await run('gh', ['--version']).then(() => true, () => false);
  const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  let source: GithubSource | null = token ? 'settings' : envToken ? 'env' : null;
  if (!source && ghInstalled) source = await run('gh', ['auth', 'token']).then((t) => (t ? 'gh' : null), () => null);
  let login: string | null = null;
  if (source && ghInstalled) login = await run('gh', ['api', 'user', '--jq', '.login'], { env: ghEnv(token) }).then((l) => l || null, () => null);
  // A token gh rejects (expired, revoked) isn't a usable configuration.
  const configured = !!source && (!ghInstalled || login !== null);
  return { ghInstalled, configured, source: configured ? source : null, login };
}

function ghEnv(token: string | null): Record<string, string> {
  return token ? { GH_TOKEN: token } : {};
}

/**
 * Creates `name` (or `owner/name`) on GitHub with gh, adds it as `dir`'s
 * origin and pushes the current branch. `dir` must be a git repository with
 * at least one commit and no origin. Returns https://github.com/<owner>/<repo>.
 */
export async function createGithubRepo(dir: string, repo: { name: string; private: boolean }, token: string | null): Promise<string> {
  const name = repo.name.trim();
  if (!/^(?:[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error('Repository names may only contain letters, digits, ".", "-" and "_" (optionally "owner/name").');
  const status = await githubStatus(token);
  if (!status.ghInstalled) throw new Error(GH_MISSING);
  if (!status.configured) throw new Error(GH_NOT_AUTHENTICATED);
  const env = ghEnv(token);

  let created: string;
  try {
    created = await run('gh', ['repo', 'create', name, repo.private ? '--private' : '--public'], { cwd: dir, env });
  } catch (err) {
    throw new Error(`GitHub refused to create ${name}: ${(err as Error).message}`);
  }
  const url = githubUrl(created.split(/\s+/).find((w) => githubUrl(w)) ?? null)
    ?? githubUrl(`https://github.com/${name.includes('/') ? name : `${status.login ?? ''}/${name}`}`);
  if (!url) throw new Error(`Created ${name} on GitHub, but could not tell its URL from gh's output (${created}). Add it as origin and link the folder instead.`);

  await run('git', ['remote', 'add', 'origin', `${url}.git`], { cwd: dir });
  try {
    // Use gh's login for this push only, whatever credential helper git has.
    await run('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '-u', 'origin', 'HEAD'], { cwd: dir, env });
  } catch (err) {
    throw new Error(`Created ${url} and set it as origin, but the first push failed: ${(err as Error).message}. Push it yourself (\`git push -u origin HEAD\`), then link the folder.`);
  }
  return url;
}
