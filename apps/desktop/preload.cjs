// The only bridge between the office page and the desktop app. Runs isolated
// from the page (contextIsolation); the page sees `window.agentHQ` and nothing
// else from Electron. Its side of the bridge is apps/web/src/desktop.ts.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentHQ', {
  /** Resolves the chosen folder's absolute path, or null when cancelled. */
  pickFolder: (defaultPath) => ipcRenderer.invoke('agent-hq:pick-folder', typeof defaultPath === 'string' ? defaultPath : null),
  /** { api, platform, appName }. Rejects when the running app is older than this file: it needs a restart. */
  info: () => ipcRenderer.invoke('agent-hq:info'),
  /** The Screen Recording permission (macOS): 'granted', 'denied', 'not-determined'… */
  screenAccess: () => ipcRenderer.invoke('agent-hq:screen-access'),
  /** Opens System Settings at Screen & System Audio Recording (macOS). */
  openScreenSettings: () => ipcRenderer.invoke('agent-hq:open-screen-settings'),
});
