/**
 * Character sets, the colour palette and the glyph atlas.
 *
 * Every frame the engine produces, per cell, a character index plus a
 * brightness (lum) and warmth value. Those are quantised into a fixed palette
 * so every (character, colour) pair can be pre-rendered once into an atlas and
 * blitted with drawImage, which is far faster than fillText per cell.
 */

export const FONT_FAMILY =
  '"JetBrains Mono", "Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", monospace';

/** General density ramp, dark -> bright. */
export const RAMP =
  " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
/** Snow on the ground: soft, non-directional glyphs so it doesn't streak. */
export const SNOW_RAMP = " .'`,:;~-+=*xzcvunoaeQO0#%@";
/** Shadowed needles inside a pine. */
export const TREE_DARK = '.:;!|i';
/** Snow lying on branches, dim -> bright. */
export const TREE_SNOW = '+*AH#M%@';
/** Flame layers, cool tips -> white-hot core. */
export const FLAME = "'`.:;^/\\(){}*x%&#@";
const EXTRA = 'oO0=_~-HAM·°✦❄*+.';

const unique = new Set<string>([' ', ...RAMP, ...SNOW_RAMP, ...TREE_DARK, ...TREE_SNOW, ...FLAME, ...EXTRA]);
export const CHARS: string[] = [...unique];
const INDEX = new Map(CHARS.map((c, i) => [c, i] as const));

export function ci(c: string): number {
  const i = INDEX.get(c);
  if (i === undefined) throw new Error(`glyph not in atlas: ${c}`);
  return i;
}

export function rampIdx(s: string): Uint8Array {
  return Uint8Array.from([...s].map(ci));
}

// ------------------------------------------------------------------ palette
export const LUM_LEVELS = 24;
export const WARM_LEVELS = 6;
export const COLOR_COUNT = LUM_LEVELS * WARM_LEVELS;

export function colorIndex(lum: number, warm: number): number {
  let l = (lum * LUM_LEVELS) | 0;
  if (l < 0) l = 0;
  else if (l >= LUM_LEVELS) l = LUM_LEVELS - 1;
  let w = Math.round(warm * (WARM_LEVELS - 1));
  if (w < 0) w = 0;
  else if (w >= WARM_LEVELS) w = WARM_LEVELS - 1;
  return w * LUM_LEVELS + l;
}

/** Cool white/grey for snow, blending toward ember-red -> orange -> warm white. */
function colorRGB(li: number, wi: number): [number, number, number] {
  const l = (li + 0.5) / LUM_LEVELS;
  const w = wi / (WARM_LEVELS - 1);
  const g = 14 + 241 * Math.pow(l, 0.95);
  const gray = [g * 0.93, g * 0.96, g];
  let warm: number[];
  if (l < 0.45) {
    const k = l / 0.45;
    warm = [70 + 185 * k, 18 + 112 * k, 8 + 20 * k];
  } else if (l < 0.8) {
    const k = (l - 0.45) / 0.35;
    warm = [255, 130 + 90 * k, 28 + 72 * k];
  } else {
    const k = (l - 0.8) / 0.2;
    warm = [255, 220 + 30 * k, 100 + 130 * k];
  }
  return [
    gray[0] + (warm[0] - gray[0]) * w,
    gray[1] + (warm[1] - gray[1]) * w,
    gray[2] + (warm[2] - gray[2]) * w,
  ];
}

/** One tile per (character, colour): columns = characters, rows = colours. */
export function buildAtlas(cellW: number, cellH: number, fontPx: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CHARS.length * cellW;
  canvas.height = COLOR_COUNT * cellH;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.font = `${fontPx}px ${FONT_FAMILY}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let w = 0; w < WARM_LEVELS; w++) {
    for (let l = 0; l < LUM_LEVELS; l++) {
      const [r, gg, b] = colorRGB(l, w);
      g.fillStyle = `rgb(${r | 0},${gg | 0},${b | 0})`;
      const y = (w * LUM_LEVELS + l) * cellH + cellH / 2 + fontPx * 0.04;
      for (let k = 1; k < CHARS.length; k++) {
        g.fillText(CHARS[k], k * cellW + cellW / 2, y);
      }
    }
  }
  return canvas;
}
