import { useEffect, useRef } from 'react';
import { WinterEngine, type Settings, type Stats } from '../engine/WinterEngine';

interface Props {
  initialSettings: Settings;
  onEngine: (engine: WinterEngine | null) => void;
  onStats: (stats: Stats) => void;
}

/** Hosts the canvas and owns the engine's lifetime. Never re-renders on its own. */
export function AsciiCanvas({ initialSettings, onEngine, onStats }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const initial = useRef(initialSettings);
  const statsCb = useRef(onStats);
  statsCb.current = onStats;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new WinterEngine(canvas, initial.current, (s) => statsCb.current(s));
    engine.start();
    onEngine(engine);
    return () => {
      engine.destroy();
      onEngine(null);
    };
  }, [onEngine]);

  return <canvas ref={canvasRef} className="ascii-canvas" />;
}
