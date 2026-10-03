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

/** The balcony's footprint along the front wall; it only depends on the floor, never on the crew. */
export interface BalconyFront {
  /** The deck runs along most of the front wall, in front of the meeting room too. */
  minX: number;
  maxX: number;
  /** The stretch of the front wall that is glass: the open-plan part, never the meeting room's wall. */
  glass: { minX: number; maxX: number };
  /** The sliding glass door in it, the way out to the balcony. */
  door: { minX: number; maxX: number };
}

export interface Balcony extends Rect, BalconyFront {
  /** Hot desks where summoned repo agents work, facing the office (Workstation slots). */
  desks: Slot[];
  /** Where idle repo agents stand smoking, looking out over the railing. */
  spots: Array<{ position: Vec3; rotation: number }>;
  /** Benches looking out over the railing, each with an ashtray at its right end. */
  benches: Vec3[];
  plants: Array<{ position: Vec3; tall: boolean }>;
  /**
   * Where repo agents walk between the railing and the hot desks: the aisle
   * running from the door to the railing (x), and the aisle behind each row
   * of desks (z, by row).
   */
  aisles: { x: number; z: number[] };
}

/** Solid wall kept at the ends of the glass (by the meeting room's partition, by the right wall). */
const GLASS_INSET = 0.5;
const DOOR_WIDTH = 1.6;
/** Door center from the left end of the glass: close to the spawn point, clear of the corner plant and the lounge. */
const DOOR_OFFSET = 2.3;
const DECK_INSET = 0.5;
/** Free strip along the glass, in front of the door and the desks. */
const WALKWAY = 1.2;
const HOT_DESK_SPACING = 1.7;
const HOT_DESK_ROW = 2.6;
/** A hot desk's extent in z, from its position (rotation 0: screen towards the office, chair towards the railing). */
const DESK_FRONT = 0.92;
const DESK_BACK = 0.43;
/** From the last row of desks to the smokers along the railing. */
const SMOKE_AISLE = 1.3;
const SMOKER_SPACING = 1.05;
const SMOKER_LINE = 0.75;
/** Extra room between the smokers on either side of the door aisle. */
const AISLE_GAP = 1;
const RAILING_GAP = 0.55;
/** A bench and the ashtray at its right end. */
const BENCH_LENGTH = 2;
const BENCH_GAP = 0.8;

/** Where the balcony goes on a floor: deck, glass and door. */
export function balconyFront(plan: FloorPlan): BalconyFront {
  const glassMin = meetingRoom(plan).maxX + GLASS_INSET;
  const glassMax = plan.maxX - GLASS_INSET;
  const doorX = Math.min(glassMin + DOOR_OFFSET, (glassMin + glassMax) / 2);
  return {
    minX: plan.minX + DECK_INSET,
    maxX: plan.maxX - DECK_INSET,
    glass: { minX: glassMin, maxX: glassMax },
    door: { minX: doorX - DOOR_WIDTH / 2, maxX: doorX + DOOR_WIDTH / 2 },
  };
}

/**
 * The balcony outside the front wall, home of the repo agents. A walkway runs
 * along the glass, and an aisle from the sliding door straight to the
 * railing; hot desks (one per crew member) line up on both sides of it,
 * nearest the door first, in more rows when a row is full; the crew smokes
 * at the railing on both sides of the aisle, in more lines when it's long,
 * with benches on the free stretches. It's as wide as most of the front wall and
 * at least about half as deep as the floor. Every floor has one; until its
 * projects define agents it only has empty benches.
 */
export function balconyLayout(plan: FloorPlan, crew: number): Balcony {
  const front = balconyFront(plan);
  const { minX, maxX, door } = front;
  const z0 = plan.maxZ;
  const doorX = (door.minX + door.maxX) / 2;
  const minDepth = Math.min(7, Math.max(5, (plan.maxZ - plan.minZ) * 0.45));

  // Hot desk columns on both sides of the door aisle, nearest first.
  const columns: number[] = [];
  for (let x = door.maxX + 0.35 + 0.75; x + 0.75 <= maxX - 0.3; x += HOT_DESK_SPACING) columns.push(x);
  for (let x = door.minX - 0.35 - 0.75; x - 0.75 >= minX + 0.3; x -= HOT_DESK_SPACING) columns.push(x);
  columns.sort((a, b) => Math.abs(a - doorX) - Math.abs(b - doorX));
  const perRow = Math.max(1, columns.length);
  // The server hands out desk indexes below the crew size, so `crew` desks always suffice.
  const rows = crew ? Math.ceil(crew / perRow) : 0;
  const deskZ = (row: number) => z0 + WALKWAY + DESK_FRONT + row * HOT_DESK_ROW;
  const desks: Slot[] = Array.from({ length: crew }, (_, i) => ({
    index: i,
    position: [columns[i % perRow] ?? doorX + 1.5, 0, deskZ(Math.floor(i / perRow))],
    rotation: 0,
  }));

  // Smokers along the railing, on both sides of the door aisle (which stays open to the railing), more lines
  // inwards when needed.
  const lineMin = minX + 1; // clear of the corner plant
  const lineMax = maxX - 0.6;
  // The spots nearest the aisle on each side, and how many fit from there to each end.
  const nearLeft = doorX - (SMOKER_SPACING + AISLE_GAP) / 2;
  const nearRight = doorX + (SMOKER_SPACING + AISLE_GAP) / 2;
  const fitLeft = Math.max(0, Math.floor((nearLeft - lineMin) / SMOKER_SPACING) + 1);
  const fitRight = Math.max(0, Math.floor((lineMax - nearRight) / SMOKER_SPACING) + 1);
  const perLine = Math.max(1, fitLeft + fitRight);
  const lines = Math.ceil(crew / perLine);
  const content = crew ? WALKWAY + DESK_FRONT + (rows - 1) * HOT_DESK_ROW + DESK_BACK + SMOKE_AISLE + RAILING_GAP + (lines - 1) * SMOKER_LINE : 0;
  const maxZ = z0 + Math.max(minDepth, content);
  // Facing the view, turned a little towards each other.
  const turn = (i: number) => Math.PI + (i % 2 ? 0.35 : -0.35);
  const spots: Balcony['spots'] = [];
  for (let line = 0; line < lines; line++) {
    const count = Math.min(perLine, crew - line * perLine);
    // Half on each side of the aisle, more on the side with room when the other one is full.
    const left = Math.min(fitLeft, Math.max(count - fitRight, Math.ceil(count / 2)));
    for (let k = 0; k < count; k++) {
      const i = line * perLine + k;
      const x = k < left ? nearLeft - (left - 1 - k) * SMOKER_SPACING : nearRight + (k - left) * SMOKER_SPACING;
      spots.push({ position: [x, 0, maxZ - RAILING_GAP - line * SMOKER_LINE - (k % 2) * 0.12], rotation: turn(i) });
    }
  }

  // Benches: spread along the railing while there's no crew; on the free ends of it otherwise.
  const benchZ = maxZ - 0.75;
  const benches: Vec3[] = [];
  if (!crew) {
    const count = Math.max(1, Math.min(4, Math.round((maxX - minX) / 5)));
    for (let i = 0; i < count; i++) benches.push([minX + ((maxX - minX) * (i + 0.5)) / count - 0.3, 0, benchZ]);
  } else {
    const xs = spots.filter((s) => s.position[2] > maxZ - RAILING_GAP - 0.2).map((s) => s.position[0]);
    // Up to two on each free end of the railing, grouped in the middle of it.
    for (const [from, to] of [[minX + 0.75, Math.min(...xs) - 0.6], [Math.max(...xs) + 0.6, maxX - 0.75]]) {
      const count = Math.min(2, Math.floor((to - from + BENCH_GAP) / (BENCH_LENGTH + BENCH_GAP)));
      const start = (from + to) / 2 - (count * BENCH_LENGTH + (count - 1) * BENCH_GAP) / 2;
      for (let i = 0; i < count; i++) benches.push([start + 0.78 + i * (BENCH_LENGTH + BENCH_GAP), 0, benchZ]);
    }
  }

  return {
    ...front,
    minZ: z0,
    maxZ,
    desks,
    spots,
    benches,
    plants: [
      { position: [minX + 0.4, 0, maxZ - 0.4], tall: false },
      { position: [maxX - 0.35, 0, z0 + 0.35], tall: true },
      { position: [minX + 0.35, 0, z0 + 0.35], tall: true },
    ],
    aisles: { x: doorX, z: Array.from({ length: rows }, (_, r) => deskZ(r) + DESK_BACK + 0.62) },
  };
}

/** Where a repo agent sits at a hot desk (the Workstation's chair). */
const hotDeskChair = (desk: Slot): Vec3 => [desk.position[0], 0, desk.position[2] + 0.08];

/**
 * A repo agent's walk from its smoking spot to its hot desk, along the
 * aisles (reverse it for the way back): into the aisle behind the last row of
 * desks, through the door aisle to the desk's row if it's further in, then
 * along that row to the chair.
 */
export function balconyRoute(layout: Balcony, from: Vec3, desk: Slot): Vec3[] {
  const rows = layout.aisles.z;
  const row = Math.max(0, Math.min(rows.length - 1, rows.findIndex((z) => z > desk.position[2])));
  const last = rows[rows.length - 1] ?? from[2];
  const chair = hotDeskChair(desk);
  const route: Vec3[] = [from, [from[0], 0, last]];
  if (rows[row] !== undefined && rows[row] !== last) route.push([layout.aisles.x, 0, last], [layout.aisles.x, 0, rows[row]]);
  route.push([chair[0], 0, rows[row] ?? last], chair);
  return route.filter((p, i) => i === 0 || Math.hypot(p[0] - route[i - 1][0], p[2] - route[i - 1][2]) > 0.01);
}

/**
 * What stops the first-person player on the balcony side: the front wall with
 * its door, the railing (and everything beyond it), the balcony's furniture
 * and the crew members standing at their smoking spots (`smoking`: spot indexes).
 */
export function balconyColliders(plan: FloorPlan, balcony: Balcony, smoking: number[] = []): Rect[] {
  const { door } = balcony;
  const out: Rect[] = [
    // front wall, with the door gap
    { minX: plan.minX, maxX: door.minX, minZ: plan.maxZ - 0.08, maxZ: plan.maxZ + 0.08 },
    { minX: door.maxX, maxX: plan.maxX, minZ: plan.maxZ - 0.08, maxZ: plan.maxZ + 0.08 },
    // railing: the far side, and the drop on both ends of the deck
    { minX: plan.minX - 1, maxX: plan.maxX + 1, minZ: balcony.maxZ - 0.04, maxZ: balcony.maxZ + 1 },
    { minX: plan.minX - 1, maxX: balcony.minX + 0.04, minZ: plan.maxZ, maxZ: balcony.maxZ + 1 },
    { minX: balcony.maxX - 0.04, maxX: plan.maxX + 1, minZ: plan.maxZ, maxZ: balcony.maxZ + 1 },
  ];
  // hot desks (desk, chair and whoever sits there)
  for (const d of balcony.desks) out.push({ minX: d.position[0] - 0.75, maxX: d.position[0] + 0.75, minZ: d.position[2] - DESK_FRONT, maxZ: d.position[2] + DESK_BACK + 0.1 });
  for (const b of balcony.benches) out.push(box(b[0], b[2], 0.78, 0.3), box(b[0] + 1.05, b[2] + 0.05, 0.15, 0.15));
  for (const p of balcony.plants) out.push(box(p.position[0], p.position[2], 0.3, 0.3));
  for (const i of smoking) {
    const spot = balcony.spots[i]?.position;
    if (spot) out.push(box(spot[0], spot[2], 0.22, 0.22));
  }
  return out;
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
