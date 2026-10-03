import { createContext, useContext, type ComponentProps, type RefObject } from 'react';
import { Html } from '@react-three/drei';

/**
 * DOM layer that hosts every in-world label. Giving drei's <Html> a stable
 * portal avoids a mount race where the first label of a scene rendered into a
 * container that was immediately replaced, leaving it permanently empty.
 */
export const HtmlLayer = createContext<RefObject<HTMLDivElement | null> | null>(null);

/** Multiplies every label's distanceFactor; first person uses smaller labels. */
export const LabelScale = createContext(1);

export function Label(props: ComponentProps<typeof Html>) {
  const layer = useContext(HtmlLayer);
  const scale = useContext(LabelScale);
  return (
    <Html
      {...props}
      distanceFactor={props.distanceFactor ? props.distanceFactor * scale : undefined}
      portal={(layer ?? undefined) as RefObject<HTMLElement> | undefined}
    />
  );
}
