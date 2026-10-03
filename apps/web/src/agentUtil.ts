import type { AgentStatus } from '@agent-hq/protocol';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: 'Idle',
  working: 'Working',
  awaiting_approval: 'Needs approval',
  error: 'Error',
  offline: 'Offline',
};

export function level(xp: number) {
  return Math.floor(Math.sqrt(xp / 50)) + 1;
}

/** Stable pseudo-random number in [0, 1) derived from a string (e.g. an agent id). */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}
