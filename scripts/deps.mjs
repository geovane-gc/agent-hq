// Keeps node_modules in step with package-lock.json. After a pull that adds or
// bumps a dependency, starting Agent HQ on the old node_modules fails in
// confusing ways (Vite: "failed to load config … Cannot find module
// '@excalidraw/excalidraw'", or a whiteboard that won't open), so check first
// and install what changed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Packages package-lock.json lists that node_modules lacks or has at another version, e.g. "three 0.185.0 → 0.186.1". */
export function staleDependencies() {
  const lock = readJson('package-lock.json');
  if (!lock?.packages) return [];
  const stale = [];
  for (const [dir, entry] of Object.entries(lock.packages)) {
    const at = dir.lastIndexOf('node_modules/');
    if (at < 0 || entry.inBundle) continue;
    const name = dir.slice(at + 'node_modules/'.length);
    const installed = readJson(`${dir}/package.json`);
    if (!installed) {
      // Optional ones may be for another platform (e.g. @esbuild/linux-x64).
      if (!entry.optional && !entry.devOptional && !entry.peer) stale.push(`${name} (missing)`);
    } else if (!entry.link && entry.version && installed.version !== entry.version) {
      stale.push(`${name} ${installed.version} → ${entry.version}`);
    }
  }
  return stale;
}

/** Runs `npm install` when node_modules is out of date. Exits if that fails. */
export function ensureDependencies() {
  const stale = [...new Set(staleDependencies())];
  if (stale.length === 0) return;
  const list = stale.length > 4 ? `${stale.slice(0, 4).join(', ')} and ${stale.length - 4} more` : stale.join(', ');
  console.log(`Dependencies changed since your last npm install (${list}). Running npm install…`);
  // Electron's own download is left to scripts/electron.mjs, which fetches the
  // binary when it's missing; Electron's install script breaks on some Node versions.
  const res = spawnSync('npm install', { stdio: 'inherit', shell: true, env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } });
  if (res.status !== 0) {
    console.error('\n✖ npm install failed. Fix the error above, run npm install, then start Agent HQ again.');
    process.exit(res.status || 1);
  }
}
