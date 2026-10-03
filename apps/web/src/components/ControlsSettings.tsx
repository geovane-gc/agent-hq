import { CONTROL_RANGES, DEFAULT_CONTROLS, controlsPrefs, useControlsPrefs, type NumericPref } from '../controlsPrefs.ts';
import '../controls.css';

/** A multiplier slider with its value next to it. */
function Slider({ pref, label, hint }: { pref: NumericPref; label: string; hint: string }) {
  const prefs = useControlsPrefs();
  const r = CONTROL_RANGES[pref];
  const value = prefs[pref];
  return (
    <label className="slider-field">
      <span><strong>{label}</strong><small>{hint}</small></span>
      <input
        type="range" min={r.min} max={r.max} step={r.step} value={value}
        onChange={(e) => controlsPrefs.set({ [pref]: Number(e.target.value) })}
        onDoubleClick={() => controlsPrefs.set({ [pref]: DEFAULT_CONTROLS[pref] })}
      />
      <output className={value === DEFAULT_CONTROLS[pref] ? 'muted' : ''}>{value.toFixed(2)}×</output>
    </label>
  );
}

/** Settings → Controls: mouse and camera preferences of this player, on this browser. */
export function ControlsSettings() {
  const prefs = useControlsPrefs();
  const changed = (Object.keys(DEFAULT_CONTROLS) as Array<keyof typeof DEFAULT_CONTROLS>).some((k) => prefs[k] !== DEFAULT_CONTROLS[k]);
  return (
    <div className="form settings-grid controls-settings">
      <section className="card-section">
        <h3>Walk mode</h3>
        <p className="hint">First person: the mouse looks around while it is captured.</p>
        <Slider pref="lookSensitivity" label="Mouse sensitivity" hint="How far the view turns per mouse move." />
        <label className="toggle">
          <input type="checkbox" role="switch" checked={prefs.invertY} onChange={(e) => controlsPrefs.set({ invertY: e.target.checked })} />
          <span><strong>Invert Y</strong><small>Moving the mouse up looks down.</small></span>
        </label>
        <Slider pref="walkSpeed" label="Movement speed" hint="Walking and running (Shift)." />
      </section>
      <section className="card-section">
        <h3>Overview camera</h3>
        <p className="hint">The elevated view: drag, right-drag and wheel.</p>
        <Slider pref="orbitRotate" label="Rotate speed" hint="Drag to orbit." />
        <Slider pref="orbitPan" label="Pan speed" hint="Right-drag, and WASD sliding." />
        <Slider pref="orbitZoom" label="Zoom speed" hint="Mouse wheel or pinch." />
      </section>
      <div className="row span2">
        <span className="hint">Saved on this browser only, and applied right away. Double-click a slider to reset it.</span>
        <span className="spacer" />
        <button className="ghost" disabled={!changed} onClick={() => controlsPrefs.reset()}>Reset to defaults</button>
      </div>
    </div>
  );
}
