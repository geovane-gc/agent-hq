import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Appearance } from '@agent-hq/protocol';

// Character "photos": the 3D character's head and shoulders rendered once per
// look with one shared offscreen WebGL renderer, kept as PNG data URLs in
// memory and in localStorage. The character is dressed like `Character` in
// office3d/models.tsx (same material and node names), standing in the first
// frame of its Stand clip.

export type Outfit = 'casual' | 'suit';

/** Rendered pixels per side: crisp up to 64 CSS px on 2x screens. */
const SIZE = 128;
/** Bump to re-render every cached portrait (e.g. after changing the framing or the models). */
const VERSION = 3;
const STORAGE_PREFIX = `hq-portrait:v${VERSION}:`;
const HAIR_NODES = { short: 'Hair_Short', long: 'Hair_Long', bun: 'Hair_Bun' } as const;

export const portraitKey = (a: Appearance, outfit: Outfit = 'casual') => `${a.skin}|${a.hair}|${a.shirt}|${a.hairStyle}|${outfit}`;

const ready = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

/** A portrait already rendered (this session or a previous one), without waiting. */
export function cachedPortrait(key: string): string | null {
  const hit = ready.get(key);
  if (hit) return hit;
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + key);
    if (stored) ready.set(key, stored);
    return stored;
  } catch {
    return null;
  }
}

let model: Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> | null = null;
let stage: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera } | null = null;
/** Renders run one after another on the shared renderer. */
let queue: Promise<unknown> = Promise.resolve();
let broken = false;

function getStage() {
  if (stage) return stage;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);
  // Same look as the office's R3F canvas.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#8a7a66', 1.6));
  const key = new THREE.DirectionalLight('#ffffff', 2.2);
  key.position.set(-1.2, 2.4, -2.4); // in front of the face (characters look towards -Z), from above
  scene.add(key);
  const rim = new THREE.DirectionalLight('#dfe8ff', 0.8);
  rim.position.set(1.5, 2, 1.5);
  scene.add(rim);
  const camera = new THREE.PerspectiveCamera(24, 1, 0.05, 20);
  stage = { renderer, scene, camera };
  return stage;
}

function dress(source: THREE.Group, appearance: Appearance, outfit: Outfit): { root: THREE.Object3D; materials: THREE.Material[] } {
  const root = cloneSkinned(source);
  const colors: Record<string, string> = { Skin: appearance.skin, Hair: appearance.hair, Shirt: appearance.shirt };
  const materials: THREE.Material[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (colors[material.name]) {
      const m = material.clone();
      m.color.set(colors[material.name]);
      mesh.material = m;
      materials.push(m);
    }
  });
  for (const [style, node] of Object.entries(HAIR_NODES)) {
    const obj = root.getObjectByName(node);
    if (obj) obj.visible = appearance.hairStyle === style;
  }
  root.traverse((o) => { if (o.name.startsWith('Outfit_Suit')) o.visible = outfit === 'suit'; });
  return { root, materials };
}

async function render(appearance: Appearance, outfit: Outfit): Promise<string | null> {
  if (broken) return null;
  model ??= new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/character.glb`).then((g) => ({ scene: g.scene, animations: g.animations }));
  const { scene: source, animations } = await model;
  const { renderer, scene, camera } = getStage();
  const { root, materials } = dress(source, appearance, outfit);
  // A natural standing pose instead of the bind pose.
  const stand = THREE.AnimationClip.findByName(animations, 'Stand');
  const mixer = new THREE.AnimationMixer(root);
  if (stand) {
    mixer.clipAction(stand).play();
    mixer.update(0);
  }
  scene.add(root);
  root.updateMatrixWorld(true);
  // Frame head and shoulders: the head fills the top half, seen from the front and a little above.
  const head = new THREE.Box3();
  const headMesh = root.getObjectByName('HeadMesh') ?? root.getObjectByName('Head');
  if (headMesh) head.setFromObject(headMesh);
  if (head.isEmpty()) head.set(new THREE.Vector3(-0.12, 1.42, -0.12), new THREE.Vector3(0.12, 1.72, 0.12));
  const center = head.getCenter(new THREE.Vector3());
  const h = head.max.y - head.min.y;
  const frame = h * 1.85; // visible height
  const distance = frame / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  const target = new THREE.Vector3(center.x, center.y - h * 0.22, center.z);
  camera.position.set(target.x - distance * 0.1, target.y + distance * 0.06, target.z - distance);
  camera.lookAt(target);
  try {
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  } finally {
    scene.remove(root);
    mixer.stopAllAction();
    for (const m of materials) m.dispose();
  }
}

/** The portrait for a look: from the cache, or rendered (null when WebGL isn't available). */
export function portrait(appearance: Appearance, outfit: Outfit = 'casual'): Promise<string | null> {
  const key = portraitKey(appearance, outfit);
  const hit = cachedPortrait(key);
  if (hit) return Promise.resolve(hit);
  let job = pending.get(key);
  if (!job) {
    job = queue.then(() => render(appearance, outfit)).then((url) => {
      if (url) {
        ready.set(key, url);
        try { localStorage.setItem(STORAGE_PREFIX + key, url); } catch {}
      }
      return url;
    }, (err) => {
      console.warn('Could not render a portrait', err);
      if (!stage) broken = true; // no WebGL here: keep the initials
      return null;
    }).finally(() => pending.delete(key));
    queue = job;
    pending.set(key, job);
  }
  return job;
}
