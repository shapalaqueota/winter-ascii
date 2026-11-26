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

  w a s d  walk          shift   run
  space    jump          mouse   look (click first)
  arrows   walk / turn   esc     release the mouse

  click    shoot         r       reload

  keep the fire alive: walk over sticks in the
  forest to pick them up (max 5), then press
  e        at the fire to feed it
  zombies will not enter the firelight —
  the stronger the fire, the wider the safe circle
  t        plant a torch (1 stick, lasts ~75 s)
  r        play again after the game ends

  survive 5 nights: at dawn the dead burn away and
  you get a short, safe day to gather wood
  radar (top right): @ fire  z zombie  = stick  ! torch

  p        pause / resume
  f        fullscreen
  1 / 2    snow   less / more
  3 / 4    wind   left / right
  5 / 6    speed  slower / faster
  7 / 8    glow   dimmer / brighter
  h  ?     this help`}</pre>
    </div>
  );
}
