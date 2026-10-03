// Agent HQ desktop app. Starts the host server with the system Node.js (so
// agents, git and node:sqlite behave exactly as on the command line) and shows
// the office in a window. In development, scripts/dev.mjs runs the server and
// passes its URL in AGENT_HQ_URL instead.
const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '../..');
/**
 * What the running desktop app can do, for the page (see preload.cjs and
 * apps/web/src/desktop.ts). Bump it when the bridge or the media handling
 * changes: a page newer than the app then asks for a restart instead of
 * failing in odd ways (main.cjs only reloads when the app restarts).
 */
const DESKTOP_API = 2;
const port = process.env.AGENT_HQ_PORT || '4317';
let server = null;
/** The office page's origin: only it may open dialogs through the preload. */
let officeOrigin = null;

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
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  setupMedia(win, url);
  win.once('ready-to-show', () => win.show());
  // Links to the outside world open in the system browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  officeOrigin = new URL(url).origin;
  win.loadURL(url);
}

/** Only the office page may use the bridge (see preload.cjs). */
function fromOfficePage(event) {
  try {
    return !!officeOrigin && !!event.senderFrame && new URL(event.senderFrame.url).origin === officeOrigin;
  } catch {
    return false;
  }
}

/** The system folder chooser, for the page's "Browse…" buttons (see preload.cjs). */
async function pickFolder(event, defaultPath) {
  if (!fromOfficePage(event)) return null;
  const options = { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] };
  if (typeof defaultPath === 'string' && defaultPath.trim()) {
    const wanted = path.resolve(defaultPath.trim().replace(/^~(?=$|[\\/])/, app.getPath('home')));
    if (fs.existsSync(wanted)) options.defaultPath = wanted;
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
  return result.canceled ? null : result.filePaths[0] ?? null;
}

// ---- Voice chat and meeting-room screen sharing.
// The office may use the microphone (never the camera) and capture a screen
// or window, and only the office itself: other origins are refused. Screen
// capture shows the system picker where there is one (macOS 15+), otherwise a
// small menu of screens and windows with thumbnails.
function setupMedia(win, officeUrl) {
  const { desktopCapturer, Menu, session, systemPreferences } = require('electron');
  const origin = new URL(officeUrl).origin;
  const fromOffice = (url) => { try { return new URL(url).origin === origin; } catch { return false; } };
  const ses = session.defaultSession;

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (permission === 'media' || permission === 'speaker-selection') return fromOffice(requestingOrigin);
    return true; // everything else as Electron's default
  });
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'speaker-selection') return callback(fromOffice(details.requestingUrl));
    if (permission !== 'media') return callback(true); // Electron's default
    if (!fromOffice(details.requestingUrl)) return callback(false);
    const types = details.mediaTypes ?? [];
    // getDisplayMedia asks for 'media' with no device types. Let it through:
    // the display media handler below decides what, if anything, is captured.
    if (types.length === 0) return callback(true);
    if (types.some((t) => t !== 'audio')) return callback(false);
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
      return;
    }
    callback(true);
  });

  ses.setDisplayMediaRequestHandler((request, callback) => {
    // Answering without a stream refuses (the page gets an AbortError);
    // callback({}) would throw, as video was requested.
    const refuse = () => callback();
    if (!fromOffice(request.securityOrigin || request.frame?.url || '')) return refuse();
    // Without Screen Recording permission macOS only shows us the wallpaper.
    // Refuse; the page then explains how to grant it (see screenAccess).
    if (screenAccess() !== 'granted') return refuse();
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 160, height: 90 } }).then((sources) => {
      if (sources.length === 0) return refuse();
      let answered = false;
      const answer = (source) => {
        if (answered) return;
        answered = true;
        if (source) callback({ video: source });
        else refuse();
      };
      const item = (source) => ({
        label: source.name.length > 60 ? `${source.name.slice(0, 59)}…` : source.name,
        icon: source.thumbnail.isEmpty() ? undefined : source.thumbnail.resize({ height: 36 }),
        click: () => answer(source),
      });
      const screens = sources.filter((s) => s.id.startsWith('screen:'));
      const windows = sources.filter((s) => !s.id.startsWith('screen:') && s.name);
      const menu = Menu.buildFromTemplate([
        { label: 'Share your screen in the meeting room', enabled: false },
        { type: 'separator' },
        ...screens.map(item),
        ...(windows.length ? [{ type: 'separator' }, ...windows.slice(0, 20).map(item)] : []),
        { type: 'separator' },
        { label: 'Cancel', click: () => answer(null) },
      ]);
      // Closing the menu without a choice cancels. The close callback can fire just before the click, hence the delay.
      menu.popup({ window: win, callback: () => setTimeout(() => answer(null), 100) });
    }, refuse);
  }, { useSystemPicker: true });
}

/**
 * May we capture the screen? On macOS that's the Screen Recording permission
 * (System Settings → Privacy & Security → Screen & System Audio Recording);
 * elsewhere always 'granted'.
 */
function screenAccess() {
  if (process.platform !== 'darwin') return 'granted';
  const { desktopCapturer, systemPreferences } = require('electron');
  const status = systemPreferences.getMediaAccessStatus('screen');
  // Asking for sources makes macOS list the app in that settings pane (and
  // prompt, the first time), so there is a switch to turn on.
  if (status !== 'granted') desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => {});
  return status;
}

/** The page's side of preload.cjs: the folder chooser, what this app can do, and screen capture permission. */
function setupBridge() {
  ipcMain.handle('agent-hq:pick-folder', pickFolder);
  ipcMain.handle('agent-hq:info', (event) => (fromOfficePage(event)
    ? { api: DESKTOP_API, platform: process.platform, appName: app.isPackaged ? app.getName() : 'Electron' }
    : null));
  ipcMain.handle('agent-hq:screen-access', (event) => (fromOfficePage(event) ? screenAccess() : null));
  ipcMain.handle('agent-hq:open-screen-settings', async (event) => {
    if (!fromOfficePage(event) || process.platform !== 'darwin') return false;
    return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').then(() => true, () => false);
  });
}

// One office per machine: focus the existing window instead of opening a second one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    setupBridge();
    createWindow();
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', stopServer);
