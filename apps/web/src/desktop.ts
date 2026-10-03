// The desktop app (apps/desktop): its bridge (preload.cjs) and whether the
// running app is as new as this page. The page reloads on its own during
// development (and after an update), but the app's main process only changes
// when Agent HQ restarts, so the two can be out of step.

/** The bridge version this page expects (DESKTOP_API in apps/desktop/main.cjs). */
const DESKTOP_API = 2;

export interface DesktopInfo {
  api: number;
  platform: string;
  /** How the app is listed in the system's settings ("Electron" in development). */
  appName: string;
}

declare global {
  interface Window {
    /** The desktop app's bridge (apps/desktop/preload.cjs); absent in a browser. */
    agentHQ?: {
      pickFolder(defaultPath?: string | null): Promise<string | null>;
      info?(): Promise<DesktopInfo | null>;
      screenAccess?(): Promise<string | null>;
      openScreenSettings?(): Promise<boolean>;
    };
  }
}

export const inDesktopApp = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');

let info: Promise<DesktopInfo | null> | null = null;
/** The running desktop app, or null when it's older than this page (or this is a browser). */
export function desktopInfo(): Promise<DesktopInfo | null> {
  info ??= (async () => {
    if (!inDesktopApp || !window.agentHQ?.info) return null;
    try {
      const found = await window.agentHQ.info();
      return found && found.api >= DESKTOP_API ? found : null;
    } catch {
      return null; // the app's main process has no such call yet
    }
  })();
  return info;
}

/** The desktop app needs a restart to match this page (always false in a browser). */
export async function desktopOutdated(): Promise<boolean> {
  return inDesktopApp && !(await desktopInfo());
}

export const RESTART_TEXT = 'Agent HQ was updated while it was running. Quit it and start it again (npm run dev or npm start) to finish the update.';
