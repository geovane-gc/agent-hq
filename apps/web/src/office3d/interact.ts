import type { Object3D } from 'three';

/** Attach as `userData.interact` on any group the player can click or use. */
export interface Interactable {
  label: string;
  action: () => void;
}

/** Walks up from a hit object to the nearest interactable ancestor. */
export function findInteractable(object: Object3D | null): Interactable | null {
  for (let o = object; o; o = o.parent) {
    const i = o.userData?.interact as Interactable | undefined;
    if (i) return i;
  }
  return null;
}
