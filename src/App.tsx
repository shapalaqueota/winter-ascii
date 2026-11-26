import { useCallback, useEffect, useRef, useState } from 'react';
import { AsciiCanvas } from './components/AsciiCanvas';
import { ControlPanel, HelpOverlay, LIMITS, type Adjustable } from './components/ControlPanel';
import type { Settings, Stats, WinterEngine } from './engine/WinterEngine';

const DEFAULTS: Settings = {
  speed: 1,
  wind: 0.4,
  snow: 1,
  glow: 1,
  paused: false,
  mouseCamera: true,
};

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
}

export default function App() {
  const engineRef = useRef<WinterEngine | null>(null);
  const fpsRef = useRef<HTMLSpanElement>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [help, setHelp] = useState(false);

  // settings flow one way into the engine; the engine never triggers React renders
  useEffect(() => {
    engineRef.current?.setSettings(settings);
  }, [settings]);

  const onEngine = useCallback((e: WinterEngine | null) => {
    engineRef.current = e;
  }, []);

  // FPS is written straight into the DOM so the panel doesn't re-render 4x a second
  const onStats = useCallback((s: Stats) => {
    if (fpsRef.current) fpsRef.current.textContent = String(Math.round(s.fps));
  }, []);

  const adjust = useCallback((key: Adjustable, dir: 1 | -1) => {
    const { min, max, step } = LIMITS[key];
    setSettings((s) => {
      const v = Math.round((s[key] + dir * step) / step) * step;
      return { ...s, [key]: Math.min(max, Math.max(min, Number(v.toFixed(2)))) };
    });
  }, []);

  const togglePause = useCallback(() => setSettings((s) => ({ ...s, paused: !s.paused })), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case ' ': e.preventDefault(); togglePause(); break;
        case 'f': toggleFullscreen(); break;
        case 'm': setSettings((s) => ({ ...s, mouseCamera: !s.mouseCamera })); break;
        case 'h': case '?': setHelp((h) => !h); break;
        case 'escape': setHelp(false); break;
        case '1': adjust('snow', -1); break;
        case '2': adjust('snow', 1); break;
        case '3': adjust('wind', -1); break;
        case '4': adjust('wind', 1); break;
        case '5': adjust('speed', -1); break;
        case '6': adjust('speed', 1); break;
        case '7': adjust('glow', -1); break;
        case '8': adjust('glow', 1); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [adjust, togglePause]);

  return (
    <div className="app">
      <AsciiCanvas initialSettings={DEFAULTS} onEngine={onEngine} onStats={onStats} />
      <ControlPanel
        settings={settings}
        fpsRef={fpsRef}
        onAdjust={adjust}
        onTogglePause={togglePause}
        onFullscreen={toggleFullscreen}
        onToggleHelp={() => setHelp((h) => !h)}
      />
      {help && <HelpOverlay onClose={() => setHelp(false)} />}
    </div>
  );
}
