// The office customization catalog: every decoration, desk option and room
// style, as data. Shared by the host (validation and prices) and the web app
// (which maps each id to a 3D builder in office3d/decor/items.tsx). To add an
// item: add an entry here and a builder there.
//
// Prices are USD, like the rest of the economy. Career offices pay them
// through the ledger as investments (`furnishing` entries, refunded when an
// item is sold); sandbox offices get everything for free.

import type {
  Appearance,
  BuildingKind,
  ChairModel,
  DeskItem,
  DeskModel,
  DeskStyle,
  FacadeMaterial,
  FloorMaterial,
  FloorTheme,
  LightingPreset,
  WallFinish,
  WindowView,
} from './index.ts';

export type DecorCategory = 'furniture' | 'plants' | 'lighting' | 'wall' | 'rugs' | 'tech' | 'fun';

/**
 * floor: stands on the floor and blocks walking. rug: flat, can go under
 * furniture. wall: hangs on the back or left wall, facing into the room.
 */
export type DecorMount = 'floor' | 'rug' | 'wall';

export interface CatalogItem {
  id: string;
  name: string;
  category: DecorCategory;
  mount: DecorMount;
  /** Size in meters along the item's own X (width) and Z (depth), before rotation. */
  footprint: [number, number];
  /** Height in meters; for wall items, how high its center hangs. */
  height: number;
  price: number;
  /** The player can pick its main color; this is the default. */
  tint?: string;
  /** Lamps: a real light source when placed. */
  light?: { color: string; intensity: number; distance: number; y: number };
  blurb: string;
}

export const DECOR_CATEGORIES: Array<{ id: DecorCategory; label: string; icon: string }> = [
  { id: 'furniture', label: 'Furniture', icon: '🛋️' },
  { id: 'plants', label: 'Plants', icon: '🪴' },
  { id: 'lighting', label: 'Lighting', icon: '💡' },
  { id: 'wall', label: 'Wall decor', icon: '🖼️' },
  { id: 'rugs', label: 'Rugs', icon: '🟫' },
  { id: 'tech', label: 'Tech', icon: '🖥️' },
  { id: 'fun', label: 'Fun', icon: '🎯' },
];

export const DECOR_CATALOG: CatalogItem[] = [
  // ---------------------------------------------------------------- furniture
  { id: 'sofa', name: 'Sofa', category: 'furniture', mount: 'floor', footprint: [2.05, 0.9], height: 0.9, price: 450, tint: '#5b6b8c', blurb: 'Three seats of comfort for long code reviews.' },
  { id: 'armchair', name: 'Armchair', category: 'furniture', mount: 'floor', footprint: [0.9, 0.85], height: 0.85, price: 220, tint: '#b5654a', blurb: 'A deep reading chair.' },
  { id: 'coffee_table', name: 'Coffee table', category: 'furniture', mount: 'floor', footprint: [1, 1], height: 0.5, price: 120, blurb: 'Mugs and magazines included.' },
  { id: 'bookshelf', name: 'Bookshelf', category: 'furniture', mount: 'floor', footprint: [1.2, 0.4], height: 1.9, price: 260, tint: '#8a6a4a', blurb: 'Every RFC you never read.' },
  { id: 'side_table', name: 'Side table', category: 'furniture', mount: 'floor', footprint: [0.5, 0.5], height: 0.55, price: 60, tint: '#d9d4c7', blurb: 'Small, round and useful.' },
  { id: 'bench', name: 'Bench', category: 'furniture', mount: 'floor', footprint: [1.6, 0.45], height: 0.45, price: 140, tint: '#a07850', blurb: 'Wooden slats on steel legs.' },
  { id: 'beanbag', name: 'Bean bag', category: 'furniture', mount: 'floor', footprint: [0.9, 0.9], height: 0.6, price: 90, tint: '#e5484d', blurb: 'Where the best ideas nap.' },
  { id: 'meeting_table', name: 'Round table', category: 'furniture', mount: 'floor', footprint: [1.9, 1.9], height: 0.75, price: 520, tint: '#e8e2d6', blurb: 'Four chairs, one quick sync.' },
  { id: 'cabinet', name: 'Filing cabinet', category: 'furniture', mount: 'floor', footprint: [0.5, 0.6], height: 1.05, price: 110, tint: '#7d8794', blurb: 'Paper trail, lockable.' },

  // ---------------------------------------------------------------- plants
  { id: 'plant', name: 'Potted plant', category: 'plants', mount: 'floor', footprint: [0.5, 0.5], height: 1, price: 40, blurb: 'A friendly leafy bush.' },
  { id: 'plant_tall', name: 'Fiddle-leaf fig', category: 'plants', mount: 'floor', footprint: [0.6, 0.6], height: 1.9, price: 85, blurb: 'Tall, dramatic, needs light.' },
  { id: 'cactus', name: 'Cactus', category: 'plants', mount: 'floor', footprint: [0.4, 0.4], height: 1.1, price: 35, tint: '#c4673f', blurb: 'Low maintenance, high attitude.' },
  { id: 'planter', name: 'Planter box', category: 'plants', mount: 'floor', footprint: [1.4, 0.45], height: 0.85, price: 120, tint: '#3a3f4b', blurb: 'A green divider between teams.' },
  { id: 'palm', name: 'Palm', category: 'plants', mount: 'floor', footprint: [0.8, 0.8], height: 2.1, price: 140, tint: '#d8d2c4', blurb: 'Holiday vibes, all year.' },
  { id: 'hanging_plant', name: 'Wall planter', category: 'plants', mount: 'wall', footprint: [0.5, 0.25], height: 1.9, price: 55, blurb: 'Ivy spilling down the wall.' },

  // ---------------------------------------------------------------- lighting
  { id: 'floor_lamp', name: 'Floor lamp', category: 'lighting', mount: 'floor', footprint: [0.45, 0.45], height: 1.7, price: 75, light: { color: '#ffd9a0', intensity: 2.2, distance: 5, y: 1.55 }, blurb: 'A warm pool of light.' },
  { id: 'arc_lamp', name: 'Arc lamp', category: 'lighting', mount: 'floor', footprint: [1.3, 0.45], height: 2, price: 160, light: { color: '#fff1d6', intensity: 2.6, distance: 6, y: 1.75 }, blurb: 'Leans over a sofa or a table.' },
  { id: 'table_lamp', name: 'Lamp on stand', category: 'lighting', mount: 'floor', footprint: [0.45, 0.45], height: 1, price: 60, tint: '#3d63dd', light: { color: '#ffe2b0', intensity: 1.6, distance: 4, y: 0.9 }, blurb: 'A small stand with a table lamp.' },
  { id: 'neon_sign', name: 'Neon sign', category: 'lighting', mount: 'wall', footprint: [1.4, 0.08], height: 1.95, price: 180, tint: '#ff4fd8', light: { color: '#ff4fd8', intensity: 1.8, distance: 4, y: 1.95 }, blurb: '“Ship it” in glowing tubes.' },
  { id: 'wall_sconce', name: 'Wall sconce', category: 'lighting', mount: 'wall', footprint: [0.3, 0.2], height: 1.9, price: 50, light: { color: '#ffd6a0', intensity: 1.4, distance: 3.5, y: 1.9 }, blurb: 'Soft light up the wall.' },

  // ---------------------------------------------------------------- wall decor
  { id: 'poster', name: 'Art print', category: 'wall', mount: 'wall', footprint: [0.9, 0.05], height: 1.7, price: 45, tint: '#3d63dd', blurb: 'Abstract shapes in your color.' },
  { id: 'painting', name: 'Landscape painting', category: 'wall', mount: 'wall', footprint: [1.3, 0.06], height: 1.65, price: 120, blurb: 'Mountains at sunset, gilded frame.' },
  { id: 'clock', name: 'Wall clock', category: 'wall', mount: 'wall', footprint: [0.5, 0.06], height: 2.15, price: 35, blurb: 'Always shows the real time.' },
  { id: 'wall_shelf', name: 'Wall shelf', category: 'wall', mount: 'wall', footprint: [1.1, 0.25], height: 1.6, price: 70, tint: '#a07850', blurb: 'Books, a trophy and a tiny plant.' },
  { id: 'world_map', name: 'World map', category: 'wall', mount: 'wall', footprint: [1.6, 0.04], height: 1.6, price: 90, blurb: 'Where your users are.' },
  { id: 'corkboard', name: 'Cork board', category: 'wall', mount: 'wall', footprint: [1.1, 0.05], height: 1.55, price: 40, blurb: 'Pinned notes and polaroids.' },

  // ---------------------------------------------------------------- rugs
  { id: 'rug_round', name: 'Round rug', category: 'rugs', mount: 'rug', footprint: [2.4, 2.4], height: 0.02, price: 110, tint: '#c9a46a', blurb: 'Soft and round, with a border.' },
  { id: 'rug_rect', name: 'Area rug', category: 'rugs', mount: 'rug', footprint: [3, 2], height: 0.02, price: 150, tint: '#5b6b8c', blurb: 'Striped wool rug.' },
  { id: 'rug_runner', name: 'Runner', category: 'rugs', mount: 'rug', footprint: [3.2, 0.9], height: 0.02, price: 70, tint: '#8e4ec6', blurb: 'Long and narrow for walkways.' },
  { id: 'rug_grass', name: 'Turf patch', category: 'rugs', mount: 'rug', footprint: [2, 2], height: 0.03, price: 90, blurb: 'Indoor lawn, no mowing.' },

  // ---------------------------------------------------------------- tech
  { id: 'server_rack', name: 'Server rack', category: 'tech', mount: 'floor', footprint: [0.7, 0.9], height: 2, price: 900, blurb: 'Blinking lights, humming fans.' },
  { id: 'tv_stand', name: 'TV on a stand', category: 'tech', mount: 'floor', footprint: [1.5, 0.5], height: 1.6, price: 600, blurb: 'Dashboards, demos and game nights.' },
  { id: 'printer', name: 'Printer', category: 'tech', mount: 'floor', footprint: [0.7, 0.6], height: 1.05, price: 250, blurb: 'PC LOAD LETTER.' },
  { id: 'vending', name: 'Vending machine', category: 'tech', mount: 'floor', footprint: [0.9, 0.8], height: 1.9, price: 700, tint: '#e5484d', blurb: 'Snacks for the night shift.' },
  { id: 'water_cooler', name: 'Water cooler', category: 'tech', mount: 'floor', footprint: [0.45, 0.45], height: 1.3, price: 130, blurb: 'Where the gossip flows.' },
  { id: 'coffee_machine', name: 'Coffee bar', category: 'tech', mount: 'floor', footprint: [1, 0.7], height: 1.35, price: 480, blurb: 'Espresso fuels commits.' },

  // ---------------------------------------------------------------- fun
  { id: 'ping_pong', name: 'Ping-pong table', category: 'fun', mount: 'floor', footprint: [2.75, 1.55], height: 0.9, price: 650, tint: '#2b5fa8', blurb: 'Best of three decides the architecture.' },
  { id: 'foosball', name: 'Foosball table', category: 'fun', mount: 'floor', footprint: [1.45, 0.95], height: 0.95, price: 420, blurb: 'Spinning is allowed here.' },
  { id: 'arcade', name: 'Arcade cabinet', category: 'fun', mount: 'floor', footprint: [0.75, 0.8], height: 1.8, price: 800, tint: '#8e4ec6', blurb: 'One more credit.' },
  { id: 'aquarium', name: 'Aquarium', category: 'fun', mount: 'floor', footprint: [1.3, 0.5], height: 1.35, price: 550, blurb: 'Fish swim while builds run.' },
  { id: 'duck', name: 'Giant rubber duck', category: 'fun', mount: 'floor', footprint: [0.8, 0.9], height: 1, price: 150, tint: '#ffcf33', blurb: 'For rubber-duck debugging, at scale.' },
  { id: 'trophy', name: 'Trophy stand', category: 'fun', mount: 'floor', footprint: [0.6, 0.6], height: 1.4, price: 300, tint: '#e3b341', blurb: 'Employee of the sprint.' },
  { id: 'dartboard', name: 'Dartboard', category: 'fun', mount: 'wall', footprint: [0.6, 0.08], height: 1.73, price: 60, blurb: 'Aim for the bug tracker.' },
];

const BY_ID = new Map(DECOR_CATALOG.map((i) => [i.id, i]));

export function catalogItem(id: string): CatalogItem | undefined {
  return BY_ID.get(id);
}

// ---------------------------------------------------------------- desks

export const DESK_MODELS: Array<{ id: DeskModel; name: string; price: number }> = [
  { id: 'classic', name: 'Oak', price: 0 },
  { id: 'walnut', name: 'Walnut', price: 120 },
  { id: 'white', name: 'White', price: 90 },
  { id: 'black', name: 'Matte black', price: 110 },
];

export const CHAIR_MODELS: Array<{ id: ChairModel; name: string; price: number }> = [
  { id: 'office', name: 'Office chair', price: 0 },
  { id: 'gaming', name: 'Gaming chair', price: 180 },
  { id: 'executive', name: 'Executive chair', price: 260 },
];

/** Price of each monitor beyond the first. */
export const EXTRA_MONITOR_PRICE = 150;

export const DESK_ITEMS: Array<{ id: DeskItem; name: string; icon: string; price: number }> = [
  { id: 'mug', name: 'Mug', icon: '☕', price: 0 },
  { id: 'stationery', name: 'Notebook & pens', icon: '📓', price: 0 },
  { id: 'plant', name: 'Desk plant', icon: '🌱', price: 15 },
  { id: 'lamp', name: 'Desk lamp', icon: '💡', price: 35 },
  { id: 'figure', name: 'Figurine', icon: '🧸', price: 25 },
  { id: 'photo', name: 'Photo frame', icon: '🖼️', price: 10 },
  { id: 'books', name: 'Books', icon: '📚', price: 20 },
];

/** What a desk looks like until someone upgrades it. */
export const BASIC_DESK: DeskStyle = { desk: 'classic', chair: 'office', monitors: 1, items: ['mug', 'stationery'] };

/** What a desk setup is worth: the sum of its upgrades. */
export function deskStyleCost(style: DeskStyle): number {
  const desk = DESK_MODELS.find((d) => d.id === style.desk)?.price ?? 0;
  const chair = CHAIR_MODELS.find((c) => c.id === style.chair)?.price ?? 0;
  const items = style.items.reduce((sum, id) => sum + (DESK_ITEMS.find((i) => i.id === id)?.price ?? 0), 0);
  return desk + chair + Math.max(0, style.monitors - 1) * EXTRA_MONITOR_PRICE + items;
}

// ---------------------------------------------------------------- colors and looks
// One list each, shared by the host (defaults, random looks) and the forms.

/** Company colors: buildings, players, accents, agents' shirts. */
export const PALETTE = ['#3d63dd', '#e5484d', '#30a46c', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#ffb224'];
export const SKIN_TONES = ['#ffdbac', '#f1c27d', '#e0ac69', '#c68642', '#a0662f', '#8d5524'];
export const HAIR_COLORS = ['#1c1c1c', '#2c1b10', '#3b2a1a', '#6a4e2e', '#b8860b', '#a33b20', '#d8d8d8', '#6b4bd6'];
export const HAIR_STYLES: Array<Appearance['hairStyle']> = ['short', 'long', 'bun', 'bald'];
export const BUILDING_ICONS: Record<BuildingKind, string> = { web: '🌐', desktop: '🖥️', game: '🎮', custom: '🏢' };

// ---------------------------------------------------------------- room style
// TODO(tycoon): room styles are free in every mode for now. Renovations could
// cost money in career (a `price` per material, charged on change, never refunded).

export const FLOOR_MATERIALS: Array<{ id: FloorMaterial; name: string }> = [
  { id: 'wood', name: 'Oak planks' },
  { id: 'wood_light', name: 'Birch planks' },
  { id: 'wood_dark', name: 'Walnut planks' },
  { id: 'herringbone', name: 'Herringbone' },
  { id: 'carpet', name: 'Blue carpet' },
  { id: 'carpet_gray', name: 'Gray carpet' },
  { id: 'concrete', name: 'Concrete' },
  { id: 'tiles', name: 'White tiles' },
  { id: 'checker', name: 'Checkerboard' },
  { id: 'terrazzo', name: 'Terrazzo' },
];

export const WALL_FINISHES: Array<{ id: WallFinish; name: string }> = [
  { id: 'paint', name: 'Paint' },
  { id: 'brick', name: 'Brick' },
  { id: 'wood', name: 'Wood panels' },
  { id: 'concrete', name: 'Concrete' },
  { id: 'glass', name: 'Glass' },
];

export const LIGHTING_PRESETS: Array<{ id: LightingPreset; name: string; icon: string }> = [
  { id: 'daylight', name: 'Daylight', icon: '☀️' },
  { id: 'warm', name: 'Warm', icon: '🌇' },
  { id: 'cool', name: 'Cool', icon: '❄️' },
  { id: 'evening', name: 'Evening', icon: '🌆' },
  { id: 'night', name: 'Night', icon: '🌙' },
];

export const WINDOW_VIEWS: Array<{ id: WindowView; name: string }> = [
  { id: 'city', name: 'City' },
  { id: 'park', name: 'Park' },
  { id: 'sea', name: 'Seaside' },
];

export const FACADES: Array<{ id: FacadeMaterial; name: string }> = [
  { id: 'paint', name: 'Painted' },
  { id: 'glass', name: 'Glass' },
  { id: 'brick', name: 'Brick' },
  { id: 'concrete', name: 'Concrete' },
  { id: 'wood', name: 'Timber' },
];

/** Coherent room styles, applied in one click. */
export const THEME_PRESETS: Array<{ id: string; name: string; blurb: string; theme: Omit<FloorTheme, 'plants' | 'lounge'> }> = [
  {
    id: 'loft', name: 'Startup loft', blurb: 'Brick, concrete and warm light.',
    theme: { floor: 'concrete', wall: 'brick', wallColor: '#b4644a', accentColor: '#f76b15', lighting: 'warm', view: 'city' },
  },
  {
    id: 'corporate', name: 'Corporate', blurb: 'Gray carpet, white walls, cool light.',
    theme: { floor: 'carpet_gray', wall: 'paint', wallColor: '#f4f4f2', accentColor: '#3d63dd', lighting: 'cool', view: 'city' },
  },
  {
    id: 'cozy', name: 'Cozy studio', blurb: 'Herringbone, wood panels, evening glow.',
    theme: { floor: 'herringbone', wall: 'wood', wallColor: '#c9a27a', accentColor: '#30a46c', lighting: 'evening', view: 'park' },
  },
  {
    id: 'neon', name: 'Neon night', blurb: 'Dark checkerboard and magenta light.',
    theme: { floor: 'checker', wall: 'paint', wallColor: '#2a2440', accentColor: '#d6409f', lighting: 'night', view: 'city' },
  },
  {
    id: 'nordic', name: 'Nordic', blurb: 'Birch floors, white walls, daylight.',
    theme: { floor: 'wood_light', wall: 'paint', wallColor: '#ffffff', accentColor: '#12a594', lighting: 'daylight', view: 'sea' },
  },
  {
    id: 'tower', name: 'Glass tower', blurb: 'Terrazzo and floor-to-ceiling glass.',
    theme: { floor: 'terrazzo', wall: 'glass', wallColor: '#e9e4da', accentColor: '#8e4ec6', lighting: 'daylight', view: 'city' },
  },
];
