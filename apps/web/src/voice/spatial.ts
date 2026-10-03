// Who hears whom. Pure functions over the world snapshot, shared by the voice
// engine (what to send, how loud to play) and the HUD and 3D (who's in the
// meeting, who's in range). Every client computes the same answer from the
// same presence data, so senders and listeners agree without extra messages.

import type { Floor, ID, Snapshot, VoiceState } from '@agent-hq/protocol';
import { fixtures, floorPlan, inMeetingRoom, meetingRoom, type FloorPlan, type MeetingRoom, type Vec3 } from '../office3d/layout.ts';

/** Presence older than this is ignored, as Players.tsx does. */
const STALE_MS = 10 * 60_000;
/** Full volume up to this distance (meters); proximity voice fades out from here to the radius. */
const NEAR = 1.5;

export interface Spot {
  floorId: ID;
  position: Vec3;
  /** Yaw (first person) or 0 for parked avatars. */
  rotation: number;
  /** Walking in first person (as opposed to parked at the boss desk or by the elevator). */
  walking: boolean;
}

const plans = new Map<number, { plan: FloorPlan; meeting: MeetingRoom }>();
export function floorGeometry(floor: Pick<Floor, 'desks'>) {
  let g = plans.get(floor.desks);
  if (!g) {
    const plan = floorPlan(floor.desks);
    g = { plan, meeting: meetingRoom(plan) };
    plans.set(floor.desks, g);
  }
  return g;
}

/**
 * Where every online player's avatar stands, mirroring Players.tsx: walkers
 * where they are, the boss behind the executive desk, others by the elevator.
 */
export function avatarSpots(world: Snapshot, now = Date.now()): Map<ID, Spot> {
  const spots = new Map<ID, Spot>();
  const lobby = new Map<ID, number>();
  for (const p of world.presence) {
    if (!p.floorId || now - p.ts >= STALE_MS) continue;
    const user = world.users.find((u) => u.id === p.userId);
    const floor = world.floors.find((f) => f.id === p.floorId);
    if (!user?.online || !floor) continue;
    if (p.mode === 'walk') {
      spots.set(user.id, { floorId: floor.id, position: p.position, rotation: p.rotation, walking: true });
      continue;
    }
    const f = fixtures(floorGeometry(floor).plan);
    if (user.role === 'owner') {
      spots.set(user.id, { floorId: floor.id, position: f.bossSeat, rotation: 0, walking: false });
    } else {
      const i = lobby.get(floor.id) ?? 0;
      lobby.set(floor.id, i + 1);
      spots.set(user.id, { floorId: floor.id, position: f.lobby(i), rotation: 0, walking: false });
    }
  }
  return spots;
}

/** The floor whose meeting a player is in: physically in its room, or joined from elsewhere. */
export function meetingOf(world: Snapshot, spots: Map<ID, Spot>, userId: ID, voice: VoiceState | undefined): ID | null {
  const spot = spots.get(userId);
  if (spot?.walking) {
    const floor = world.floors.find((f) => f.id === spot.floorId);
    if (floor && inMeetingRoom(floorGeometry(floor).meeting, spot.position)) return floor.id;
  }
  return voice?.meeting ?? null;
}

/** Players in a floor's meeting (in voice or not). */
export function meetingMembers(world: Snapshot, spots: Map<ID, Spot>, floorId: ID): ID[] {
  return world.users
    .filter((u) => u.online && meetingOf(world, spots, u.id, world.voice.find((v) => v.userId === u.id)) === floorId)
    .map((u) => u.id);
}

export type Channel = 'proximity' | 'global' | `meeting:${string}`;

/** The meeting room's channel wins; otherwise the player's chosen mode. */
export function channelOf(world: Snapshot, spots: Map<ID, Spot>, voice: VoiceState): Channel {
  const meeting = meetingOf(world, spots, voice.userId, voice);
  return meeting ? `meeting:${meeting}` : voice.mode;
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

/** Proximity volume: full when close, fading to silence at the radius. */
export function proximityGain(d: number, radius: number): number {
  if (d <= NEAR) return 1;
  if (d >= radius) return 0;
  const t = (d - NEAR) / (radius - NEAR);
  return (1 - t) * (1 - t);
}

export interface Hearing {
  channel: Channel;
  /** 0..1 before the listener's own volume setting. */
  gain: number;
  /** Proximity: meters between the avatars (null when not on the same floor). */
  distance: number | null;
}

/**
 * How well `a` hears `b` (symmetric). `slack` widens the proximity radius:
 * senders use a little slack so listeners can fade out smoothly.
 */
export function hearing(world: Snapshot, spots: Map<ID, Spot>, a: VoiceState, b: VoiceState, slack = 0): Hearing {
  const ca = channelOf(world, spots, a);
  const cb = channelOf(world, spots, b);
  if (ca !== cb) return { channel: ca, gain: 0, distance: null };
  if (ca !== 'proximity') return { channel: ca, gain: 1, distance: null };
  const sa = spots.get(a.userId);
  const sb = spots.get(b.userId);
  if (!sa || !sb || sa.floorId !== sb.floorId) return { channel: ca, gain: 0, distance: null };
  const d = distance(sa.position, sb.position);
  const radius = world.settings.voice.proximityRadius;
  return { channel: ca, gain: d < radius + slack ? Math.max(proximityGain(d, radius), slack ? 1e-3 : 0) : 0, distance: d };
}
