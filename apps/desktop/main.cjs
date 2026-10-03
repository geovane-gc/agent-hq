// Agent HQ desktop app. Starts the host server with the system Node.js (so
// agents, git and node:sqlite behave exactly as on the command line) and shows
// the office in a window. In development, scripts/dev.mjs runs the server and
// passes its URL in AGENT_HQ_URL instead.
const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '../..');
const port = process.env.AGENT_HQ_PORT || '4317';
let server = null;

function startServer() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(path.join(root, 'apps/web/dist/index.html'))) {
      reject(new Error('The web UI is not built. Run `npm run build` in the repository root first.'));
      return;
    }
    // `node` must be on PATH: Agent HQ runs on the user's own Node.js.
    server = spawn('node', [path.join(root, 'packages/core/src/index.ts'), '--port', port], {
      cwd: root,
      env: process.env,
      windowsHide: true,
    });
    let out = '';
    server.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
      const match = out.match(/open: (http\S+)/);
      if (match) resolve(match[1]);
    });
    server.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    server.on('error', (err) => reject(new Error(`Could not start Node.js: ${err.message}. Is Node installed and on PATH?`)));
    server.on('exit', (code) => reject(new Error(`Agent HQ server exited (${code}).\n\n${out.slice(-2000)}`)));
  });
}

function stopServer() {
  if (!server || server.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else server.kill();
}

async function createWindow() {
  let url = process.env.AGENT_HQ_URL;
  if (!url) {
    try {
      url = await startServer();
    } catch (err) {
      dialog.showErrorBox('Agent HQ could not start', err.message);
      app.quit();
      return;
    }
  }
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 960,
    minHeight: 600,
    title: 'Agent HQ',
    backgroundColor: '#14171c',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  // Links to the outside world open in the system browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  win.loadURL(url);
}

// One office per machine: focus the existing window instead of opening a second one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(createWindow);
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', stopServer);
