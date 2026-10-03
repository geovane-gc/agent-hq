import * as THREE from 'three';
import type { FacadeMaterial, FloorMaterial, LightingPreset, WallFinish, WindowView } from '@agent-hq/protocol';
import { canvasTexture, getCarpetTexture, getFloorTexture, getTilesTexture } from '../textures.ts';

// Procedural textures for room styles: floor materials, wall finishes, window
// views and building facades. All drawn once on small canvases and cached.

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const cache = new Map<string, THREE.CanvasTexture>();
function cached(key: string, make: () => THREE.CanvasTexture, repeat = true) {
  let t = cache.get(key);
  if (!t) {
    t = make();
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    cache.set(key, t);
  }
  return t;
}

/** Speckles over the whole canvas: concrete, terrazzo, carpet fibers. */
function speckle(ctx: CanvasRenderingContext2D, size: number, count: number, colors: string[], r: [number, number], seed: number) {
  const rand = rng(seed);
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    const radius = r[0] + rand() * (r[1] - r[0]);
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function planks(tones: string[], seam: string) {
  return canvasTexture(512, 512, (ctx) => {
    const rand = rng(11);
    const h = 64;
    for (let row = 0; row < 512 / h; row++) {
      const offset = Math.floor(rand() * 4) * 64;
      for (let x = -offset; x < 512; x += 256) {
        ctx.fillStyle = tones[Math.floor(rand() * tones.length)];
        ctx.fillRect(x, row * h, 256, h);
        // grain
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
        ctx.lineWidth = 1;
        for (let g = 0; g < 5; g++) {
          const y = row * h + 6 + rand() * (h - 12);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.bezierCurveTo(x + 80, y + rand() * 6 - 3, x + 170, y + rand() * 6 - 3, x + 256, y);
          ctx.stroke();
        }
        ctx.strokeStyle = seam;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, row * h + 1, 254, h - 2);
      }
    }
  });
}

interface FloorLook {
  texture: THREE.Texture | null;
  /** Meters covered by one repeat of the texture. */
  tile: number;
  color: string;
  roughness: number;
}

export function floorLook(material: FloorMaterial): FloorLook {
  switch (material) {
    case 'wood': return { texture: getFloorTexture(), tile: 4, color: '#ffffff', roughness: 0.8 };
    case 'wood_light': return { texture: cached('wood_light', () => planks(['#e3cfae', '#dcc7a3', '#e8d6b8', '#d6bf98'], 'rgba(120, 90, 50, 0.25)')), tile: 4, color: '#ffffff', roughness: 0.75 };
    case 'wood_dark': return { texture: cached('wood_dark', () => planks(['#6b4a33', '#5e412c', '#74513a', '#573b28'], 'rgba(20, 10, 5, 0.45)')), tile: 4, color: '#ffffff', roughness: 0.7 };
    case 'herringbone': return {
      texture: cached('herringbone', () => canvasTexture(256, 256, (ctx) => {
        const rand = rng(5);
        const tones = ['#b98a5e', '#a97c52', '#c39467', '#9f744c'];
        ctx.fillStyle = '#8a6440';
        ctx.fillRect(0, 0, 256, 256);
        // zig-zag rows of short planks, 32 x 96 px, at ±45°
        for (let row = -2; row < 8; row++) {
          for (let col = -2; col < 8; col++) {
            for (const flip of [0, 1]) {
              ctx.save();
              ctx.translate(col * 64 + flip * 32, row * 64 + flip * 32);
              ctx.rotate(flip ? -Math.PI / 4 : Math.PI / 4);
              ctx.fillStyle = tones[Math.floor(rand() * tones.length)];
              ctx.fillRect(0, 0, 22, 66);
              ctx.strokeStyle = 'rgba(60, 35, 15, 0.45)';
              ctx.strokeRect(0, 0, 22, 66);
              ctx.restore();
            }
          }
        }
      })), tile: 1.6, color: '#ffffff', roughness: 0.7,
    };
    case 'carpet': return { texture: getCarpetTexture(), tile: 1.5, color: '#ffffff', roughness: 1 };
    case 'carpet_gray': return {
      texture: cached('carpet_gray', () => canvasTexture(128, 128, (ctx) => {
        ctx.fillStyle = '#6d7178';
        ctx.fillRect(0, 0, 128, 128);
        speckle(ctx, 128, 900, ['#62666d', '#767a82', '#5a5e64'], [0.5, 1.2], 3);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
        ctx.strokeRect(0.5, 0.5, 127, 127);
      })), tile: 1, color: '#ffffff', roughness: 1,
    };
    case 'concrete': return { texture: concrete(), tile: 3, color: '#c9c7c1', roughness: 0.9 };
    case 'tiles': return { texture: getTilesTexture(), tile: 1.5, color: '#ffffff', roughness: 0.4 };
    case 'checker': return {
      texture: cached('checker', () => canvasTexture(128, 128, (ctx) => {
        ctx.fillStyle = '#e9e6df';
        ctx.fillRect(0, 0, 128, 128);
        ctx.fillStyle = '#26232b';
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillRect(64, 64, 64, 64);
      })), tile: 1.2, color: '#ffffff', roughness: 0.35,
    };
    case 'terrazzo': return {
      texture: cached('terrazzo', () => canvasTexture(256, 256, (ctx) => {
        ctx.fillStyle = '#ebe7e0';
        ctx.fillRect(0, 0, 256, 256);
        speckle(ctx, 256, 260, ['#c9a98f', '#9aa4ad', '#6e6a66', '#d9c2a8', '#b8c4b0'], [1, 4], 9);
      })), tile: 2, color: '#ffffff', roughness: 0.35,
    };
  }
}

/** Light gray noise, tinted by the material color. */
function concrete() {
  return cached('concrete', () => canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#d8d8d6';
    ctx.fillRect(0, 0, 256, 256);
    speckle(ctx, 256, 1600, ['#cfcfcc', '#e2e2df', '#c6c6c3'], [0.6, 2.2], 21);
    const rand = rng(4);
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = `rgba(0, 0, 0, ${0.02 + rand() * 0.03})`;
      ctx.beginPath();
      ctx.ellipse(rand() * 256, rand() * 256, 20 + rand() * 60, 10 + rand() * 40, rand() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }));
}

function brick() {
  return cached('brick', () => canvasTexture(256, 256, (ctx) => {
    const rand = rng(17);
    ctx.fillStyle = '#d9d3cc'; // mortar
    ctx.fillRect(0, 0, 256, 256);
    const h = 32;
    for (let row = 0; row < 256 / h; row++) {
      const offset = (row % 2) * 32;
      for (let x = -offset; x < 256; x += 64) {
        const l = 70 + rand() * 25;
        ctx.fillStyle = `hsl(0, 0%, ${l}%)`;
        ctx.fillRect(x + 2, row * h + 2, 60, h - 4);
      }
    }
  }));
}

function woodPanels() {
  return cached('panels', () => canvasTexture(256, 256, (ctx) => {
    const rand = rng(23);
    for (let x = 0; x < 256; x += 32) {
      const l = 80 + rand() * 12;
      ctx.fillStyle = `hsl(30, 25%, ${l}%)`;
      ctx.fillRect(x, 0, 32, 256);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
      for (let g = 0; g < 4; g++) {
        const gx = x + 4 + rand() * 24;
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.bezierCurveTo(gx + 3, 90, gx - 3, 170, gx, 256);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.fillRect(x, 0, 2, 256);
    }
  }));
}

/** A grayscale-ish texture tinted by the wall color, and how many meters one repeat covers. */
export function wallLook(finish: WallFinish): { texture: THREE.Texture | null; tile: number; roughness: number } {
  switch (finish) {
    case 'brick': return { texture: brick(), tile: 1.4, roughness: 0.95 };
    case 'wood': return { texture: woodPanels(), tile: 1.6, roughness: 0.75 };
    case 'concrete': return { texture: concrete(), tile: 2.5, roughness: 0.9 };
    default: return { texture: null, tile: 1, roughness: 0.95 };
  }
}

/** A clone of a cached texture repeated to cover `w` × `h` meters. */
export function tiled(texture: THREE.Texture, tile: number, w: number, h: number) {
  const t = texture.clone();
  t.needsUpdate = true;
  t.repeat.set(w / tile, h / tile);
  return t;
}

// ---------------------------------------------------------------- window views

export type TimeOfDay = 'day' | 'afternoon' | 'dusk' | 'night';

const SKY: Record<TimeOfDay, [string, string]> = {
  day: ['#7fb8ec', '#cfe6fb'],
  afternoon: ['#8fb5d8', '#f6dcb2'],
  dusk: ['#3b3461', '#f09a6a'],
  night: ['#070b1c', '#1d2a4d'],
};

/** What the windows show: the view, painted for the time of day. */
export function viewTexture(view: WindowView, time: TimeOfDay) {
  return cached(`view:${view}:${time}`, () => canvasTexture(256, 192, (ctx) => {
    const rand = rng(view.length * 31 + 7);
    const dark = time === 'night' || time === 'dusk';
    const sky = ctx.createLinearGradient(0, 0, 0, 192);
    sky.addColorStop(0, SKY[time][0]);
    sky.addColorStop(1, SKY[time][1]);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 256, 192);
    if (time === 'night') {
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = `rgba(255, 255, 255, ${0.3 + rand() * 0.6})`;
        ctx.fillRect(rand() * 256, rand() * 100, 1, 1);
      }
      ctx.fillStyle = '#f4f1dc';
      ctx.beginPath();
      ctx.arc(200, 34, 10, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = time === 'dusk' ? '#ffb37a' : time === 'afternoon' ? '#fff0c8' : '#fffbe8';
      ctx.beginPath();
      ctx.arc(time === 'dusk' ? 60 : 196, time === 'dusk' ? 130 : 40, time === 'dusk' ? 16 : 12, 0, Math.PI * 2);
      ctx.fill();
    }
    if (view === 'city') {
      for (const [layer, base] of [[0, 120], [1, 150]] as const) {
        for (let x = -10; x < 256;) {
          const w = 18 + rand() * 30;
          const top = base - 20 - rand() * (layer ? 60 : 80);
          const shade = layer ? (dark ? '#151a2c' : '#6d7f96') : (dark ? '#232a44' : '#9fb0c4');
          ctx.fillStyle = shade;
          ctx.fillRect(x, top, w, 192 - top);
          // windows
          for (let wy = top + 5; wy < 186; wy += 7) {
            for (let wx = x + 3; wx < x + w - 4; wx += 6) {
              const lit = dark ? rand() < 0.45 : rand() < 0.15;
              ctx.fillStyle = lit ? (dark ? '#ffd88a' : '#dbe8f5') : (dark ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.12)');
              ctx.fillRect(wx, wy, 3, 4);
            }
          }
          x += w + 2 + rand() * 6;
        }
      }
    } else if (view === 'park') {
      ctx.fillStyle = dark ? '#1b2a22' : '#7fae6a';
      ctx.beginPath();
      ctx.moveTo(0, 140);
      ctx.bezierCurveTo(70, 100, 160, 150, 256, 118);
      ctx.lineTo(256, 192);
      ctx.lineTo(0, 192);
      ctx.fill();
      for (let i = 0; i < 14; i++) {
        const x = rand() * 256;
        const y = 130 + rand() * 50;
        const r = 9 + rand() * 12;
        ctx.fillStyle = dark ? '#10201a' : ['#4f8a4a', '#5d9a52', '#3f7840'][i % 3];
        ctx.beginPath();
        ctx.arc(x, y - r, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = dark ? '#0b140f' : '#5b4330';
        ctx.fillRect(x - 1.5, y - 2, 3, 8);
      }
    } else {
      // sea: water, a far shore and a sailboat
      const water = ctx.createLinearGradient(0, 120, 0, 192);
      water.addColorStop(0, dark ? '#1a2440' : '#3f88c5');
      water.addColorStop(1, dark ? '#0b1022' : '#2a6aa3');
      ctx.fillStyle = water;
      ctx.fillRect(0, 120, 256, 72);
      ctx.fillStyle = dark ? 'rgba(255, 220, 160, 0.35)' : 'rgba(255, 255, 255, 0.35)';
      for (let i = 0; i < 30; i++) ctx.fillRect(rand() * 256, 124 + rand() * 66, 6 + rand() * 10, 1);
      ctx.fillStyle = dark ? '#121a30' : '#8aa79a';
      ctx.beginPath();
      ctx.moveTo(140, 121);
      ctx.bezierCurveTo(170, 108, 220, 110, 256, 116);
      ctx.lineTo(256, 121);
      ctx.fill();
      ctx.fillStyle = dark ? '#c9c2b0' : '#ffffff';
      ctx.beginPath();
      ctx.moveTo(80, 140);
      ctx.lineTo(80, 112);
      ctx.lineTo(96, 138);
      ctx.fill();
      ctx.fillStyle = dark ? '#3a2a20' : '#7a4a2a';
      ctx.fillRect(72, 140, 28, 4);
    }
  }), false);
}

export function timeOfDay(lighting: LightingPreset): TimeOfDay {
  return lighting === 'night' ? 'night' : lighting === 'evening' ? 'dusk' : lighting === 'warm' ? 'afternoon' : 'day';
}

// ---------------------------------------------------------------- facades

/** Texture and surface for a building's exterior; the building color tints it. */
export function facadeLook(facade: FacadeMaterial): { texture: THREE.Texture | null; tile: number; roughness: number; metalness: number } {
  switch (facade) {
    case 'brick': return { texture: brick(), tile: 1.1, roughness: 0.95, metalness: 0 };
    case 'wood': return { texture: woodPanels(), tile: 1.4, roughness: 0.8, metalness: 0 };
    case 'concrete': return { texture: concrete(), tile: 2, roughness: 0.9, metalness: 0 };
    case 'glass': return { texture: null, tile: 1, roughness: 0.2, metalness: 0.1 };
    default: return { texture: null, tile: 1, roughness: 0.7, metalness: 0 };
  }
}

/** A swatch image for material pickers. */
export function swatchUrl(texture: THREE.Texture | null): string | null {
  const image = texture?.image as HTMLCanvasElement | undefined;
  return image?.toDataURL ? image.toDataURL() : null;
}
