// Development: core server + Vite, shown in the Agent HQ desktop window.
// `--web` skips the window and prints the browser link instead.
//
// The core restarts when its sources change. We watch files ourselves rather
// than using `node --watch`, which intercepts worker-thread messages and
// breaks node-pty (the agents' terminals) on Windows.
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { electronBinary, killTree } from './electron.mjs';

const web = process.argv.includes('--web');
let stopping = false;
let core = null;
let vite = null;
let win = null;

const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const p of [win, vite, core]) killTree(p);
  process.exit(code);
};
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

let out = '';
function startCore() {
  out = '';
  const child = spawn(process.execPath, ['packages/core/src/index.ts', '--dev'], { stdio: ['ignore', 'pipe', 'inherit'] });
  core = child;
  child.stdout.on('data', (d) => {
    process.stdout.write(d);
    out += d;
    const url = out.match(/open: (http\S+)/)?.[1];
    if (url && !win && !web) openWindow(url);
  });
  child.on('exit', (code) => {
    if (child !== core || stopping) return;
    console.log(`\n[dev] core exited (${code}); waiting for changes…`);
  });
}

function openWindow(url) {
  win = spawn(electronBinary(), ['apps/desktop'], { stdio: 'inherit', env: { ...process.env, AGENT_HQ_URL: url } });
  // Closing the window ends the dev session.
  win.on('exit', () => stop(0));
}

let timer = null;
function restartCore(file) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`\n[dev] ${file} changed; restarting core…`);
    const old = core;
    core = null;
    killTree(old);
    startCore();
  }, 250);
}
for (const dir of ['packages/core/src', 'packages/protocol/src']) {
  watch(dir, { recursive: true }, (_event, file) => { if (file && /\.(ts|mjs|js|json)$/.test(file)) restartCore(file); });
}

startCore();
vite = spawn('npm run dev -w @agent-hq/web', { stdio: 'inherit', shell: true });
vite.on('exit', (code) => { if (code) stop(code); });
