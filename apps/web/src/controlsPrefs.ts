import { useSyncExternalStore } from 'react';

// Camera and mouse preferences. They belong to the player on this browser,
// not to the office: kept in localStorage, never sent to the host. The 3D
// controls read `controlsPrefs.get()` on every event or frame, so a change
// applies live; React components subscribe with `useControlsPrefs()`.

export interface ControlsPrefs {
  /** Walk mode mouse look, as a multiple of the default sensitivity. */
  lookSensitivity: number;
  /** Walk mode: moving the mouse up looks down. */
  invertY: boolean;
  /** Walk mode movement speed (walking and running), as a multiple of the default. */
  walkSpeed: number;
  /** Overview camera: drag to rotate. */
  orbitRotate: number;
  /** Overview camera: right-drag to pan, and WASD sliding. */
  orbitPan: number;
  /** Overview camera: wheel to zoom. */
  orbitZoom: number;
}

export type NumericPref = { [K in keyof ControlsPrefs]: ControlsPrefs[K] extends number ? K : never }[keyof ControlsPrefs];

export const DEFAULT_CONTROLS: ControlsPrefs = {
  lookSensitivity: 1,
  invertY: false,
  walkSpeed: 1,
  orbitRotate: 1,
  orbitPan: 1,
  orbitZoom: 1,
};

/** Allowed range of each multiplier. */
export const CONTROL_RANGES: Record<NumericPref, { min: number; max: number; step: number }> = {
  lookSensitivity: { min: 0.1, max: 3, step: 0.05 },
  walkSpeed: { min: 0.5, max: 2, step: 0.05 },
  orbitRotate: { min: 0.1, max: 3, step: 0.05 },
  orbitPan: { min: 0.1, max: 3, step: 0.05 },
  orbitZoom: { min: 0.1, max: 3, step: 0.05 },
};

const KEY = 'hq-controls';

/** Anything read from storage, made safe: unknown keys dropped, numbers clamped, bad values defaulted. */
function sanitize(raw: unknown): ControlsPrefs {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: ControlsPrefs = { ...DEFAULT_CONTROLS };
  for (const [k, r] of Object.entries(CONTROL_RANGES) as Array<[NumericPref, (typeof CONTROL_RANGES)[NumericPref]]>) {
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(r.max, Math.max(r.min, v));
  }
  if (typeof src.invertY === 'boolean') out.invertY = src.invertY;
  return out;
}

function load(): ControlsPrefs {
  try { return sanitize(JSON.parse(localStorage.getItem(KEY) ?? 'null')); } catch { return { ...DEFAULT_CONTROLS }; }
}

class ControlsStore {
  private prefs = load();
  private readonly listeners = new Set<() => void>();

  constructor() {
    // another tab of the same office changed them
    window.addEventListener('storage', (e) => { if (e.key === KEY) this.apply(load()); });
  }

  get = () => this.prefs;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  set(patch: Partial<ControlsPrefs>) {
    this.apply(sanitize({ ...this.prefs, ...patch }));
    try { localStorage.setItem(KEY, JSON.stringify(this.prefs)); } catch {}
  }

  reset() {
    this.apply({ ...DEFAULT_CONTROLS });
    try { localStorage.removeItem(KEY); } catch {}
  }

  private apply(next: ControlsPrefs) {
    this.prefs = next;
    for (const fn of this.listeners) fn();
  }
}

export const controlsPrefs = new ControlsStore();

export function useControlsPrefs(): ControlsPrefs {
  return useSyncExternalStore(controlsPrefs.subscribe, controlsPrefs.get);
}
