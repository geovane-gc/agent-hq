import * as THREE from 'three';

// Procedural textures drawn on canvases, so the office needs no binary assets.

/**
 * Asked of every texture; three clamps it to what the GPU supports (16 on
 * Apple Silicon and most desktop GPUs), so there's no need to wait for the renderer.
 */
const MAX_ANISOTROPY = 16;

/**
 * Filtering for any texture drawn on a surface: trilinear mipmaps, so detail
 * smaller than a pixel averages out instead of shimmering as the camera moves,
 * and full anisotropic filtering, so floors and walls seen at a grazing angle
 * stay sharp instead of smearing. Any size works (WebGL 2 mipmaps
 * non-power-of-two textures). Every texture should go through this, or through
 * `canvasTexture`, which does.
 */
export function filtered<T extends THREE.Texture>(tex: T): T {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = MAX_ANISOTROPY;
  return tex;
}

/** A texture drawn once on a canvas, filtered for use on a surface. */
export function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!);
  return filtered(new THREE.CanvasTexture(canvas));
}

/**
 * Material props for a flat face laid over another one a millimeter or so
 * away (a screen in its bezel, a print in its frame, coffee in a mug): pulls
 * it towards the camera in the depth test, so the two surfaces can't trade
 * places from frame to frame (z-fighting, seen as flicker while the camera moves).
 * Spread into a material (`<meshBasicMaterial {...DECAL} />`) or `Object.assign` it.
 */
export const DECAL = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 } as const;

let codeTexture: THREE.CanvasTexture | null = null;

/** Syntax-highlighted "code" that scrolls on working agents' monitors. */
export function getCodeTexture() {
  if (codeTexture) return codeTexture;
  const colors = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#c0caf5'];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  codeTexture = canvasTexture(256, 512, (ctx) => {
    ctx.fillStyle = '#1a1b26';
    ctx.fillRect(0, 0, 256, 512);
    for (let y = 8; y < 512; y += 14) {
      let x = 10 + Math.floor(rand() * 4) * 14;
      const tokens = 1 + Math.floor(rand() * 5);
      for (let t = 0; t < tokens && x < 240; t++) {
        const w = 12 + rand() * 46;
        ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
        ctx.fillRect(x, y, Math.min(w, 246 - x), 6);
        x += w + 6;
      }
    }
  });
  codeTexture.wrapS = codeTexture.wrapT = THREE.RepeatWrapping;
  codeTexture.repeat.set(1, 0.4);
  return codeTexture;
}

let floorTexture: THREE.CanvasTexture | null = null;

/** Warm wooden planks. */
export function getFloorTexture() {
  if (floorTexture) return floorTexture;
  floorTexture = canvasTexture(512, 512, (ctx) => {
    const tones = ['#c8a27a', '#c19a72', '#cfa982', '#bb946c'];
    const plankH = 64;
    for (let row = 0; row < 512 / plankH; row++) {
      const offset = (row % 2) * 128;
      for (let x = -offset; x < 512; x += 256) {
        ctx.fillStyle = tones[(row * 3 + Math.abs(x)) % tones.length];
        ctx.fillRect(x, row * plankH, 256, plankH);
        ctx.strokeStyle = 'rgba(80, 50, 25, 0.35)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, row * plankH + 1, 254, plankH - 2);
      }
    }
  });
  floorTexture.wrapS = floorTexture.wrapT = THREE.RepeatWrapping;
  return floorTexture;
}

let tilesTexture: THREE.CanvasTexture | null = null;

export function getTilesTexture() {
  if (tilesTexture) return tilesTexture;
  tilesTexture = canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#e8e8e4';
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = '#b9b9b2';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, 64, 64);
    ctx.strokeRect(64, 0, 64, 64);
    ctx.strokeRect(0, 64, 64, 64);
    ctx.strokeRect(64, 64, 64, 64);
  });
  tilesTexture.wrapS = tilesTexture.wrapT = THREE.RepeatWrapping;
  return tilesTexture;
}

let carpetTexture: THREE.CanvasTexture | null = null;

export function getCarpetTexture() {
  if (carpetTexture) return carpetTexture;
  carpetTexture = canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#4a5a78';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#52648a';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillRect(64, 64, 64, 64);
  });
  carpetTexture.wrapS = carpetTexture.wrapT = THREE.RepeatWrapping;
  return carpetTexture;
}
