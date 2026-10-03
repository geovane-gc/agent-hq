// Production: build the UI if needed and open the Agent HQ desktop window,
// which starts the host server itself.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { electronBinary } from './electron.mjs';

if (!existsSync('apps/web/dist/index.html')) {
  console.log('Building the UI (first run only)…');
  const res = spawnSync('npm run build', { stdio: 'inherit', shell: true });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const window = spawn(electronBinary(), ['apps/desktop', ...process.argv.slice(2)], { stdio: 'inherit' });
window.on('exit', (code) => process.exit(code ?? 0));
