import * as THREE from 'three';
import { canvasTexture } from '../textures.ts';

// Small canvas textures for decorations: prints, screens, boards. Drawn once.

const cache = new Map<string, THREE.CanvasTexture>();
function art(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  let t = cache.get(key);
  if (!t) cache.set(key, (t = canvasTexture(w, h, draw)));
  return t;
}

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

export const posterArt = () => art('poster', 128, 176, (ctx) => {
  ctx.fillStyle = '#f3efe6';
  ctx.fillRect(0, 0, 128, 176);
  ctx.fillStyle = '#e5484d';
  ctx.beginPath();
  ctx.arc(46, 62, 34, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3d63dd';
  ctx.fillRect(58, 70, 50, 70);
  ctx.fillStyle = '#ffb224';
  ctx.beginPath();
  ctx.moveTo(18, 150);
  ctx.lineTo(60, 96);
  ctx.lineTo(96, 150);
  ctx.fill();
  ctx.fillStyle = '#1c2026';
  ctx.fillRect(18, 160, 60, 4);
});

export const landscapeArt = () => art('landscape', 192, 128, (ctx) => {
  const sky = ctx.createLinearGradient(0, 0, 0, 80);
  sky.addColorStop(0, '#f08a5d');
  sky.addColorStop(1, '#f9d29d');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 192, 128);
  ctx.fillStyle = '#fff3c4';
  ctx.beginPath();
  ctx.arc(130, 58, 14, 0, Math.PI * 2);
  ctx.fill();
  const ranges: Array<[string, number]> = [['#7a5c8a', 70], ['#4f4a7a', 88], ['#2f3d5c', 104]];
  ranges.forEach(([color, base], i) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 128);
    for (let x = 0; x <= 192; x += 24) ctx.lineTo(x, base - ((x * (i + 3)) % 37));
    ctx.lineTo(192, 128);
    ctx.fill();
  });
});

export const clockFace = () => art('clock', 128, 128, (ctx) => {
  ctx.fillStyle = '#fbfaf6';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#1c2026';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = i % 3 === 0 ? 6 : 3;
    ctx.fillRect(64 + Math.sin(a) * 52 - r / 2, 64 - Math.cos(a) * 52 - r / 2, r, r);
  }
});

export const worldMap = () => art('map', 256, 128, (ctx) => {
  ctx.fillStyle = '#9cc9e8';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#e9e1c8';
  const blobs: Array<[number, number, number, number]> = [
    [55, 40, 34, 22], [70, 85, 16, 26], [128, 38, 22, 16], [135, 72, 18, 26], [185, 42, 44, 22], [205, 92, 16, 10],
  ];
  for (const [x, y, rx, ry] of blobs) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#e5484d';
  for (const [x, y] of [[48, 42], [132, 36], [196, 46], [70, 88], [204, 92]]) {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  for (let x = 0; x < 256; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 128); ctx.stroke(); }
  for (let y = 0; y < 128; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke(); }
});

export const corkArt = () => art('cork', 192, 128, (ctx) => {
  const rand = rng(3);
  ctx.fillStyle = '#c69a62';
  ctx.fillRect(0, 0, 192, 128);
  for (let i = 0; i < 500; i++) {
    ctx.fillStyle = rand() > 0.5 ? '#b88a52' : '#d2a874';
    ctx.fillRect(rand() * 192, rand() * 128, 2, 2);
  }
  const notes = ['#ffd84d', '#7cc7ff', '#ffa94d', '#8ce99a', '#ffffff'];
  for (let i = 0; i < 9; i++) {
    const x = 10 + (i % 4) * 45 + rand() * 6;
    const y = 10 + Math.floor(i / 4) * 40 + rand() * 6;
    ctx.save();
    ctx.translate(x + 15, y + 15);
    ctx.rotate((rand() - 0.5) * 0.3);
    ctx.fillStyle = notes[i % notes.length];
    ctx.fillRect(-15, -15, 30, 30);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    for (let l = 0; l < 3; l++) ctx.fillRect(-11, -8 + l * 7, 18 + rand() * 4, 2);
    ctx.fillStyle = '#d1435b';
    ctx.beginPath();
    ctx.arc(0, -13, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
});

/** White glowing text on black: tinted per item, drawn additively. */
export const neonText = () => art('neon', 256, 96, (ctx) => {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 256, 96);
  ctx.font = 'bold 50px "Arial Rounded MT Bold", "Trebuchet MS", "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  // a soft halo, then the tube itself
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 16;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 7;
  ctx.strokeText('SHIP IT', 128, 50);
  ctx.shadowBlur = 4;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3.5;
  ctx.strokeText('SHIP IT', 128, 50);
});

export const serverLeds = () => art('leds', 64, 192, (ctx) => {
  const rand = rng(8);
  ctx.fillStyle = '#16191f';
  ctx.fillRect(0, 0, 64, 192);
  for (let y = 4; y < 192; y += 12) {
    ctx.fillStyle = '#23272f';
    ctx.fillRect(3, y, 58, 9);
    for (let x = 8; x < 56; x += 7) {
      if (rand() < 0.5) continue;
      ctx.fillStyle = rand() < 0.75 ? '#3dff8a' : rand() < 0.5 ? '#ffb224' : '#4fb3ff';
      ctx.fillRect(x, y + 3, 3, 3);
    }
  }
});

export const dashboard = () => art('dashboard', 192, 112, (ctx) => {
  ctx.fillStyle = '#121722';
  ctx.fillRect(0, 0, 192, 112);
  ctx.fillStyle = '#1d2533';
  for (const [x, y, w, h] of [[6, 6, 88, 46], [100, 6, 86, 46], [6, 58, 180, 48]]) ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#3dd68c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= 172; x += 12) ctx.lineTo(12 + x, 96 - Math.abs(Math.sin(x * 0.07)) * 26 - x * 0.08);
  ctx.stroke();
  ctx.fillStyle = '#4f8cff';
  for (let i = 0; i < 6; i++) ctx.fillRect(14 + i * 13, 44 - i * 5 - 6, 9, i * 5 + 6);
  ctx.fillStyle = '#ffb224';
  ctx.beginPath();
  ctx.moveTo(143, 29);
  ctx.arc(143, 29, 18, -Math.PI / 2, Math.PI * 0.9);
  ctx.fill();
});

export const snacks = () => art('snacks', 96, 160, (ctx) => {
  const colors = ['#e5484d', '#ffb224', '#30a46c', '#3d63dd', '#8e4ec6', '#f76b15'];
  ctx.fillStyle = '#d7e4ee';
  ctx.fillRect(0, 0, 96, 160);
  for (let row = 0; row < 5; row++) {
    ctx.fillStyle = '#9aa7b3';
    ctx.fillRect(0, row * 32 + 28, 96, 3);
    for (let col = 0; col < 4; col++) {
      ctx.fillStyle = colors[(row * 4 + col) % colors.length];
      ctx.fillRect(6 + col * 22, row * 32 + 8, 15, 20);
    }
  }
});

export const arcadeScreen = () => art('arcade', 96, 96, (ctx) => {
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(0, 0, 96, 96);
  const rand = rng(12);
  const alien = ['#3dff8a', '#ff4fd8', '#4fb3ff'];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 6; col++) {
      ctx.fillStyle = alien[row];
      ctx.fillRect(10 + col * 13, 12 + row * 12, 8, 6);
    }
  }
  ctx.fillStyle = '#ffd84d';
  ctx.fillRect(42, 82, 12, 5);
  for (let i = 0; i < 20; i++) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fillRect(rand() * 96, rand() * 96, 1, 1);
  }
});

export const dartboard = () => art('dartboard', 128, 128, (ctx) => {
  ctx.fillStyle = '#1c1c1c';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 20; i++) {
    const a0 = (i / 20) * Math.PI * 2;
    const a1 = ((i + 1) / 20) * Math.PI * 2;
    for (const [r, colors] of [[60, ['#e5484d', '#30a46c']], [52, ['#f3e7c9', '#1c1c1c']], [34, ['#e5484d', '#30a46c']], [28, ['#f3e7c9', '#1c1c1c']]] as const) {
      ctx.fillStyle = colors[i % 2];
      ctx.beginPath();
      ctx.moveTo(64, 64);
      ctx.arc(64, 64, r, a0, a1);
      ctx.fill();
    }
  }
  ctx.fillStyle = '#30a46c';
  ctx.beginPath();
  ctx.arc(64, 64, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e5484d';
  ctx.beginPath();
  ctx.arc(64, 64, 3, 0, Math.PI * 2);
  ctx.fill();
});

export const grass = () => {
  const t = art('grass', 128, 128, (ctx) => {
    const rand = rng(6);
    ctx.fillStyle = '#4f9a3c';
    ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 1400; i++) {
      ctx.fillStyle = ['#5fae48', '#468a35', '#6cbb52'][i % 3];
      ctx.fillRect(rand() * 128, rand() * 128, 1, 3);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return t;
};

export const stripes = () => art('stripes', 128, 128, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#d9d2c5';
  for (let y = 10; y < 128; y += 26) ctx.fillRect(0, y, 128, 6);
  ctx.strokeStyle = '#efe8da';
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, 120, 120);
});
