// The only bridge between the office page and the desktop app: a native
// folder chooser. Runs isolated from the page (contextIsolation); the page
// sees `window.agentHQ` and nothing else from Electron.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentHQ', {
  /** Resolves the chosen folder's absolute path, or null when cancelled. */
  pickFolder: (defaultPath) => ipcRenderer.invoke('agent-hq:pick-folder', typeof defaultPath === 'string' ? defaultPath : null),
});
