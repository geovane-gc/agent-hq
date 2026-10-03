// Development: core server + Vite, shown in the Agent HQ desktop window.
// `--web` skips the window and prints the browser link instead.
//
// The core restarts when its sources change. We watch files ourselves rather
// than using `node --watch`, which intercepts worker-thread messages and
// breaks node-pty (the agents' terminals) on Windows.
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { ensureDependencies } from './deps.mjs';
import { electronBinary, killTree } from './electron.mjs';

const web = process.argv.includes('--web');
ensureDependencies();

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

let windowUrl = null;
/** Windows being restarted: their exit doesn't end the session. */
const restarting = new WeakSet();
function openWindow(url) {
  windowUrl = url;
  const child = spawn(electronBinary(), ['apps/desktop'], { stdio: 'inherit', env: { ...process.env, AGENT_HQ_URL: url } });
  win = child;
  // Closing the window ends the dev session (unless we're restarting it).
  child.on('exit', () => { if (child === win && !restarting.has(child)) stop(0); });
}

// The page reloads by itself, the window's main process (apps/desktop) doesn't:
// restart the window when it changes, or the page would talk to an old one.
let windowTimer = null;
function restartWindow(file) {
  clearTimeout(windowTimer);
  windowTimer = setTimeout(() => {
    const old = win;
    if (!old || old.exitCode !== null || stopping) return;
    console.log(`\n[dev] ${file} changed; restarting the window…`);
    // `win` stays set until the new one starts, so the core's next "open:" line doesn't open another.
    restarting.add(old);
    old.once('exit', () => { if (!stopping) openWindow(windowUrl); });
    killTree(old);
  }, 250);
}
if (!web) watch('apps/desktop', (_event, file) => { if (file && /\.cjs$/.test(file)) restartWindow(file); });

// New dependencies (a pull, a branch switch) need an install and a restart.
let lockTimer = null;
watch('.', (_event, file) => {
  if (file !== 'package-lock.json') return;
  clearTimeout(lockTimer);
  lockTimer = setTimeout(() => console.log('\n[dev] package-lock.json changed: stop with Ctrl+C and run npm run dev again (it installs what changed).'), 500);
});

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
