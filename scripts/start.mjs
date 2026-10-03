// Production: build the UI if needed and open the Agent HQ desktop window,
// which starts the host server itself.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ensureDependencies } from './deps.mjs';
import { electronBinary } from './electron.mjs';

/** The newest modification time of a file or anything under a folder. */
function newest(file) {
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(stat.mtimeMs, ...readdirSync(file).map((name) => newest(path.join(file, name))));
}

/** The UI's sources changed (e.g. a pull) since apps/web/dist was built. */
function uiChanged() {
  const built = newest('apps/web/dist/index.html');
  return ['apps/web/src', 'apps/web/index.html', 'apps/web/vite.config.ts', 'packages/protocol/src', 'package-lock.json'].some((p) => newest(p) > built);
}

ensureDependencies();

if (!existsSync('apps/web/dist/index.html') || uiChanged()) {
  console.log(existsSync('apps/web/dist/index.html') ? 'The UI changed since it was built; rebuilding…' : 'Building the UI (first run only)…');
  const res = spawnSync('npm run build', { stdio: 'inherit', shell: true });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const window = spawn(electronBinary(), ['apps/desktop', ...process.argv.slice(2)], { stdio: 'inherit' });
window.on('exit', (code) => process.exit(code ?? 0));
