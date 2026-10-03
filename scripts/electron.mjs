// Helpers to locate (and if needed, download) the Electron binary.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Returns the path of the Electron executable. Newer npm versions skip
 * Electron's postinstall (which downloads the binary) unless scripts are
 * approved, so run that download ourselves the first time.
 */
export function electronBinary() {
  const pkgDir = path.dirname(require.resolve('electron/package.json'));
  const pathFile = path.join(pkgDir, 'path.txt');
  const binaryReady = () => existsSync(pathFile) && existsSync(require('electron'));
  if (!binaryReady()) {
    console.log('Downloading Electron (first run only)…');
    const res = spawnSync(process.execPath, [path.join(pkgDir, 'install.js')], { stdio: 'inherit' });
    if (res.status !== 0 || !binaryReady()) throw new Error('Could not download Electron. Check your connection and try again.');
  }
  return require('electron');
}

/** Kills a child and everything it started (on Windows, npm spawns tools as grandchildren). */
export function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
}
