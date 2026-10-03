import type { AgentStatus } from '@agent-hq/protocol';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: 'Idle',
  working: 'Working',
  awaiting_approval: 'Needs approval',
  error: 'Error',
  offline: 'Offline',
};

/** Shown on desk bubbles and next to status labels in the HUD. */
export const STATUS_ICON: Record<AgentStatus, string> = {
  working: '⌨️',
  awaiting_approval: '✋',
  error: '⚠️',
  idle: '☕',
  offline: '💤',
};

/**
 * Models offered when hiring or editing an agent. The value is passed as-is to
 * `claude --model`: an alias follows the newest model of that family, a full id
 * pins one version. '' keeps the model chosen in the account's Claude Code settings.
 */
export const MODELS: Array<{ group: string; options: Array<{ value: string; label: string }> }> = [
  { group: 'Default', options: [{ value: '', label: 'Default (account setting)' }] },
  {
    group: 'Latest of a family',
    options: [
      { value: 'fable', label: 'Fable (latest, most capable)' },
      { value: 'opus', label: 'Opus (latest)' },
      { value: 'sonnet', label: 'Sonnet (latest)' },
      { value: 'haiku', label: 'Haiku (latest, fastest)' },
    ],
  },
  {
    group: 'Pinned version',
    options: [
      { value: 'claude-fable-5-1', label: 'Fable 5.1 · claude-fable-5-1' },
      { value: 'claude-opus-5-5', label: 'Opus 5.5 · claude-opus-5-5' },
      { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5 · claude-sonnet-5-5' },
      { value: 'claude-haiku-4-5', label: 'Haiku 4.5 · claude-haiku-4-5' },
    ],
  },
];

/** Friendly name of a stored model value; unknown values (set before this list existed) show as they are. */
export function modelLabel(model: string | null): string {
  for (const g of MODELS) {
    const hit = g.options.find((o) => o.value === (model ?? ''));
    if (hit) return hit.label;
  }
  return model ?? 'Default';
}

/**
 * How the UI names agents with `isManager` set. Players other than the boss
 * are "managers", so agents that plan and delegate are "coordinators".
 */
export const COORDINATOR = {
  label: 'Coordinator',
  help: "Plans work and delegates tasks to teammates; doesn't pick up open tasks itself.",
};

export function level(xp: number) {
  return Math.floor(Math.sqrt(xp / 50)) + 1;
}

/** XP needed to reach a level (the inverse of `level`). */
const levelStart = (lv: number) => 50 * (lv - 1) ** 2;

/** How far an agent is through its current level, in [0, 1], plus the XP still to go. */
export function levelProgress(xp: number) {
  const lv = level(xp);
  const from = levelStart(lv);
  const to = levelStart(lv + 1);
  return { level: lv, progress: (xp - from) / (to - from), toNext: to - xp };
}

/** Stable pseudo-random number in [0, 1) derived from a string (e.g. an agent id). */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}
