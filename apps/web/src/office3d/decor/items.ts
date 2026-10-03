import * as THREE from 'three';
import { DECOR_CATALOG, type CatalogItem } from '@agent-hq/protocol/catalog';
import type { ModelName } from '../models.tsx';
import { arcadeScreen, clockFace, corkArt, dartboard, dashboard, grass, landscapeArt, neonText, posterArt, serverLeds, snacks, stripes, worldMap } from './art.ts';
import { compile, mat, Parts, tint, type ItemModel } from './parts.ts';

// One builder per catalog item (see packages/protocol/src/catalog.ts).
// Item-local space: origin on the floor at the footprint's center, front
// facing +Z. Wall items are built against the wall at z = 0, at the height
// the catalog says, sticking out towards +Z.

interface BuildContext {
  entry: CatalogItem;
  /** A loaded glTF scene by model name. */
  gltf: (name: ModelName) => THREE.Object3D;
}

type Builder = (p: Parts, c: BuildContext) => void;

/** glTF models some items reuse (loaded with the rest of the office). */
export const DECOR_GLTF: ModelName[] = ['sofa', 'coffee_table', 'plant', 'plant_tall', 'floor_lamp', 'coffee_machine'];

const WOOD = () => mat('#8a6a4a', { roughness: 0.75 });
const DARK = () => mat('#2b2f36', { roughness: 0.6, metalness: 0.3 });
const CHROME = () => mat('#c9cdd3', { roughness: 0.25, metalness: 0.85 });
const WHITE = () => mat('#f2f2ef', { roughness: 0.6 });
const LEAF = () => mat('#3f8a45', { roughness: 0.8 });
const LEAF_DARK = () => mat('#2f6e3a', { roughness: 0.8 });
const SOIL = () => mat('#3b2a1d', { roughness: 1 });
const GLOW = (color = '#ffe1a8') => mat('#fff6e0', { emissive: color, emissiveIntensity: 1.2, roughness: 0.5 });
const BOOKS = ['#e5484d', '#3d63dd', '#30a46c', '#ffb224', '#8e4ec6', '#f2f2ef', '#1c2026', '#12a594'];

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/** A row of books on a shelf from x0 to x1, standing on `y`, `depth` deep. */
function books(p: Parts, x0: number, x1: number, y: number, z: number, depth: number, seed: number) {
  const rand = rng(seed);
  for (let x = x0; x < x1 - 0.04;) {
    const w = 0.03 + rand() * 0.035;
    const h = 0.18 + rand() * 0.12;
    if (rand() < 0.12) { x += w + 0.04; continue; }
    p.box([w, h, depth], [x + w / 2, y + h / 2, z], mat(BOOKS[Math.floor(rand() * BOOKS.length)], { roughness: 0.8 }));
    x += w + 0.004;
  }
}

/** Four legs under a rectangle. */
function legs(p: Parts, w: number, d: number, h: number, inset: number, material: THREE.Material, r = 0.025) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) p.cyl(r, r, h, [sx * (w / 2 - inset), h / 2, sz * (d / 2 - inset)], material, [0, 0, 0], 8);
}

/** A simple chair facing +Z, seat at 0.46 m. */
function chair(p: Parts, x: number, z: number, turn: number, material: THREE.Material) {
  const c = Math.cos(turn), s = Math.sin(turn);
  const at = (lx: number, y: number, lz: number): [number, number, number] => [x + lx * c + lz * s, y, z - lx * s + lz * c];
  p.box([0.44, 0.05, 0.42], at(0, 0.46, 0), material, [0, turn, 0]);
  p.box([0.44, 0.4, 0.04], at(0, 0.7, -0.2), material, [0, turn, 0]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) p.box([0.03, 0.44, 0.03], at(sx * 0.19, 0.22, sz * 0.18), DARK(), [0, turn, 0]);
}

const BUILDERS: Record<string, Builder> = {
  // ------------------------------------------------------------ furniture
  sofa: (p, c) => { p.gltf(c.gltf('sofa'), { Fabric: tint({ roughness: 0.95 }) }); },
  armchair: (p) => {
    const t = tint({ roughness: 0.95 });
    p.box([0.85, 0.3, 0.78], [0, 0.25, 0], t);
    p.box([0.85, 0.5, 0.18], [0, 0.6, -0.3], t);
    for (const sx of [-1, 1]) p.box([0.15, 0.26, 0.78], [sx * 0.35, 0.53, 0], t);
    p.box([0.55, 0.1, 0.58], [0, 0.45, 0.07], t);
    legs(p, 0.8, 0.72, 0.1, 0.06, mat('#4a3424'), 0.02);
  },
  coffee_table: (p, c) => { p.gltf(c.gltf('coffee_table')); },
  bookshelf: (p) => {
    const t = tint({ roughness: 0.75 });
    for (const sx of [-1, 1]) p.box([0.04, 1.9, 0.4], [sx * 0.58, 0.95, 0], t);
    for (const y of [0.04, 0.48, 0.92, 1.36, 1.88]) p.box([1.12, 0.03, 0.38], [0, y, 0], t);
    p.box([1.2, 1.9, 0.02], [0, 0.95, -0.19], t);
    [0.055, 0.495, 0.935, 1.375].forEach((y, i) => books(p, -0.55, 0.55, y, 0.02, 0.26, 7 + i * 13));
  },
  side_table: (p) => {
    const t = tint({ roughness: 0.5 });
    p.cyl(0.25, 0.25, 0.03, [0, 0.54, 0], t, [0, 0, 0], 28);
    p.cyl(0.025, 0.025, 0.52, [0, 0.27, 0], DARK(), [0, 0, 0], 10);
    p.cyl(0.18, 0.18, 0.02, [0, 0.01, 0], DARK(), [0, 0, 0], 24);
  },
  bench: (p) => {
    const t = tint({ roughness: 0.75 });
    for (const z of [-0.14, 0, 0.14]) p.box([1.6, 0.035, 0.12], [0, 0.44, z], t);
    for (const sx of [-1, 1]) {
      p.box([0.04, 0.42, 0.04], [sx * 0.68, 0.21, -0.16], DARK());
      p.box([0.04, 0.42, 0.04], [sx * 0.68, 0.21, 0.16], DARK());
      p.box([0.04, 0.04, 0.36], [sx * 0.68, 0.4, 0], DARK());
    }
  },
  beanbag: (p) => {
    const t = tint({ roughness: 1 });
    p.sphere(0.45, [0, 0.27, 0.04], t, [1, 0.62, 1], 20);
    p.sphere(0.36, [0, 0.42, -0.2], t, [1, 0.85, 0.6], 18);
  },
  meeting_table: (p) => {
    p.cyl(0.72, 0.72, 0.04, [0, 0.74, 0], tint({ roughness: 0.4 }), [0, 0, 0], 40);
    p.cyl(0.07, 0.07, 0.7, [0, 0.37, 0], DARK(), [0, 0, 0], 12);
    p.cyl(0.36, 0.36, 0.03, [0, 0.015, 0], DARK(), [0, 0, 0], 28);
    const seat = mat('#3a3f4b', { roughness: 0.9 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      chair(p, Math.sin(a) * 0.95, Math.cos(a) * 0.95, a + Math.PI, seat);
    }
  },
  cabinet: (p) => {
    const t = tint({ roughness: 0.45, metalness: 0.35 });
    p.box([0.5, 1.05, 0.6], [0, 0.525, 0], t);
    for (let i = 0; i < 3; i++) {
      const y = 0.18 + i * 0.33;
      p.box([0.44, 0.005, 0.01], [0, y + 0.15, 0.301], DARK());
      p.box([0.14, 0.025, 0.03], [0, y + 0.06, 0.31], CHROME());
    }
  },

  // ------------------------------------------------------------ plants
  plant: (p, c) => { p.gltf(c.gltf('plant')); },
  plant_tall: (p, c) => { p.gltf(c.gltf('plant_tall')); },
  cactus: (p) => {
    p.cyl(0.17, 0.13, 0.26, [0, 0.13, 0], tint({ roughness: 0.9 }), [0, 0, 0], 16);
    p.cyl(0.155, 0.155, 0.02, [0, 0.25, 0], SOIL(), [0, 0, 0], 16);
    const g = mat('#4f8f4a', { roughness: 0.8 });
    p.cyl(0.085, 0.09, 0.66, [0, 0.58, 0], g, [0, 0, 0], 10);
    p.sphere(0.085, [0, 0.91, 0], g, [1, 0.8, 1], 10);
    for (const [sx, y, h] of [[1, 0.62, 0.22], [-1, 0.5, 0.18]] as const) {
      p.cyl(0.045, 0.045, 0.14, [sx * 0.13, y, 0], g, [0, 0, Math.PI / 2], 8);
      p.cyl(0.045, 0.045, h, [sx * 0.19, y + h / 2, 0], g, [0, 0, 0], 8);
      p.sphere(0.045, [sx * 0.19, y + h, 0], g, [1, 1, 1], 8);
    }
  },
  planter: (p) => {
    p.box([1.4, 0.45, 0.45], [0, 0.225, 0], tint({ roughness: 0.6 }));
    p.box([1.34, 0.02, 0.39], [0, 0.44, 0], SOIL());
    const rand = rng(4);
    for (let i = 0; i < 8; i++) {
      const x = -0.58 + i * 0.165;
      p.sphere(0.13 + rand() * 0.06, [x, 0.6 + rand() * 0.12, (rand() - 0.5) * 0.12], i % 2 ? LEAF() : LEAF_DARK(), [1, 1.2, 1], 10);
    }
  },
  palm: (p) => {
    p.cyl(0.28, 0.22, 0.42, [0, 0.21, 0], tint({ roughness: 0.6 }), [0, 0, 0], 20);
    p.cyl(0.26, 0.26, 0.02, [0, 0.41, 0], SOIL(), [0, 0, 0], 20);
    const bark = mat('#8a6a48', { roughness: 0.95 });
    for (let i = 0; i < 6; i++) p.cyl(0.07 - i * 0.005, 0.08 - i * 0.005, 0.24, [i * 0.012, 0.52 + i * 0.22, 0], bark, [0, 0, -0.05], 10);
    const top: [number, number, number] = [0.07, 1.86, 0];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const m = new THREE.Matrix4()
        .makeTranslation(...top)
        .multiply(new THREE.Matrix4().makeRotationY(a))
        .multiply(new THREE.Matrix4().makeRotationZ(-0.45 - (i % 2) * 0.2))
        .multiply(new THREE.Matrix4().makeTranslation(0.42, 0, 0))
        .multiply(new THREE.Matrix4().makeScale(0.85, 0.02, 0.2));
      p.add(new THREE.BoxGeometry(1, 1, 1), i % 2 ? LEAF() : LEAF_DARK(), m);
    }
  },
  hanging_plant: (p, c) => {
    const h = c.entry.height;
    p.box([0.4, 0.18, 0.2], [0, h, 0.11], mat('#d8d2c4', { roughness: 0.6 }));
    const rand = rng(2);
    for (let i = 0; i < 9; i++) {
      const x = -0.16 + (i % 5) * 0.08;
      const drop = rand() * 0.45 + (i > 4 ? 0.15 : 0);
      p.sphere(0.07, [x, h + 0.08 - drop, 0.17 + rand() * 0.05], i % 2 ? LEAF() : LEAF_DARK(), [1, 1.3, 0.7], 8);
    }
  },

  // ------------------------------------------------------------ lighting
  floor_lamp: (p, c) => { p.gltf(c.gltf('floor_lamp'), { Shade: GLOW() }); },
  arc_lamp: (p) => {
    p.cyl(0.18, 0.2, 0.05, [-0.5, 0.025, 0], mat('#e9e4da', { roughness: 0.3 }), [0, 0, 0], 24);
    p.cyl(0.015, 0.015, 1.5, [-0.5, 0.78, 0], CHROME(), [0, 0, 0], 8);
    p.torus(0.5, 0.015, Math.PI, [0, 1.52, 0], CHROME());
    p.cyl(0.08, 0.22, 0.2, [0.5, 1.42, 0], mat('#2b2f36', { roughness: 0.4, metalness: 0.5, side: THREE.DoubleSide }), [0, 0, 0], 20);
    p.sphere(0.06, [0.5, 1.36, 0], GLOW('#fff1d6'), [1, 1, 1], 10);
  },
  table_lamp: (p) => {
    p.cyl(0.22, 0.22, 0.03, [0, 0.6, 0], WOOD(), [0, 0, 0], 24);
    p.cyl(0.03, 0.03, 0.58, [0, 0.29, 0], DARK(), [0, 0, 0], 8);
    p.cyl(0.16, 0.16, 0.02, [0, 0.01, 0], DARK(), [0, 0, 0], 20);
    p.cyl(0.07, 0.08, 0.04, [0, 0.635, 0], tint({ roughness: 0.4 }), [0, 0, 0], 16);
    p.cyl(0.012, 0.012, 0.18, [0, 0.74, 0], CHROME(), [0, 0, 0], 6);
    p.cyl(0.1, 0.15, 0.18, [0, 0.88, 0], GLOW(), [0, 0, 0], 20);
  },
  neon_sign: (p, c) => {
    const h = c.entry.height;
    p.box([1.4, 0.55, 0.03], [0, h, 0.015], mat('#121318', { roughness: 0.3, metalness: 0.2 }));
    p.plane(1.3, 0.49, [0, h, 0.032], tint({ basic: true, map: neonText() }));
  },
  wall_sconce: (p, c) => {
    const h = c.entry.height;
    p.box([0.12, 0.2, 0.02], [0, h, 0.01], mat('#b08d57', { roughness: 0.35, metalness: 0.7 }));
    p.cyl(0.1, 0.1, 0.22, [0, h, 0.1], GLOW(), [0, 0, 0], 16);
  },

  // ------------------------------------------------------------ wall decor
  poster: (p, c) => {
    const h = c.entry.height;
    p.box([0.9, 1.2, 0.03], [0, h, 0.015], tint({ roughness: 0.5 }));
    p.plane(0.8, 1.1, [0, h, 0.031], mat('#ffffff', { map: posterArt(), roughness: 0.8 }));
  },
  painting: (p, c) => {
    const h = c.entry.height;
    p.box([1.3, 0.92, 0.05], [0, h, 0.025], mat('#b8913a', { roughness: 0.35, metalness: 0.7 }));
    p.plane(1.16, 0.78, [0, h, 0.051], mat('#ffffff', { map: landscapeArt(), roughness: 0.9 }));
  },
  clock: (p, c) => {
    const h = c.entry.height;
    p.cyl(0.25, 0.25, 0.05, [0, h, 0.025], DARK(), [Math.PI / 2, 0, 0], 32);
    p.disc(0.225, [0, h, 0.051], mat('#ffffff', { map: clockFace(), roughness: 0.6 }));
  },
  wall_shelf: (p, c) => {
    const h = c.entry.height;
    p.box([1.1, 0.03, 0.25], [0, h, 0.125], tint({ roughness: 0.7 }));
    for (const sx of [-1, 1]) p.box([0.02, 0.12, 0.18], [sx * 0.42, h - 0.07, 0.09], DARK());
    books(p, -0.5, -0.05, h + 0.015, 0.13, 0.17, 31);
    p.cyl(0.05, 0.04, 0.08, [0.15, h + 0.055, 0.12], mat('#c4673f', { roughness: 0.9 }), [0, 0, 0], 10);
    p.sphere(0.07, [0.15, h + 0.14, 0.12], LEAF(), [1, 1, 1], 10);
    const gold = mat('#e3b341', { roughness: 0.25, metalness: 0.9 });
    p.box([0.08, 0.03, 0.08], [0.38, h + 0.03, 0.12], gold);
    p.cyl(0.012, 0.012, 0.06, [0.38, h + 0.075, 0.12], gold, [0, 0, 0], 6);
    p.cyl(0.05, 0.025, 0.07, [0.38, h + 0.14, 0.12], gold, [0, 0, 0], 12);
  },
  world_map: (p, c) => {
    const h = c.entry.height;
    p.box([1.6, 0.86, 0.03], [0, h, 0.015], mat('#2b2f36', { roughness: 0.5 }));
    p.plane(1.54, 0.8, [0, h, 0.031], mat('#ffffff', { map: worldMap(), roughness: 0.85 }));
  },
  corkboard: (p, c) => {
    const h = c.entry.height;
    p.box([1.1, 0.76, 0.04], [0, h, 0.02], WOOD());
    p.plane(1.02, 0.68, [0, h, 0.041], mat('#ffffff', { map: corkArt(), roughness: 1 }));
  },

  // ------------------------------------------------------------ rugs (flat; slightly different heights avoid z-fighting)
  rug_round: (p) => {
    p.noShadow();
    p.cyl(1.2, 1.2, 0.012, [0, 0.006, 0], tint({ roughness: 1 }), [0, 0, 0], 48);
    p.ring(0.9, 1.02, [0, 0.0125, 0], mat('#f1e8d6', { roughness: 1 }), [-Math.PI / 2, 0, 0]);
  },
  rug_rect: (p) => {
    p.noShadow();
    p.box([3, 0.012, 2], [0, 0.006, 0], tint({ roughness: 1, map: stripes() }));
  },
  rug_runner: (p) => {
    p.noShadow();
    p.box([3.2, 0.012, 0.9], [0, 0.006, 0], tint({ roughness: 1 }));
    for (const z of [-0.33, 0.33]) p.box([3.0, 0.002, 0.05], [0, 0.0125, z], mat('#f1e8d6', { roughness: 1 }));
  },
  rug_grass: (p) => {
    p.noShadow();
    p.box([2, 0.03, 2], [0, 0.015, 0], mat('#ffffff', { roughness: 1, map: grass() }));
    const rand = rng(9);
    for (let i = 0; i < 7; i++) p.sphere(0.025, [(rand() - 0.5) * 1.7, 0.035, (rand() - 0.5) * 1.7], mat(['#ffffff', '#ffd84d', '#ff8fb1'][i % 3]), [1, 0.6, 1], 6);
  },

  // ------------------------------------------------------------ tech
  server_rack: (p) => {
    p.box([0.7, 2, 0.9], [0, 1, 0], mat('#1b1e24', { roughness: 0.5, metalness: 0.4 }));
    p.plane(0.6, 1.85, [0, 1, 0.451], mat('#ffffff', { basic: true, map: serverLeds() }));
    p.box([0.04, 0.5, 0.03], [0.26, 1.1, 0.47], CHROME());
  },
  tv_stand: (p) => {
    p.box([1.5, 0.45, 0.45], [0, 0.225, 0], WOOD());
    p.box([1.46, 0.01, 0.01], [0, 0.23, 0.226], DARK());
    p.box([0.08, 0.5, 0.06], [0, 0.7, -0.05], DARK());
    p.box([1.34, 0.78, 0.05], [0, 1.18, -0.02], mat('#111317', { roughness: 0.3, metalness: 0.3 }));
    p.plane(1.28, 0.72, [0, 1.18, 0.006], mat('#ffffff', { basic: true, map: dashboard() }));
  },
  printer: (p) => {
    p.box([0.7, 0.6, 0.6], [0, 0.3, 0], mat('#5b6170', { roughness: 0.6 }));
    p.box([0.66, 0.34, 0.56], [0, 0.77, 0], WHITE());
    p.box([0.5, 0.02, 0.3], [0, 0.95, 0.05], mat('#d9dce1'));
    p.box([0.4, 0.015, 0.22], [0, 0.965, 0.05], mat('#ffffff', { roughness: 0.9 }));
    p.plane(0.14, 0.06, [0.2, 0.86, 0.281], mat('#3dd68c', { basic: true }));
  },
  vending: (p) => {
    p.box([0.9, 1.9, 0.8], [0, 0.95, 0], tint({ roughness: 0.4, metalness: 0.2 }));
    p.plane(0.56, 1.4, [-0.12, 1.1, 0.401], mat('#ffffff', { basic: true, map: snacks() }));
    p.box([0.2, 0.5, 0.02], [0.3, 1.3, 0.41], mat('#22252b', { roughness: 0.4 }));
    p.box([0.5, 0.16, 0.03], [-0.12, 0.2, 0.405], mat('#1b1e24', { roughness: 0.5 }));
  },
  water_cooler: (p) => {
    p.box([0.4, 1.0, 0.4], [0, 0.5, 0], WHITE());
    p.cyl(0.15, 0.15, 0.36, [0, 1.19, 0], mat('#7cc7ff', { roughness: 0.1, opacity: 0.55 }), [0, 0, 0], 20);
    p.box([0.04, 0.05, 0.05], [-0.07, 0.82, 0.215], mat('#4f8cff'));
    p.box([0.04, 0.05, 0.05], [0.07, 0.82, 0.215], mat('#e5484d'));
  },
  coffee_machine: (p, c) => { p.gltf(c.gltf('coffee_machine')); },

  // ------------------------------------------------------------ fun
  ping_pong: (p) => {
    p.box([2.74, 0.04, 1.52], [0, 0.76, 0], tint({ roughness: 0.5 }));
    const line = mat('#ffffff', { roughness: 0.6 });
    for (const z of [-0.74, 0.74]) p.box([2.74, 0.002, 0.02], [0, 0.781, z], line);
    for (const x of [-1.36, 1.36]) p.box([0.02, 0.002, 1.52], [x, 0.781, 0], line);
    p.box([2.7, 0.002, 0.01], [0, 0.781, 0], line);
    p.box([0.01, 0.15, 1.62], [0, 0.855, 0], mat('#22252b', { roughness: 0.8, opacity: 0.85 }));
    legs(p, 2.5, 1.3, 0.74, 0.1, DARK(), 0.03);
  },
  foosball: (p) => {
    const wood = mat('#7a5638', { roughness: 0.7 });
    p.box([1.2, 0.04, 0.75], [0, 0.6, 0], mat('#2f8a3c', { roughness: 0.9 }));
    for (const z of [-0.36, 0.36]) p.box([1.2, 0.22, 0.03], [0, 0.7, z], wood);
    for (const x of [-0.585, 0.585]) p.box([0.03, 0.22, 0.75], [x, 0.7, 0], wood);
    legs(p, 1.1, 0.65, 0.6, 0.05, wood, 0.035);
    for (let i = 0; i < 8; i++) {
      const x = -0.49 + i * 0.14;
      p.cyl(0.01, 0.01, 1.05, [x, 0.74, 0], CHROME(), [Math.PI / 2, 0, 0], 6);
      p.cyl(0.02, 0.02, 0.1, [x, 0.74, (i % 2 ? 1 : -1) * 0.57], DARK(), [Math.PI / 2, 0, 0], 8);
      const team = mat(i % 2 ? '#e5484d' : '#3d63dd', { roughness: 0.5 });
      for (const z of [-0.18, 0, 0.18]) p.box([0.03, 0.1, 0.03], [x, 0.7, z], team);
    }
  },
  arcade: (p) => {
    const t = tint({ roughness: 0.5 });
    p.box([0.7, 1.0, 0.75], [0, 0.5, 0], t);
    p.box([0.7, 0.75, 0.45], [0, 1.37, -0.15], t);
    p.box([0.7, 0.08, 0.35], [0, 1.03, 0.2], DARK(), [0.25, 0, 0]);
    p.plane(0.5, 0.42, [0, 1.38, 0.085], mat('#ffffff', { basic: true, map: arcadeScreen() }), [-0.18, 0, 0]);
    p.box([0.7, 0.16, 0.3], [0, 1.82, -0.2], DARK());
    p.plane(0.6, 0.12, [0, 1.82, -0.049], mat('#ff4fd8', { basic: true }));
    for (const [x, color] of [[-0.12, '#e5484d'], [0.0, '#ffd84d'], [0.12, '#4fb3ff']] as const) p.cyl(0.025, 0.025, 0.02, [x, 1.08, 0.24], mat(color, { roughness: 0.3 }), [0.25, 0, 0], 10);
    p.cyl(0.012, 0.012, 0.08, [-0.25, 1.11, 0.22], DARK(), [0, 0, 0], 6);
  },
  aquarium: (p) => {
    p.box([1.3, 0.75, 0.5], [0, 0.375, 0], mat('#2e2620', { roughness: 0.6 }));
    p.box([1.2, 0.48, 0.42], [0, 0.99, 0], mat('#3fa7d6', { basic: true, opacity: 0.45 }));
    p.box([1.2, 0.05, 0.42], [0, 0.775, 0], mat('#d9c8a0', { roughness: 1 }));
    p.box([1.26, 0.6, 0.46], [0, 1.05, 0], mat('#dff3ff', { roughness: 0.05, opacity: 0.2 }));
    p.box([1.28, 0.04, 0.48], [0, 1.37, 0], DARK());
    const rand = rng(5);
    for (let i = 0; i < 6; i++) p.cone(0.03, 0.2 + rand() * 0.15, [-0.5 + i * 0.2, 0.9, (rand() - 0.5) * 0.25], LEAF(), [0, 0, 0], 6);
    for (const [x, y, color] of [[-0.3, 1.02, '#ff8c3a'], [0.15, 1.1, '#ffd84d'], [0.35, 0.95, '#ff5f7a']] as const) {
      p.sphere(0.035, [x, y, 0], mat(color, { roughness: 0.4 }), [1.5, 1, 0.6], 8);
    }
  },
  duck: (p) => {
    const t = tint({ roughness: 0.35 });
    p.sphere(0.38, [0, 0.3, -0.05], t, [1, 0.78, 1.1], 20);
    p.sphere(0.22, [0, 0.72, 0.15], t, [1, 1, 1], 18);
    p.cone(0.09, 0.2, [0, 0.68, 0.43], mat('#f76b15', { roughness: 0.4 }), [Math.PI / 2, 0, 0], 12);
    for (const sx of [-1, 1]) p.sphere(0.03, [sx * 0.1, 0.79, 0.33], mat('#1c1c1c', { roughness: 0.2 }), [1, 1, 1], 8);
    p.sphere(0.12, [0, 0.42, -0.45], t, [1, 0.8, 1], 10);
  },
  trophy: (p) => {
    p.box([0.5, 0.9, 0.5], [0, 0.45, 0], mat('#f2f2ef', { roughness: 0.4 }));
    const gold = tint({ roughness: 0.2, metalness: 0.9 });
    p.box([0.22, 0.06, 0.22], [0, 0.93, 0], DARK());
    p.cyl(0.03, 0.05, 0.14, [0, 1.03, 0], gold, [0, 0, 0], 12);
    p.cyl(0.15, 0.06, 0.24, [0, 1.22, 0], gold, [0, 0, 0], 20);
    for (const sx of [-1, 1]) p.torus(0.06, 0.012, Math.PI, [sx * 0.15, 1.24, 0], gold, [0, 0, sx > 0 ? -Math.PI / 2 : Math.PI / 2]);
  },
  dartboard: (p, c) => {
    const h = c.entry.height;
    p.cyl(0.25, 0.25, 0.04, [0, h, 0.02], mat('#1c1c1c', { roughness: 0.8 }), [Math.PI / 2, 0, 0], 32);
    p.disc(0.23, [0, h, 0.041], mat('#ffffff', { map: dartboard(), roughness: 0.9 }));
    for (const [x, y] of [[0.04, 0.03], [-0.08, -0.05], [0.1, -0.1]]) p.cyl(0.004, 0.004, 0.12, [x, h + y, 0.1], mat('#e5484d'), [Math.PI / 2, 0, 0], 6);
  },
};

const models = new Map<string, ItemModel>();

/** The compiled model of a catalog item (cached; glTF-based items need their scene loaded). */
export function itemModel(id: string, gltf: BuildContext['gltf']): ItemModel | null {
  const cached = models.get(id);
  if (cached) return cached;
  const entry = DECOR_CATALOG.find((i) => i.id === id);
  const build = BUILDERS[id];
  if (!entry || !build) return null;
  const parts = new Parts();
  build(parts, { entry, gltf });
  const model = compile(parts.list);
  models.set(id, model);
  return model;
}
