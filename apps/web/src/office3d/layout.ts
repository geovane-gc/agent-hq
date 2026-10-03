// Floor plan math. Desks come in pods of two facing each other; pods are laid
// out in a grid that grows with the office's agent capacity. Fixed furniture
// positions and collision boxes live here too, so the room, the cameras and
// the players all agree on where things are.

import type { FloorTheme } from '@agent-hq/protocol';

export type Vec3 = [number, number, number];

export interface Slot {
  index: number;
  position: Vec3;
  /** Rotation around Y. Workstations are modeled facing -Z (the screen side). */
  rotation: number;
}

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface FloorPlan extends Rect {
  slots: Slot[];
  center: Vec3;
  boss: Rect;
}

const POD_SPACING_X = 4;
const ROW_SPACING_Z = 3.2;
const PODS_PER_ROW = 3;
const BOSS_ROOM_WIDTH = 6;
export const WALL_HEIGHT = 3;

export function floorPlan(capacity: number): FloorPlan {
  const pods = Math.max(1, Math.ceil(capacity / 2));
  const cols = Math.min(PODS_PER_ROW, pods);
  const rows = Math.ceil(pods / cols);

  const slots: Slot[] = [];
  for (let i = 0; i < capacity; i++) {
    const pod = Math.floor(i / 2);
    const col = pod % cols;
    const row = Math.floor(pod / cols);
    const cx = col * POD_SPACING_X;
    const cz = row * ROW_SPACING_Z;
    const left = i % 2 === 0;
    // Left desk: agent sits at -x and faces +x (rotation -90°); right mirrors it.
    slots.push({ index: i, position: [cx + (left ? -0.92 : 0.92), 0, cz], rotation: left ? -Math.PI / 2 : Math.PI / 2 });
  }

  const marginX = 3;
  const marginFront = 7; // lounge area
  const marginBack = 4.5; // room for the whiteboard, elevator and lounge
  const minX = -marginX - 1;
  const maxX = (cols - 1) * POD_SPACING_X + marginX + 1;
  const minZ = -marginBack;
  const maxZ = (rows - 1) * ROW_SPACING_Z + marginFront;

  return {
    slots,
    minX: minX - BOSS_ROOM_WIDTH,
    maxX,
    minZ,
    maxZ,
    center: [(minX - BOSS_ROOM_WIDTH + maxX) / 2, 0, (minZ + maxZ) / 2],
    boss: { minX: minX - BOSS_ROOM_WIDTH, maxX: minX, minZ, maxZ: minZ + 6 },
  };
}

/** Transforms a point from a rotated group's local space to world space. */
export function toWorld(origin: Vec3, rotation: number, local: Vec3): Vec3 {
  const [x, y, z] = local;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return [origin[0] + x * c + z * s, origin[1] + y, origin[2] - x * s + z * c];
}

export interface Fixtures {
  lounge: Vec3;
  /** Executive desk group; rotated -90° so the boss faces the door (+X). */
  bossDesk: Vec3;
  bossDeskRotation: number;
  /** Where the boss sits (the boss chair). */
  bossSeat: Vec3;
  whiteboard: Vec3;
  elevator: Vec3;
  plants: Array<{ position: Vec3; tall: boolean; scale: number }>;
  bossPlant: Vec3;
  bossLamp: Vec3;
  /** Where players stand when they aren't walking around. */
  lobby: (index: number) => Vec3;
  /** First-person spawn point: just outside the boss room door. */
  spawn: Vec3;
}

export function fixtures(plan: FloorPlan): Fixtures {
  const b = plan.boss;
  const bcx = (b.minX + b.maxX) / 2;
  const bcz = (b.minZ + b.maxZ) / 2;
  const bossDesk: Vec3 = [bcx - 0.6, 0, bcz - 0.4];
  const elevator: Vec3 = [plan.maxX - 1.6, 0, plan.minZ + 0.08];
  return {
    lounge: [plan.maxX - 4, 0, plan.maxZ - 2.4],
    bossDesk,
    bossDeskRotation: -Math.PI / 2,
    bossSeat: toWorld(bossDesk, -Math.PI / 2, [0, 0, 0.2]),
    whiteboard: [b.maxX + 3.2, 0, plan.minZ + 0.08],
    elevator,
    plants: [
      { position: [plan.maxX - 0.5, 0, plan.minZ + 0.5], tall: true, scale: 1 },
      { position: [b.maxX + 0.5, 0, plan.maxZ - 0.5], tall: false, scale: 1 },
      { position: [b.maxX + 0.6, 0, plan.minZ + 0.6], tall: false, scale: 0.9 },
      { position: [plan.maxX - 0.5, 0, (plan.minZ + plan.maxZ) / 2], tall: true, scale: 1 },
    ],
    bossPlant: [b.minX + 0.6, 0, b.minZ + 0.6],
    bossLamp: [b.minX + 0.6, 0, b.maxZ - 0.7],
    lobby: (i) => [elevator[0] + ((i % 3) - 1) * 0.9, 0, elevator[2] + 1.5 + Math.floor(i / 3) * 0.9],
    spawn: [b.maxX + 1.2, 0, b.maxZ + 1.5],
  };
}

export interface Balcony extends Rect {
  /** Hot desks where summoned repo agents work, facing the office (Workstation slots). */
  desks: Slot[];
  /** Where idle repo agents stand smoking, looking out over the railing. */
  spots: Array<{ position: Vec3; rotation: number }>;
  /** With no crew yet: empty benches, each with an ashtray at its right end, looking out over the railing. */
  benches: Vec3[];
}

const HOT_DESK_SPACING = 1.8;
const HOT_DESK_ROW = 2;
const SMOKER_SPACING = 1.05;

/**
 * The balcony outside the front wall, home of the repo agents: one hot desk
 * per crew member along the glass (from the left), and a smoking corner. A
 * small crew smokes right next to the desks; a bigger one gets rows of desks
 * and the whole railing to smoke at. Every floor has one; until its projects
 * define agents it only has empty benches.
 */
export function balconyLayout(plan: FloorPlan, crew: number): Balcony {
  // The server hands out desk indexes below the crew size, so `crew` desks always suffice.
  const n = crew;
  const minX = plan.boss.maxX + 1;
  const maxX = plan.maxX - 1;
  const width = maxX - minX;
  if (!crew) {
    const count = Math.max(1, Math.min(3, Math.floor(width / 5)));
    const benches = Array.from({ length: count }, (_, i): Vec3 => [minX + (width * (i + 0.5)) / count - 0.3, 0, plan.maxZ + 1.35]);
    return { minX, maxX, minZ: plan.maxZ, maxZ: plan.maxZ + 2.5, desks: [], spots: [], benches };
  }
  const perRow = Math.max(1, Math.floor(width / HOT_DESK_SPACING));
  const rows = Math.ceil(n / perRow);
  const desks: Slot[] = [];
  for (let i = 0; i < n; i++) {
    desks.push({ index: i, position: [minX + 0.9 + (i % perRow) * HOT_DESK_SPACING, 0, plan.maxZ + 1.2 + Math.floor(i / perRow) * HOT_DESK_ROW], rotation: 0 });
  }
  // Facing the view, turned a little towards each other.
  const turn = (i: number) => Math.PI + (i % 2 ? 0.35 : -0.35);
  if (n * (HOT_DESK_SPACING + SMOKER_SPACING) + 0.6 <= width) {
    const x0 = minX + n * HOT_DESK_SPACING + 0.9;
    const spots = Array.from({ length: crew }, (_, i) => ({ position: [x0 + i * SMOKER_SPACING, 0, plan.maxZ + 1.45 + (i % 2) * 0.3] as Vec3, rotation: turn(i) }));
    return { minX, maxX, minZ: plan.maxZ, maxZ: plan.maxZ + 2.5, desks, spots, benches: [] };
  }
  const smokeZ = plan.maxZ + 1.2 + (rows - 1) * HOT_DESK_ROW + 1.35;
  const perLine = Math.max(1, Math.floor(width / SMOKER_SPACING));
  const spots = Array.from({ length: crew }, (_, i) => ({
    // Along the railing from the left, a second line just behind the first if needed.
    position: [minX + 0.6 + (i % perLine) * SMOKER_SPACING + (Math.floor(i / perLine) % 2) * 0.5, 0, smokeZ - Math.floor(i / perLine) * 0.75] as Vec3,
    rotation: turn(i),
  }));
  return { minX, maxX, minZ: plan.maxZ, maxZ: smokeZ + 0.65, desks, spots, benches: [] };
}

/** Something mounted on a wall: center, rotation around Y (facing direction) and size. */
export interface WallMount {
  position: Vec3;
  rotation: number;
  width: number;
  height: number;
}

export interface MeetingRoom extends Rect {
  center: Vec3;
  /** Gap in the partition (at x = maxX) players walk through. */
  door: { minZ: number; maxZ: number };
  table: Rect;
  seats: Array<{ position: Vec3; rotation: number }>;
  /** The big screen on the outer wall, facing into the room (+X). Shows the shared screen. */
  screen: WallMount;
  /**
   * A free stretch of the partition, facing the screen (-X), where the
   * meeting room's whiteboard hangs (OfficeScene mounts a wall WhiteboardStand here).
   */
  whiteboardAnchor: WallMount;
  /** The room is shallower than the floor, so it has its own front partition at maxZ. */
  frontWall: boolean;
}

const MEETING_MAX_DEPTH = 7;
const MEETING_DOOR = 1.3;

/**
 * The meeting room: the strip under the boss room, against the left wall.
 * Its back is the boss room's glass, its right side a partition with a door
 * next to the spawn point. A long table runs from the wall screen (left wall)
 * to the whiteboard spot on the partition.
 */
export function meetingRoom(plan: FloorPlan): MeetingRoom {
  const b = plan.boss;
  const minX = plan.minX;
  const maxX = b.maxX;
  const minZ = b.maxZ;
  const maxZ = Math.min(plan.maxZ, minZ + MEETING_MAX_DEPTH);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const door = { minZ: minZ + 0.25, maxZ: minZ + 0.25 + MEETING_DOOR };
  const tableLength = Math.min(3.2, maxX - minX - 2.6);
  const seats: MeetingRoom['seats'] = [];
  for (const dx of [-1, 0, 1]) {
    seats.push({ position: [cx + dx * 1.0, 0, cz - 1.0], rotation: Math.PI });
    seats.push({ position: [cx + dx * 1.0, 0, cz + 1.0], rotation: 0 });
  }
  const boardWidth = Math.max(1.2, Math.min(2.4, maxZ - door.maxZ - 0.6));
  return {
    minX, maxX, minZ, maxZ,
    center: [cx, 0, cz],
    door,
    table: box(cx, cz, tableLength / 2, 0.6),
    seats,
    screen: { position: [minX + 0.1, 1.55, cz], rotation: Math.PI / 2, width: 2.8, height: 1.575 },
    whiteboardAnchor: { position: [maxX - 0.1, 1.5, (door.maxZ + maxZ) / 2], rotation: -Math.PI / 2, width: boardWidth, height: 1.2 },
    frontWall: maxZ < plan.maxZ - 0.01,
  };
}

/** Is a floor position inside the meeting room (walls excluded)? */
export function inMeetingRoom(room: Rect, position: Vec3): boolean {
  return position[0] > room.minX + 0.1 && position[0] < room.maxX - 0.1 && position[2] > room.minZ + 0.1 && position[2] < room.maxZ - 0.1;
}

const box = (cx: number, cz: number, hx: number, hz: number): Rect => ({ minX: cx - hx, maxX: cx + hx, minZ: cz - hz, maxZ: cz + hz });

/** Solid furniture and partitions the first-person player can't walk through. */
export function colliders(plan: FloorPlan, theme: FloorTheme): Rect[] {
  const f = fixtures(plan);
  const b = plan.boss;
  const out: Rect[] = [];
  // desk pods (desks, chairs and the agents sitting in them)
  for (let i = 0; i < plan.slots.length; i += 2) {
    const a = plan.slots[i].position;
    const c = plan.slots[i + 1]?.position ?? a;
    const cx = (a[0] + c[0]) / 2;
    out.push(box(cx, a[2], plan.slots[i + 1] ? 1.35 : 0.9, 0.75));
  }
  // boss room glass, with a door gap next to the open-plan area
  out.push({ minX: b.maxX - 0.08, maxX: b.maxX + 0.08, minZ: b.minZ, maxZ: b.maxZ - 1.4 });
  out.push({ minX: b.minX, maxX: b.maxX + 0.08, minZ: b.maxZ - 0.08, maxZ: b.maxZ + 0.08 });
  // executive desk and chair
  out.push({ minX: f.bossDesk[0] + 0.02, maxX: f.bossDesk[0] + 1.08, minZ: f.bossDesk[2] - 1.12, maxZ: f.bossDesk[2] + 1.12 });
  out.push(box(f.bossSeat[0], f.bossSeat[2], 0.38, 0.38));
  out.push(box(f.bossPlant[0], f.bossPlant[2], 0.3, 0.3), box(f.bossLamp[0], f.bossLamp[2], 0.22, 0.22));
  // wall fixtures
  out.push({ minX: f.whiteboard[0] - 1.7, maxX: f.whiteboard[0] + 1.7, minZ: plan.minZ, maxZ: plan.minZ + 0.3 });
  out.push({ minX: f.elevator[0] - 0.95, maxX: f.elevator[0] + 0.95, minZ: plan.minZ, maxZ: plan.minZ + 0.35 });
  if (theme.lounge) {
    const [lx, , lz] = f.lounge;
    out.push(box(lx, lz - 0.95, 1.05, 0.45), box(lx, lz + 0.25, 0.5, 0.5), box(lx + 2.2, lz - 1.0, 0.5, 0.35), box(lx - 1.45, lz - 1.1, 0.22, 0.22));
  }
  if (theme.plants) for (const p of f.plants) out.push(box(p.position[0], p.position[2], 0.3 * p.scale, 0.3 * p.scale));
  // meeting room: partition with a door, front partition, table and chairs
  const m = meetingRoom(plan);
  out.push({ minX: m.maxX - 0.08, maxX: m.maxX + 0.08, minZ: m.minZ, maxZ: m.door.minZ });
  out.push({ minX: m.maxX - 0.08, maxX: m.maxX + 0.08, minZ: m.door.maxZ, maxZ: m.maxZ });
  if (m.frontWall) out.push({ minX: m.minX, maxX: m.maxX + 0.08, minZ: m.maxZ - 0.08, maxZ: m.maxZ + 0.08 });
  out.push(m.table);
  for (const s of m.seats) out.push(box(s.position[0], s.position[2], 0.24, 0.24));
  return out;
}

// ---------------------------------------------------------------- office customization
// Shared by the room (where windows are drawn) and decorate mode (wall decor can't cover them).

/** Window centers along the back wall (x) and the left wall (z); none behind the meeting room's wall screen. */
export function windowSpots(plan: FloorPlan): { back: number[]; left: number[] } {
  const back: number[] = [];
  for (let x = plan.boss.maxX + 6.2; x < plan.maxX - 3.4; x += 3.2) back.push(x);
  const meeting = meetingRoom(plan);
  const left: number[] = [];
  for (let z = plan.minZ + 1.5; z < plan.maxZ - 1; z += 3) if (z < meeting.minZ - 1 || z > meeting.maxZ + 1) left.push(z);
  return { back, left };
}
