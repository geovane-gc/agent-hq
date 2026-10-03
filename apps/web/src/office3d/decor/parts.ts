import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Decorations are built from simple parts (boxes, cylinders, spheres, glTF
// meshes) in code. An item's parts are compiled once into one merged
// geometry per material, so every item type costs a handful of draw calls
// however many copies are placed: Decorations.tsx renders each of those
// merged parts as one InstancedMesh.

export type V3 = [number, number, number];

export interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Item-local transform (identity once compiled). */
  matrix: THREE.Matrix4;
  /** Colored per item (instance color) with the item's tint. */
  tint: boolean;
  castShadow: boolean;
}

export interface ItemModel {
  parts: Part[];
}

// ---------------------------------------------------------------- materials

const materials = new Map<string, THREE.Material>();
const tintMaterials = new WeakSet<THREE.Material>();
/** Lamp shades and bulbs: their glow follows the lighting preset. */
export const GLOW_MATERIALS = new Set<THREE.MeshStandardMaterial>();

export interface MatOptions {
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
  map?: THREE.Texture;
  opacity?: number;
  /** Unlit (screens, neon). */
  basic?: boolean;
  side?: THREE.Side;
}

/** A shared material: same arguments, same instance. */
export function mat(color: string, o: MatOptions = {}): THREE.Material {
  const key = `${color}|${o.roughness ?? 0.7}|${o.metalness ?? 0}|${o.emissive ?? ''}|${o.emissiveIntensity ?? 1}|${o.map?.uuid ?? ''}|${o.opacity ?? 1}|${o.basic ? 1 : 0}|${o.side ?? 0}`;
  let m = materials.get(key);
  if (!m) {
    const transparent = (o.opacity ?? 1) < 1;
    if (o.basic) {
      m = new THREE.MeshBasicMaterial({ color, map: o.map ?? null, transparent, opacity: o.opacity ?? 1, toneMapped: false, side: o.side ?? THREE.FrontSide });
    } else {
      const s = new THREE.MeshStandardMaterial({
        color, roughness: o.roughness ?? 0.7, metalness: o.metalness ?? 0, map: o.map ?? null,
        transparent, opacity: o.opacity ?? 1, side: o.side ?? THREE.FrontSide, depthWrite: !transparent,
      });
      if (o.emissive) {
        s.emissive.set(o.emissive);
        s.emissiveIntensity = o.emissiveIntensity ?? 1;
        s.userData.baseGlow = s.emissiveIntensity;
        GLOW_MATERIALS.add(s);
      }
      m = s;
    }
    materials.set(key, m);
  }
  return m;
}

/** A white material whose color comes from each item's tint. */
export function tint(o: MatOptions = {}): THREE.Material {
  const m = mat('#ffffff', o);
  tintMaterials.add(m);
  return m;
}

// ---------------------------------------------------------------- geometries

const geometries = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry) {
  let g = geometries.get(key);
  if (!g) geometries.set(key, (g = make()));
  return g;
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const tmp = new THREE.Matrix4();
const euler = new THREE.Euler();
const quat = new THREE.Quaternion();

export function compose(pos: V3, rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) {
  return new THREE.Matrix4().compose(new THREE.Vector3(...pos), quat.setFromEuler(euler.set(rot[0], rot[1], rot[2])).clone(), new THREE.Vector3(...scale));
}

/** Collects an item's parts. Positions are item-local: origin on the floor at the footprint's center, front facing +Z. */
export class Parts {
  readonly list: Part[] = [];
  private shadow = true;

  /** Flat things (rugs) don't need to cast shadows. */
  noShadow() {
    this.shadow = false;
    return this;
  }

  add(geometry: THREE.BufferGeometry, material: THREE.Material, matrix: THREE.Matrix4) {
    this.list.push({ geometry, material, matrix, tint: tintMaterials.has(material), castShadow: this.shadow });
    return this;
  }

  box(size: V3, pos: V3, material: THREE.Material, rot: V3 = [0, 0, 0]) {
    return this.add(UNIT_BOX, material, compose(pos, rot, size));
  }

  cyl(rTop: number, rBottom: number, height: number, pos: V3, material: THREE.Material, rot: V3 = [0, 0, 0], segments = 18) {
    const g = geo(`cyl:${rTop}:${rBottom}:${height}:${segments}`, () => new THREE.CylinderGeometry(rTop, rBottom, height, segments));
    return this.add(g, material, compose(pos, rot));
  }

  sphere(radius: number, pos: V3, material: THREE.Material, scale: V3 = [1, 1, 1], segments = 14) {
    const g = geo(`sphere:${segments}`, () => new THREE.SphereGeometry(1, segments, Math.max(6, Math.round(segments * 0.7))));
    return this.add(g, material, compose(pos, [0, 0, 0], [radius * scale[0], radius * scale[1], radius * scale[2]]));
  }

  cone(radius: number, height: number, pos: V3, material: THREE.Material, rot: V3 = [0, 0, 0], segments = 12) {
    const g = geo(`cone:${radius}:${height}:${segments}`, () => new THREE.ConeGeometry(radius, height, segments));
    return this.add(g, material, compose(pos, rot));
  }

  torus(radius: number, tube: number, arc: number, pos: V3, material: THREE.Material, rot: V3 = [0, 0, 0]) {
    const g = geo(`torus:${radius}:${tube}:${arc}`, () => new THREE.TorusGeometry(radius, tube, 8, 24, arc));
    return this.add(g, material, compose(pos, rot));
  }

  /** A flat rectangle facing +Z (screens, prints, labels). */
  plane(w: number, h: number, pos: V3, material: THREE.Material, rot: V3 = [0, 0, 0]) {
    const g = geo('plane', () => new THREE.PlaneGeometry(1, 1));
    return this.add(g, material, compose(pos, rot, [w, h, 1]));
  }

  /** A flat disc facing +Z. */
  disc(radius: number, pos: V3, material: THREE.Material, rot: V3 = [0, 0, 0]) {
    const g = geo('disc', () => new THREE.CircleGeometry(1, 32));
    return this.add(g, material, compose(pos, rot, [radius, radius, 1]));
  }

  ring(inner: number, outer: number, pos: V3, material: THREE.Material, rot: V3 = [0, 0, 0]) {
    const g = geo(`ring:${inner}:${outer}`, () => new THREE.RingGeometry(inner, outer, 40));
    return this.add(g, material, compose(pos, rot));
  }

  /** Every mesh of a loaded glTF scene; `swap` replaces materials by name (e.g. to make one tintable). */
  gltf(scene: THREE.Object3D, swap: Record<string, THREE.Material> = {}, root: THREE.Matrix4 = new THREE.Matrix4()) {
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.Material;
      this.add(mesh.geometry, swap[material.name] ?? material, root.clone().multiply(mesh.matrixWorld));
    });
    return this;
  }
}

/**
 * Merges the parts that share a material into one geometry, transforms
 * applied. Parts whose attributes can't be merged stay as they are.
 */
export function compile(parts: Part[]): ItemModel {
  const groups = new Map<THREE.Material, Part[]>();
  for (const p of parts) {
    const list = groups.get(p.material) ?? [];
    list.push(p);
    groups.set(p.material, list);
  }
  const out: Part[] = [];
  for (const [material, list] of groups) {
    const mixed = list.some((p) => !p.geometry.index) && list.some((p) => !!p.geometry.index);
    const prepared = list.map((p) => {
      // Indexed and non-indexed geometries don't merge together.
      const g = mixed && p.geometry.index ? p.geometry.toNonIndexed() : p.geometry.clone();
      g.applyMatrix4(p.matrix);
      // Keep only what every primitive has, so they merge.
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      return g;
    });
    const sameShape = prepared.every((g) => Object.keys(g.attributes).sort().join() === Object.keys(prepared[0].attributes).sort().join());
    const merged = sameShape && prepared.length > 1 ? mergeGeometries(prepared, false) : prepared.length === 1 ? prepared[0] : null;
    if (merged) {
      merged.computeBoundingSphere();
      out.push({ geometry: merged, material, matrix: new THREE.Matrix4(), tint: list[0].tint, castShadow: list.some((p) => p.castShadow) });
    } else {
      prepared.forEach((g, i) => out.push({ geometry: g, material, matrix: new THREE.Matrix4(), tint: list[i].tint, castShadow: list[i].castShadow }));
    }
  }
  return { parts: out };
}

/** World matrix of a placed item (wall items include their hanging height in their parts). */
export function placement(x: number, z: number, rotation: number, out = tmp) {
  return out.compose(new THREE.Vector3(x, 0, z), quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotation * (Math.PI / 2)), new THREE.Vector3(1, 1, 1));
}
