import type { DecorItem, FloorTheme } from '@agent-hq/protocol';
import { catalogItem, type CatalogItem } from '@agent-hq/protocol/catalog';
import { colliders, fixtures, toWorld, WALL_HEIGHT, windowSpots, type FloorPlan, type Rect } from '../layout.ts';

// Where decorations may go: grid snapping, hanging things on walls, and
// collisions with the walls, the fixed furniture, the desks and each other.

export const GRID = 0.25;
/** How far inside the walls' center lines the room's usable floor starts. */
const WALL_INSET = 0.1;
/** Wall items hang on the wall's surface (walls are 0.15 thick). */
const WALL_SURFACE = 0.08;

export type Wall = 'back' | 'left';

export interface Pose {
  x: number;
  z: number;
  rotation: number;
}

/** Axis-aligned rectangle an item covers on the floor plan. */
export function itemRect(entry: CatalogItem, pose: Pose): Rect {
  const [w, d] = entry.footprint;
  const z0 = entry.mount === 'wall' ? 0 : -d / 2;
  const z1 = entry.mount === 'wall' ? d : d / 2;
  const q = ((pose.rotation % 4) + 4) % 4;
  // Quarter turns keep rectangles axis-aligned (see parts.ts placement()).
  const corners: Array<[number, number]> = [[-w / 2, z0], [w / 2, z1]].map(([lx, lz]) => {
    switch (q) {
      case 1: return [lz, -lx];
      case 2: return [-lx, -lz];
      case 3: return [-lz, lx];
      default: return [lx, lz];
    }
  });
  return {
    minX: pose.x + Math.min(corners[0][0], corners[1][0]),
    maxX: pose.x + Math.max(corners[0][0], corners[1][0]),
    minZ: pose.z + Math.min(corners[0][1], corners[1][1]),
    maxZ: pose.z + Math.max(corners[0][1], corners[1][1]),
  };
}

const overlaps = (a: Rect, b: Rect, eps = 0.005) =>
  a.minX < b.maxX - eps && a.maxX > b.minX + eps && a.minZ < b.maxZ - eps && a.maxZ > b.minZ + eps;

/** Snap a center so the item's edges sit on the grid. */
function snap(center: number, size: number, grid: boolean) {
  if (!grid) return Math.round(center * 100) / 100;
  const edge = center - size / 2;
  return Math.round(edge / GRID) * GRID + size / 2;
}

/** The wall an item hangs on, from its rotation. */
export const wallOf = (rotation: number): Wall => (rotation === 1 ? 'left' : 'back');

/**
 * Turns a pointer position into a pose for an item: snapped to the grid,
 * and for wall items onto the back or left wall (the ones that stay up in
 * the overview), using where the pointer ray hits them.
 */
export function poseFor(entry: CatalogItem, plan: FloorPlan, floorPoint: { x: number; z: number }, rotation: number, grid: boolean, wallHit: { wall: Wall; along: number } | null): Pose {
  const [w, d] = entry.footprint;
  if (entry.mount === 'wall') {
    const wall = wallHit?.wall ?? (floorPoint.z - plan.minZ < floorPoint.x - plan.minX ? 'back' : 'left');
    const along = wallHit?.along ?? (wall === 'back' ? floorPoint.x : floorPoint.z);
    if (wall === 'back') return { x: snap(along, w, grid), z: plan.minZ + WALL_SURFACE, rotation: 0 };
    return { x: plan.minX + WALL_SURFACE, z: snap(along, w, grid), rotation: 1 };
  }
  const [sx, sz] = rotation % 2 ? [d, w] : [w, d];
  return { x: snap(floorPoint.x, sx, grid), z: snap(floorPoint.z, sz, grid), rotation };
}

/** Intersects a ray with the back and left walls; the closest hit inside a wall wins. */
export function wallHit(plan: FloorPlan, origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }): { wall: Wall; along: number } | null {
  const hits: Array<{ t: number; wall: Wall; along: number }> = [];
  const back = plan.minZ + WALL_SURFACE;
  if (Math.abs(dir.z) > 1e-6) {
    const t = (back - origin.z) / dir.z;
    const x = origin.x + dir.x * t, y = origin.y + dir.y * t;
    if (t > 0 && y > 0.3 && y < WALL_HEIGHT && x > plan.minX && x < plan.maxX) hits.push({ t, wall: 'back', along: x });
  }
  const left = plan.minX + WALL_SURFACE;
  if (Math.abs(dir.x) > 1e-6) {
    const t = (left - origin.x) / dir.x;
    const z = origin.z + dir.z * t, y = origin.y + dir.y * t;
    if (t > 0 && y > 0.3 && y < WALL_HEIGHT && z > plan.minZ && z < plan.maxZ) hits.push({ t, wall: 'left', along: z });
  }
  hits.sort((a, b) => a.t - b.t);
  return hits[0] ?? null;
}

export interface Check {
  ok: boolean;
  reason: string | null;
}

/** Spots that must stay walkable: the boss room door, the elevator, the whiteboard. */
function keepClear(plan: FloorPlan): Rect[] {
  const f = fixtures(plan);
  const b = plan.boss;
  return [
    { minX: b.maxX - 0.7, maxX: b.maxX + 0.7, minZ: b.maxZ - 1.4, maxZ: b.maxZ + 0.2 },
    { minX: f.elevator[0] - 1.1, maxX: f.elevator[0] + 1.1, minZ: plan.minZ, maxZ: plan.minZ + 1.5 },
    { minX: f.whiteboard[0] - 1.7, maxX: f.whiteboard[0] + 1.7, minZ: plan.minZ, maxZ: plan.minZ + 1 },
    { minX: f.spawn[0] - 0.4, maxX: f.spawn[0] + 0.4, minZ: f.spawn[2] - 0.4, maxZ: f.spawn[2] + 0.4 },
  ];
}

/** Stretches of the back and left walls that are taken by windows and fixtures. */
function wallBlocked(plan: FloorPlan, theme: FloorTheme, wall: Wall): Array<[number, number]> {
  // Glass walls have no windows to keep clear.
  const spots = theme.wall === 'glass' ? { back: [], left: [] } : windowSpots(plan);
  const f = fixtures(plan);
  if (wall === 'back') {
    return [
      ...spots.back.map((x) => [x - 0.95, x + 0.95] as [number, number]),
      [f.whiteboard[0] - 1.7, f.whiteboard[0] + 1.7],
      [f.elevator[0] - 1, f.elevator[0] + 1.15],
      // where the boss room's glass meets the wall
      [plan.boss.maxX - 0.12, plan.boss.maxX + 0.12],
    ];
  }
  return spots.left.map((z) => [z - 0.95, z + 0.95] as [number, number]);
}

/** Can `entry` go at `pose`, given what's already on the floor (`ignoreId`: the item being moved)? */
export function checkPlacement(entry: CatalogItem, pose: Pose, plan: FloorPlan, theme: FloorTheme, items: DecorItem[], ignoreId: string | null = null): Check {
  const r = itemRect(entry, pose);
  const others = items.filter((i) => i.id !== ignoreId).map((i) => ({ item: i, entry: catalogItem(i.itemId) })).filter((o) => !!o.entry);
  if (entry.mount === 'wall') {
    const wall = wallOf(pose.rotation);
    const [a, b] = wall === 'back' ? [r.minX, r.maxX] : [r.minZ, r.maxZ];
    const [lo, hi] = wall === 'back' ? [plan.minX + WALL_INSET, plan.maxX - WALL_INSET] : [plan.minZ + WALL_INSET, plan.maxZ - WALL_INSET];
    if (a < lo || b > hi) return { ok: false, reason: 'Off the wall' };
    if (wallBlocked(plan, theme, wall).some(([x0, x1]) => a < x1 && b > x0)) return { ok: false, reason: 'In the way of a window or fixture' };
    for (const o of others) {
      if (o.entry!.mount !== 'wall' || wallOf(o.item.rotation) !== wall) continue;
      const or = itemRect(o.entry!, o.item);
      const [c, d] = wall === 'back' ? [or.minX, or.maxX] : [or.minZ, or.maxZ];
      // Wall things can hang above each other when their heights differ enough.
      const vertical = Math.abs(o.entry!.height - entry.height) > 0.75;
      if (!vertical && a < d - 0.005 && b > c + 0.005) return { ok: false, reason: `Overlaps the ${o.entry!.name.toLowerCase()}` };
    }
    return { ok: true, reason: null };
  }
  if (r.minX < plan.minX + WALL_INSET || r.maxX > plan.maxX - WALL_INSET || r.minZ < plan.minZ + WALL_INSET || r.maxZ > plan.maxZ - WALL_INSET) {
    return { ok: false, reason: 'Hits a wall' };
  }
  if (entry.mount === 'rug') {
    const rug = others.find((o) => o.entry!.mount === 'rug' && overlaps(r, itemRect(o.entry!, o.item)));
    return rug ? { ok: false, reason: `Overlaps the ${rug.entry!.name.toLowerCase()}` } : { ok: true, reason: null };
  }
  if (colliders(plan, theme).some((c) => overlaps(r, c))) return { ok: false, reason: 'Blocked by furniture or a desk' };
  if (keepClear(plan).some((c) => overlaps(r, c))) return { ok: false, reason: 'Keep doors and fixtures clear' };
  const hit = others.find((o) => o.entry!.mount === 'floor' && overlaps(r, itemRect(o.entry!, o.item)));
  if (hit) return { ok: false, reason: `Overlaps the ${hit.entry!.name.toLowerCase()}` };
  return { ok: true, reason: null };
}

/** Floor decorations the first-person player can't walk through. */
export function decorColliders(items: DecorItem[]): Rect[] {
  const out: Rect[] = [];
  for (const i of items) {
    const entry = catalogItem(i.itemId);
    if (entry?.mount === 'floor') out.push(itemRect(entry, i));
  }
  return out;
}

/** The desk slot under a floor point, if any (decorate mode: click a desk to restyle it). */
export function deskAt(plan: FloorPlan, x: number, z: number): number | null {
  let best: { index: number; d: number } | null = null;
  for (const slot of plan.slots) {
    const [cx, , cz] = toWorld(slot.position, slot.rotation, [0, 0, -0.3]);
    const d = Math.hypot(cx - x, cz - z);
    if (d < 0.75 && (!best || d < best.d)) best = { index: slot.index, d };
  }
  return best?.index ?? null;
}
