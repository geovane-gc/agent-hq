import type { LightingPreset } from '@agent-hq/protocol';
import type { FloorPlan } from '../layout.ts';

// Lighting presets: real changes to the scene's light colors and
// intensities, the sky behind the office, the ceiling panels and how much
// the lamps you place contribute.

export interface Lighting {
  /** Background and fog. */
  sky: string;
  hemiSky: string;
  hemiGround: string;
  hemi: number;
  sun: string;
  sunIntensity: number;
  /** Sun direction relative to the floor's center (low at dusk). */
  sunOffset: [number, number, number];
  /** Ceiling light panels, and the (unlit) ceiling around them. */
  panel: string;
  ceiling: string;
  /** Multiplier for placed lamps (they matter more after dark). */
  lamps: number;
}

export const LIGHTING: Record<LightingPreset, Lighting> = {
  daylight: { ceiling: '#dfe3e8', sky: '#cfd8e3', hemiSky: '#ffffff', hemiGround: '#8a7a66', hemi: 0.9, sun: '#ffffff', sunIntensity: 1.6, sunOffset: [8, 14, 6], panel: '#fffdf5', lamps: 0.6 },
  warm: { ceiling: '#e4dccf', sky: '#e5d6c4', hemiSky: '#fff0d9', hemiGround: '#8a6a4a', hemi: 0.85, sun: '#ffd9a8', sunIntensity: 1.5, sunOffset: [10, 11, 7], panel: '#ffe6bf', lamps: 0.8 },
  cool: { ceiling: '#dde4ec', sky: '#cad7e6', hemiSky: '#eef5ff', hemiGround: '#6f7a88', hemi: 0.95, sun: '#e2edff', sunIntensity: 1.4, sunOffset: [6, 15, 5], panel: '#eef6ff', lamps: 0.6 },
  evening: { ceiling: '#8f8191', sky: '#5a4766', hemiSky: '#ffb88f', hemiGround: '#3a2c3a', hemi: 0.65, sun: '#ff9a5a', sunIntensity: 0.95, sunOffset: [16, 5, 4], panel: '#ffd29a', lamps: 1.4 },
  night: { ceiling: '#4a4f66', sky: '#161b2e', hemiSky: '#7d89cc', hemiGround: '#231d2e', hemi: 0.62, sun: '#a9bbff', sunIntensity: 0.55, sunOffset: [6, 14, -8], panel: '#d4dcff', lamps: 2 },
};

/** Sky, fog, the ambient hemisphere and the shadow-casting sun for one floor. */
export function SceneLighting(props: { preset: LightingPreset; firstPerson: boolean; plan: FloorPlan; span: number }) {
  const l = LIGHTING[props.preset] ?? LIGHTING.daylight;
  const { plan, span } = props;
  // First person sees the room from inside, under the ceiling: more fill, less sun.
  const hemi = l.hemi * (props.firstPerson ? 1.4 : 1);
  const sun = l.sunIntensity * (props.firstPerson ? 0.7 : 1);
  return (
    <>
      <color attach="background" args={[l.sky]} />
      <fog attach="fog" args={[l.sky, 40, 90]} />
      <hemisphereLight args={[l.hemiSky, l.hemiGround, hemi]} />
      <directionalLight
        position={[plan.center[0] + l.sunOffset[0], l.sunOffset[1], plan.center[2] + l.sunOffset[2]]}
        color={l.sun}
        intensity={sun}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-span}
        shadow-camera-right={span}
        shadow-camera-top={span}
        shadow-camera-bottom={-span}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      />
    </>
  );
}
