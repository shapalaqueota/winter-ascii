import type { RefObject } from 'react';
import type { Settings } from '../engine/WinterEngine';

export const LIMITS = {
  speed: { min: 0.25, max: 3, step: 0.25 },
  wind: { min: -3, max: 3, step: 0.2 },
  snow: { min: 0, max: 3, step: 0.25 },
  glow: { min: 0, max: 2.5, step: 0.25 },
} as const;

export type Adjustable = keyof typeof LIMITS;

interface Props {
  settings: Settings;
  fpsRef: RefObject<HTMLSpanElement | null>;
  onAdjust: (key: Adjustable, dir: 1 | -1) => void;
  onTogglePause: () => void;
  onFullscreen: () => void;
  onToggleHelp: () => void;
}

function Stepper({ label, value, digits, onStep }: {
  label: string; value: number; digits: number; onStep: (dir: 1 | -1) => void;
}) {
  return (
    <span className="seg">
      {label}
      <button onClick={() => onStep(-1)} aria-label={`decrease ${label}`}>-</button>
      <span className="val">{value.toFixed(digits)}</span>
      <button onClick={() => onStep(1)} aria-label={`increase ${label}`}>+</button>
    </span>
  );
}

export function ControlPanel({ settings, fpsRef, onAdjust, onTogglePause, onFullscreen, onToggleHelp }: Props) {
  return (
    <div className="panel">
      <span className="seg title">{settings.paused ? 'NIGHT ‖' : 'NIGHT ●'}</span>
      <span className="sep">|</span>
      <Stepper label="SPEED" value={settings.speed} digits={2} onStep={(d) => onAdjust('speed', d)} />
      <span className="sep">|</span>
      <Stepper label="WIND" value={settings.wind} digits={1} onStep={(d) => onAdjust('wind', d)} />
      <span className="sep">|</span>
      <Stepper label="SNOW" value={settings.snow} digits={2} onStep={(d) => onAdjust('snow', d)} />
      <span className="sep">|</span>
      <Stepper label="GLOW" value={settings.glow} digits={2} onStep={(d) => onAdjust('glow', d)} />
      <span className="sep">|</span>
      <span className="seg">FPS <span className="val" ref={fpsRef}>--</span></span>
      <span className="sep">|</span>
      <button className="seg" onClick={onTogglePause}>{settings.paused ? 'RESUME' : 'PAUSE'}</button>
      <button className="seg" onClick={onFullscreen}>FULL</button>
      <button className="seg" onClick={onToggleHelp}>HELP</button>
    </div>
  );
}

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="help" onClick={onClose}>
      <pre>{`  NIGHT  —  controls

  space    pause / resume
  f        fullscreen
  m        mouse camera on / off
  1 / 2    snow   less / more
  3 / 4    wind   left / right
  5 / 6    speed  slower / faster
  7 / 8    glow   dimmer / brighter
  h  ?     this help

  move the mouse to look around`}</pre>
    </div>
  );
}
