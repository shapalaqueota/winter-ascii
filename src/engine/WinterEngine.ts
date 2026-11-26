/**
 * WinterEngine — a real-time 3D scene rendered entirely as ASCII on a canvas.
 *
 * Pipeline, every frame:
 *   1. update simulation (camera drift, wind, flicker, snow / sparks / smoke)
 *   2. raycast every cell against the ground plane or the sky
 *   3. project & rasterise procedural pines, depth-tested per cell
 *   4. draw the campfire (flame tongues, logs, stone ring, embers)
 *   5. project 3D snow particles, depth-tested against the geometry
 *   6. quantise (lum, warmth) to the palette and blit glyphs from an atlas
 *
 * The engine knows nothing about React; it is driven through setSettings().
 */
import { hash2, mulberry32, valueNoise } from './random';
import {
  FLAME, FONT_FAMILY, RAMP, SNOW_RAMP, TREE_DARK, TREE_SNOW,
  buildAtlas, ci, colorIndex, rampIdx,
} from './glyphs';

export interface Settings {
  speed: number;       // animation speed multiplier
  wind: number;        // base wind strength (signed)
  snow: number;        // snowfall intensity multiplier
  glow: number;        // firelight intensity multiplier
  paused: boolean;
  mouseCamera: boolean;
}

export interface Stats {
  fps: number;
  flakes: number;
  cols: number;
  rows: number;
}

interface Tree {
  x: number; z: number; h: number; r: number;
  tiers: number; seed: number; phase: number;
}

interface Spark { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number }
interface Smoke { x: number; y: number; z: number; vy: number; life: number; max: number; ph: number }
interface Star { az: number; el: number; ph: number; sp: number }

// ------------------------------------------------------------------ world
const FIRE_X = 0;
const FIRE_Z = 6.2;
const FLAME_H = 1.15;            // tallest flame, world units
const CAM_H = 1.65;
const FOV_Y = 0.95;              // vertical field of view, radians
const FOG_LUM = 0.15;             // distant geometry fades toward this grey
const MAX_FLAKES = 14000;

const SKY = 0, GROUND = 1, TREE = 2, FIRE = 3;

const R_RAMP = rampIdx(RAMP);
const R_GROUND = rampIdx(SNOW_RAMP);
const R_DARK = rampIdx(TREE_DARK);
const R_SNOW = rampIdx(TREE_SNOW);
const R_FLAME = rampIdx(FLAME);
const N_RAMP = R_RAMP.length;
const C = {
  slash: ci('/'), back: ci('\\'), pipe: ci('|'), H: ci('H'), A: ci('A'),
  o: ci('o'), O: ci('O'), zero: ci('0'), at: ci('@'), eq: ci('='), lp: ci('('), rp: ci(')'),
  dot: ci('.'), comma: ci(','), colon: ci(':'), quote: ci("'"), star: ci('*'), plus: ci('+'),
  tilde: ci('~'), mid: ci('·'), deg: ci('°'), spark4: ci('✦'), flake: ci('❄'), hash: ci('#'),
};
const EMBER_CHARS = [C.dot, C.comma, C.colon, C.o, C.star];

// flame tongues: x offset, relative height, half-width, speed, phase (world units)
const TONGUES: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0.0, 1.0, 0.2, 1.0, 0.0],
  [-0.16, 0.8, 0.15, 1.3, 1.7],
  [0.17, 0.78, 0.15, 1.2, 3.1],
  [-0.32, 0.5, 0.11, 1.7, 4.4],
  [0.34, 0.48, 0.11, 1.6, 0.9],
  [-0.07, 0.92, 0.12, 1.9, 2.4],
  [0.09, 0.88, 0.12, 2.1, 5.2],
];

function makeForest(): Tree[] {
  const rnd = mulberry32(122424);
  const trees: Tree[] = [];
  let tries = 0;
  while (trees.length < 1100 && tries++ < 30000) {
    const z = 5 + Math.pow(rnd(), 0.75) * 140;
    const h = 6 + rnd() * 8 + (rnd() < 0.15 ? 5 : 0);
    const r = h * (0.22 + rnd() * 0.08);
    const side = rnd() < 0.5 ? -1 : 1;
    const corridor = 2.0 + z * 0.08;                  // open clearing down the middle
    const x = side * (corridor + r * 0.85 + Math.pow(rnd(), 1.4) * (6 + z * 0.8));
    const dxF = x - FIRE_X;
    const dzF = z - FIRE_Z;
    if (dxF * dxF + dzF * dzF < (r + 3.5) ** 2) continue;
    trees.push({
      x, z, h, r,
      tiers: 5 + Math.floor(rnd() * 4),
      seed: Math.floor(rnd() * 100000),
      phase: rnd(),
    });
  }
  return trees.sort((a, b) => a.z - b.z);              // near first: early depth rejects
}

function makeStars(): Star[] {
  const rnd = mulberry32(7);
  const stars: Star[] = [];
  for (let i = 0; i < 500; i++) {
    stars.push({
      az: (rnd() * 2 - 1) * 1.3,
      el: 0.02 + Math.pow(rnd(), 0.7) * 0.7,
      ph: rnd() * Math.PI * 2,
      sp: 0.3 + rnd() * 1.6,
    });
  }
  return stars;
}

export class WinterEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private settings: Settings;
  private readonly onStats: (s: Stats) => void;

  // grid
  private atlas: HTMLCanvasElement | null = null;
  private atlasKey = '';
  private cellW = 8;
  private cellH = 14;
  private cols = 0;
  private rows = 0;
  private chars = new Uint8Array(0);
  private lum = new Float32Array(0);
  private warm = new Float32Array(0);
  private depth = new Float32Array(0);
  private kind = new Uint8Array(0);

  // camera
  private cx = 0; private cy = 0; private fRows = 1; private fCols = 1;
  private camX = 0; private camY = CAM_H; private camZ = 0;
  private cosY = 1; private sinY = 0; private cosP = 1; private sinP = 0;
  private yawMouse = 0; private pitchMouse = 0;
  private yawTarget = 0; private pitchTarget = 0;
  private px = 0; private py = 0; private pz = 0;     // last projection result

  // simulation
  private time = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  private fps = 60;
  private statsTimer = 0;
  private windNow = 0;
  private lightPower = 1;
  private haloX = 0; private haloY = 0; private haloRX = 1; private haloRY = 1;

  private readonly trees = makeForest();
  private readonly stars = makeStars();
  private readonly rnd = mulberry32(2024);
  private readonly fx = new Float32Array(MAX_FLAKES);
  private readonly fy = new Float32Array(MAX_FLAKES);
  private readonly fz = new Float32Array(MAX_FLAKES);
  private readonly fv = new Float32Array(MAX_FLAKES);
  private readonly fp = new Float32Array(MAX_FLAKES);
  private activeFlakes = 0;
  private sparks: Spark[] = [];
  private smoke: Smoke[] = [];
  private sparkAcc = 0;
  private smokeAcc = 0;

  constructor(canvas: HTMLCanvasElement, settings: Settings, onStats: (s: Stats) => void) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.settings = { ...settings };
    this.onStats = onStats;
    for (let i = 0; i < MAX_FLAKES; i++) this.spawnFlake(i, false);
  }

  // ------------------------------------------------------------ lifecycle
  start(): void {
    this.resize();
    window.addEventListener('resize', this.resize);
    window.addEventListener('pointermove', this.onPointer);
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('pointermove', this.onPointer);
  }

  setSettings(s: Partial<Settings>): void {
    this.settings = { ...this.settings, ...s };
  }

  private onPointer = (e: PointerEvent): void => {
    const mx = e.clientX / window.innerWidth;
    const my = e.clientY / window.innerHeight;
    this.yawTarget = (mx - 0.5) * 0.5;
    this.pitchTarget = (0.5 - my) * 0.16;
  };

  private resize = (): void => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fontPx = Math.max(8, Math.min(13, Math.round(vw / 165))) * dpr;
    this.ctx.font = `${fontPx}px ${FONT_FAMILY}`;
    const cellW = Math.max(2, Math.round(this.ctx.measureText('M').width));
    const cellH = Math.max(4, Math.round(fontPx * 1.16));
    const cols = Math.max(20, Math.floor((vw * dpr) / cellW));
    const rows = Math.max(10, Math.floor((vh * dpr) / cellH));

    this.canvas.width = cols * cellW;
    this.canvas.height = rows * cellH;
    this.canvas.style.width = `${this.canvas.width / dpr}px`;
    this.canvas.style.height = `${this.canvas.height / dpr}px`;

    if (cols !== this.cols || rows !== this.rows) {
      const n = cols * rows;
      this.chars = new Uint8Array(n);
      this.lum = new Float32Array(n);
      this.warm = new Float32Array(n);
      this.depth = new Float32Array(n);
      this.kind = new Uint8Array(n);
    }
    const key = `${cellW}x${cellH}@${fontPx}`;
    if (key !== this.atlasKey) {
      this.atlas = buildAtlas(cellW, cellH, fontPx);
      this.atlasKey = key;
    }
    this.cellW = cellW;
    this.cellH = cellH;
    this.cols = cols;
    this.rows = rows;
    this.cx = cols / 2;
    this.cy = rows / 2;
    this.fRows = rows / 2 / Math.tan(FOV_Y / 2);
    this.fCols = this.fRows * (cellH / cellW);       // cells are taller than wide
    if (!this.running) return;
    this.render();
  };

  private loop = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const realDt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (realDt > 0) this.fps = this.fps * 0.93 + (1 / realDt) * 0.07;
    const dt = this.settings.paused ? 0 : realDt * this.settings.speed;
    this.update(dt, realDt);
    this.render();
    this.statsTimer += realDt;
    if (this.statsTimer > 0.25) {
      this.statsTimer = 0;
      this.onStats({ fps: this.fps, flakes: this.activeFlakes, cols: this.cols, rows: this.rows });
    }
  };

  // ----------------------------------------------------------- simulation
  private update(dt: number, realDt: number): void {
    const s = this.settings;
    this.time += dt;
    const t = this.time;

    this.windNow = s.wind * (0.75 + 0.25 * Math.sin(t * 0.13)) + 0.12 * Math.sin(t * 0.37);
    const flick = 0.84 + 0.07 * Math.sin(t * 6.1) + 0.05 * Math.sin(t * 10.7 + 1.3)
      + 0.1 * (valueNoise(t * 3.1, 7.7) - 0.5);
    this.lightPower = s.glow * flick;

    // camera: slow drift + smoothed mouse look
    const k = 1 - Math.exp(-realDt * 2.5);
    const yt = s.mouseCamera ? this.yawTarget : 0;
    const pt = s.mouseCamera ? this.pitchTarget : 0;
    this.yawMouse += (yt - this.yawMouse) * k;
    this.pitchMouse += (pt - this.pitchMouse) * k;
    const yaw = 0.04 * Math.sin(t * 0.045) + this.yawMouse;
    const pitch = -0.075 + 0.012 * Math.sin(t * 0.061) + this.pitchMouse;
    this.cosY = Math.cos(yaw); this.sinY = Math.sin(yaw);
    this.cosP = Math.cos(pitch); this.sinP = Math.sin(pitch);
    this.camX = 0.35 * Math.sin(t * 0.05);
    this.camY = CAM_H + 0.05 * Math.sin(t * 0.09);
    this.camZ = 0.4 * Math.sin(t * 0.031);

    this.updateSnow(dt);
    this.updateFireParticles(dt);
  }

  private spawnFlake(i: number, top: boolean): void {
    const r = this.rnd;
    const z = this.camZ + 0.6 + Math.pow(r(), 1.5) * 65;
    this.fz[i] = z;
    this.fx[i] = this.camX + (r() * 2 - 1) * (3 + (z - this.camZ) * 1.1);
    this.fy[i] = top ? 13 + r() * 3 : r() * 16;
    this.fv[i] = 0.55 + r() * 0.65;
    this.fp[i] = r() * Math.PI * 2;
  }

  private updateSnow(dt: number): void {
    const want = Math.min(MAX_FLAKES, Math.floor((this.cols * this.rows / 9) * this.settings.snow));
    for (let i = this.activeFlakes; i < want; i++) this.spawnFlake(i, false);
    this.activeFlakes = want;
    const t = this.time;
    const wind = this.windNow;
    for (let i = 0; i < want; i++) {
      this.fy[i] -= this.fv[i] * dt;
      this.fx[i] += (wind * 1.5 + 0.3 * Math.sin(t * 0.8 + this.fp[i])) * dt;
      this.fz[i] += 0.12 * Math.sin(t * 0.5 + this.fp[i] * 2) * dt;
      if (this.fy[i] < 0) {
        this.spawnFlake(i, true);
        continue;
      }
      const half = 3 + (this.fz[i] - this.camZ) * 1.1;
      const dx = this.fx[i] - this.camX;
      if (dx > half) this.fx[i] -= 2 * half;
      else if (dx < -half) this.fx[i] += 2 * half;
    }
  }

  private updateFireParticles(dt: number): void {
    const r = this.rnd;
    const wind = this.windNow;
    this.sparkAcc += dt * 5 * Math.max(0.3, this.settings.glow);
    while (this.sparkAcc >= 1) {
      this.sparkAcc -= 1;
      const life = 1 + r() * 1.6;
      this.sparks.push({
        x: FIRE_X + (r() - 0.5) * 0.3, y: 0.35 + r() * 0.4, z: FIRE_Z + (r() - 0.5) * 0.3,
        vx: (r() - 0.5) * 0.35, vy: 0.8 + r() * 0.9, vz: (r() - 0.5) * 0.35, life, max: life,
      });
    }
    for (const p of this.sparks) {
      p.x += (p.vx + wind * 0.45 + 0.25 * Math.sin(this.time * 5 + p.max * 9)) * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vy *= 1 - 0.5 * dt;
      p.life -= dt;
    }
    this.sparks = this.sparks.filter((p) => p.life > 0);

    this.smokeAcc += dt * 2.2;
    while (this.smokeAcc >= 1) {
      this.smokeAcc -= 1;
      const life = 5 + r() * 4;
      this.smoke.push({
        x: FIRE_X + (r() - 0.5) * 0.2, y: FLAME_H * 0.95, z: FIRE_Z + (r() - 0.5) * 0.2,
        vy: 0.3 + r() * 0.25, life, max: life, ph: r() * 6.28,
      });
    }
    for (const p of this.smoke) {
      const age = p.max - p.life;
      p.x += (wind * 0.4 * Math.min(1, age / 2) + 0.12 * Math.sin(age * 1.1 + p.ph)) * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.smoke = this.smoke.filter((p) => p.life > 0);
  }

  // ------------------------------------------------------------- helpers
  /** World -> camera space; result in px/py/pz. Returns false if behind camera. */
  private project(x: number, y: number, z: number): boolean {
    const X = x - this.camX;
    const Y = y - this.camY;
    const Z = z - this.camZ;
    const x1 = X * this.cosY - Z * this.sinY;
    const z1 = X * this.sinY + Z * this.cosY;
    this.px = x1;
    this.py = Y * this.cosP - z1 * this.sinP;
    this.pz = Y * this.sinP + z1 * this.cosP;
    return this.pz > 0.05;
  }

  /** Firelight reaching a world point. */
  private lightAt(x: number, y: number, z: number): number {
    const dx = x - FIRE_X;
    const dy = y - 0.45;
    const dz = z - FIRE_Z;
    const L = (this.lightPower * 1.5) / (1 + (dx * dx + dy * dy + dz * dz) * 0.7) - 0.02;
    return L > 0 ? L : 0;
  }

  /** Screen-space volumetric glow around the fire. */
  private halo(col: number, row: number): number {
    const hx = (col - this.haloX) / this.haloRX;
    const hy = (row - this.haloY) / this.haloRY;
    const h = (this.lightPower * 0.1) / (1 + hx * hx + hy * hy) - 0.008;
    return h > 0 ? h : 0;
  }

  private put(i: number, ch: number, lum: number, warm: number, depth: number, kind: number): void {
    this.chars[i] = ch;
    this.lum[i] = lum > 1 ? 1 : lum;
    this.warm[i] = warm > 1 ? 1 : warm;
    this.depth[i] = depth;
    this.kind[i] = kind;
  }

  private rampChar(lum: number, jitter: number): number {
    let k = ((lum + jitter) * N_RAMP) | 0;
    if (k < 0) k = 0;
    else if (k >= N_RAMP) k = N_RAMP - 1;
    return R_RAMP[k];
  }

  // ------------------------------------------------------------ rendering
  private render(): void {
    if (!this.atlas || this.cols === 0) return;
    // the fire's on-screen position drives the volumetric halo
    if (this.project(FIRE_X, FLAME_H * 0.4, FIRE_Z)) {
      this.haloX = this.cx + (this.px / this.pz) * this.fCols;
      this.haloY = this.cy - (this.py / this.pz) * this.fRows;
      this.haloRX = (1.4 * this.fCols) / this.pz;
      this.haloRY = (1.0 * this.fRows) / this.pz;
    }
    this.drawBackground();
    this.drawStars();
    for (const tr of this.trees) this.drawTree(tr);
    this.drawCampfire();
    this.drawFireParticles();
    this.drawSnow();
    this.blit();
  }

  private drawBackground(): void {
    const { cols, rows, cx, cy, fCols, fRows, cosP, sinP, cosY, sinY, camX, camY, camZ } = this;
    const t = this.time;
    const glitterTick = Math.floor(t * 1.5) * 131;
    for (let row = 0; row < rows; row++) {
      const yc = (cy - row - 0.5) / fRows;
      const Yr = yc * cosP + sinP;            // ray direction, world Y (row-constant)
      const z1 = -yc * sinP + cosP;
      for (let col = 0, i = row * cols; col < cols; col++, i++) {
        const xc = (col + 0.5 - cx) / fCols;
        const X = xc * cosY + z1 * sinY;
        const Z = -xc * sinY + z1 * cosY;
        const h = this.halo(col, row);
        if (Yr < -0.002) {
          // ground plane hit; for a ray with camera-z = 1, the hit distance is camera depth
          const d = camY / -Yr;
          const gx = camX + X * d;
          const gz = camZ + Z * d;
          const n = valueNoise(gx * 0.5, gz * 0.5);
          const n2 = valueNoise(gx * 2.1 + 31, gz * 2.1 + 7);
          let l = 0.15 + 0.17 * n + 0.08 * n2 + 0.035 * Math.sin(gx * 1.1 + gz * 0.35 + n * 5);
          const dxF = gx - FIRE_X;
          const dzF = gz - FIRE_Z;
          const dF2 = dxF * dxF + dzF * dzF;
          if (dF2 < 2.6) l *= 0.15 + (0.85 * dF2) / 2.6;          // melted ring of dark ground
          if (d < 25 && hash2(col, row + glitterTick) > 0.997) l += 0.5;  // snow glitter
          let L = (this.lightPower * 1.5) / (1 + (dF2 + 0.2) * 0.7) - 0.02;
          if (L < 0) L = 0;
          const fog = 1 - Math.exp(-d / 50);
          l = l * (1 - fog) + FOG_LUM * fog;
          const add = L * 0.6 + h * 0.3;
          l += add;
          const warm = (add * 1.7) / (l + 0.02);
          let gk = ((l + (hash2(col, row) - 0.5) * 0.09) * R_GROUND.length) | 0;
          if (gk < 0) gk = 0;
          else if (gk >= R_GROUND.length) gk = R_GROUND.length - 1;
          this.put(i, R_GROUND[gk], l, warm, d, GROUND);
        } else {
          const elev = Yr / Math.sqrt(X * X + Yr * Yr + Z * Z);
          const l = 0.012 + 0.1 * Math.exp(-elev * 16) + h * 0.5;
          this.put(i, this.rampChar(l, 0), l, (h * 0.5 * 1.7) / (l + 0.02), 1e9, SKY);
        }
      }
    }
  }

  private drawStars(): void {
    const { cols, rows, cx, cy, fCols, fRows, cosP, sinP, cosY, sinY } = this;
    for (const s of this.stars) {
      const ce = Math.cos(s.el);
      const x = ce * Math.sin(s.az);
      const y = Math.sin(s.el);
      const z = ce * Math.cos(s.az);
      const x1 = x * cosY - z * sinY;
      const z1 = x * sinY + z * cosY;
      const y2 = y * cosP - z1 * sinP;
      const z2 = y * sinP + z1 * cosP;
      if (z2 <= 0.05) continue;
      const col = Math.floor(cx + (x1 / z2) * fCols);
      const row = Math.floor(cy - (y2 / z2) * fRows);
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
      const i = row * cols + col;
      if (this.kind[i] !== SKY) continue;
      const tw = Math.sin(this.time * s.sp + s.ph);
      if (tw < -0.3) continue;
      const ch = tw > 0.85 ? C.star : tw > 0.3 ? C.plus : C.mid;
      this.put(i, ch, 0.3 + 0.45 * tw, 0, 1e9, SKY);
    }
  }

  private drawTree(tr: Tree): void {
    if (!this.project(tr.x, 0, tr.z) || this.pz < 0.4) return;
    const { cols, rows } = this;
    const depth = this.pz;
    const sR = this.fRows / depth;
    const sC = this.fCols / depth;
    const baseCol = this.cx + this.px * sC;
    const baseRow = this.cy - this.py * sR;
    const halfW = tr.r * sC;
    if (baseCol + halfW * 1.3 < 0 || baseCol - halfW * 1.3 > cols) return;
    const topRow = baseRow - tr.h * sR;
    if (topRow >= rows || baseRow < 0) return;

    const trunkTop = baseRow - tr.h * 0.12 * sR;
    const fog = 1 - Math.exp(-depth / 60);
    const far = sR < 0.9;                               // too small for individual needles
    const t0 = this.time;
    const sway = (this.windNow * 0.16 + 0.09 * Math.sin(t0 * (0.6 + tr.phase * 0.5) + tr.seed))
      * (0.6 + Math.min(1.5, Math.abs(this.windNow)) * 0.3);
    const r0 = Math.max(0, Math.floor(topRow));
    const r1 = Math.min(rows - 1, Math.floor(baseRow));

    for (let row = r0; row <= r1; row++) {
      if (row > trunkTop) {
        const tw = Math.max(0.5, tr.r * 0.08 * sC);
        const c0 = Math.max(0, Math.round(baseCol - tw));
        const c1 = Math.min(cols - 1, Math.round(baseCol + tw));
        for (let col = c0; col <= c1; col++) {
          const i = row * cols + col;
          if (this.depth[i] <= depth) continue;
          const L = this.lightAt(tr.x, 0.5, tr.z);
          const l = (0.1 + L * 0.4) * (1 - fog) + FOG_LUM * fog * 0.6;
          this.put(i, tw > 1.5 && col !== c0 && col !== c1 ? C.H : C.pipe, l, (L * 1.2) / (l + 0.1), depth, TREE);
        }
        continue;
      }
      const t = (row - topRow) / Math.max(0.001, trunkTop - topRow);   // 0 tip -> 1 bottom
      const tt = t * tr.tiers + tr.phase;
      const f = tt - Math.floor(tt);                                    // position inside a tier
      const prof = (0.04 + 0.96 * t) * (0.58 + 0.42 * f);
      const jag = (hash2(row * 7 + tr.seed, Math.floor(tt)) - 0.5) * 0.14;
      const hw = Math.max(0.5, (prof + jag) * halfW);
      const cRow = baseCol + sway * (1 - t) * (1 - t) * sC;
      const c0 = Math.max(0, Math.ceil(cRow - hw));
      const c1 = Math.min(cols - 1, Math.floor(cRow + hw));
      const wy = tr.h * (0.12 + 0.88 * (1 - t));
      for (let col = c0; col <= c1; col++) {
        const i = row * cols + col;
        if (this.depth[i] <= depth) continue;
        const u = (col - cRow) / hw;
        const au = u < 0 ? -u : u;
        const n = valueNoise(u * 2.6 * tr.r + tr.seed * 0.13, tt * 2.4);
        const snow = f * 0.75 + n * 0.6 - au * 0.08 + (u < 0 ? -u * 0.12 : 0);
        const isSnow = snow > 0.7;
        const L = this.lightAt(tr.x + u * tr.r * prof, wy, tr.z);
        let l: number;
        let ch: number;
        if (hw < 1.2 && row === r0) {
          l = 0.55; ch = C.A;                                     // the tip
        } else if (au > 0.86) {
          l = f > 0.4 ? 0.75 : 0.38;                               // rim of each tier
          ch = u < 0 ? C.slash : C.back;
        } else if (isSnow) {
          l = 0.55 + 0.45 * n;
          ch = R_SNOW[Math.min(R_SNOW.length - 1, (l * R_SNOW.length * (0.8 + 0.3 * hash2(col, row))) | 0)];
        } else {
          l = 0.13 + 0.16 * n;
          ch = R_DARK[Math.min(R_DARK.length - 1, (n * R_DARK.length) | 0)];
        }
        l = l * (1 - fog) + FOG_LUM * fog;
        const add = L * (isSnow ? 0.9 : 0.5) + this.halo(col, row) * 0.3;
        l += add;
        if (far) ch = this.rampChar(l, 0);
        this.put(i, ch, l, (add * 1.7) / (l + 0.02), depth, TREE);
      }
    }
  }

  private drawCampfire(): void {
    if (!this.project(FIRE_X, 0, FIRE_Z)) return;
    const { cols, rows } = this;
    const depth = this.pz;
    const sR = this.fRows / depth;
    const sC = this.fCols / depth;
    const bc = this.cx + this.px * sC;
    const br = this.cy - this.py * sR;
    const t = this.time;
    const tick = Math.floor(t * 9);

    // stone ring (depth testing sorts back and front stones around the flames)
    for (let n = 0; n < 16; n++) {
      const a = (n / 16) * Math.PI * 2 + 0.2;
      const sx = FIRE_X + Math.cos(a) * 0.62;
      const sz = FIRE_Z + Math.sin(a) * 0.62;
      if (!this.project(sx, 0.06, sz)) continue;
      const scol = this.cx + (this.px / this.pz) * this.fCols;
      const srow = Math.floor(this.cy - (this.py / this.pz) * this.fRows);
      const w = Math.max(0, Math.round((0.07 * this.fCols) / this.pz));
      const L = this.lightAt(sx, 0.2, sz);
      const lit = Math.sin(a) > 0 ? 1 : 0.55;               // the far stones face the fire
      for (let dc = -w; dc <= w; dc++) {
        const col = Math.floor(scol) + dc;
        if (col < 0 || col >= cols || srow < 0 || srow >= rows) continue;
        const i = srow * cols + col;
        if (this.depth[i] <= this.pz) continue;
        const ch = w === 0 ? [C.o, C.O, C.zero][n % 3] : dc === -w ? C.lp : dc === w ? C.rp : C.O;
        const l = 0.22 + L * 0.55 * lit;
        this.put(i, ch, l, (L * 1.2 * lit) / (l + 0.1), this.pz, FIRE);
      }
    }

    // logs: three branches lying across the fire bed
    for (let k = 0; k < 3; k++) {
      const a = k * 2.1 + 0.4;
      const steps = 30;
      for (let s = 0; s <= steps; s++) {
        const q = s / steps;
        const lx = FIRE_X + Math.cos(a) * (0.05 + 0.5 * q);
        const lz = FIRE_Z + Math.sin(a) * (0.05 + 0.5 * q);
        if (!this.project(lx, 0.09, lz)) continue;
        const col = Math.floor(this.cx + (this.px / this.pz) * this.fCols);
        const row = Math.floor(this.cy - (this.py / this.pz) * this.fRows);
        if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
        const i = row * cols + col;
        if (this.depth[i] <= this.pz) continue;
        const glow = q < 0.45 && hash2(col * 3, tick + col) > 0.45;
        if (glow) {
          const e = hash2(col, tick);
          this.put(i, EMBER_CHARS[(e * EMBER_CHARS.length) | 0], 0.35 + 0.4 * e, 1, this.pz, FIRE);
        } else {
          this.put(i, q > 0.92 ? C.O : C.eq, 0.2 + 0.25 * (1 - q), 0.75, this.pz, FIRE);
        }
      }
    }

    // flame tongues: white-hot core -> yellow -> orange -> red tips
    const tongues = TONGUES.map(([dx, h0, w0, sp, ph]) => {
      const h = h0 * FLAME_H * (0.8 + 0.14 * Math.sin(t * sp * 1.4 + ph) + 0.07 * Math.sin(t * sp * 6.5 + ph * 2));
      return [dx, h, w0, sp, ph] as const;
    });
    const lean = Math.max(-1.5, Math.min(1.5, this.windNow)) * 0.06;
    const rTop = Math.max(0, Math.floor(br - FLAME_H * 1.15 * sR));
    const rBot = Math.min(rows - 1, Math.floor(br));
    const cL = Math.max(0, Math.floor(bc - 0.6 * sC));
    const cR = Math.min(cols - 1, Math.ceil(bc + 0.6 * sC));
    const fDepth = depth - 0.01;
    for (let row = rTop; row <= rBot; row++) {
      const up = (br - row - 0.5) / sR;
      if (up < 0) continue;
      for (let col = cL; col <= cR; col++) {
        const x = (col + 0.5 - bc) / sC;
        let v = 0;
        for (const [dx, h, w, sp, ph] of tongues) {
          if (up >= h) continue;
          const kk = up / h;
          const sw = (0.07 * Math.sin(t * sp * 1.1 + ph + kk * 2.2) + lean) * kk * kk;
          const width = w * Math.pow(1 - kk, 0.6) + 0.035;
          const d = Math.abs(x - dx - sw) / width;
          if (d < 1) {
            const val = (1 - d * d) * (1 - 0.4 * kk);
            if (val > v) v = val;
          }
        }
        if (v <= 0) continue;
        v += (hash2(col * 7 + tick, row) - 0.5) * 0.1;
        if (v < 0.05) continue;
        const i = row * cols + col;
        if (this.depth[i] <= fDepth) continue;
        const ch = R_FLAME[Math.min(R_FLAME.length - 1, (v * R_FLAME.length) | 0)];
        this.put(i, ch, 0.28 + 0.72 * v, v > 0.88 ? 0.35 : 1, fDepth, FIRE);
      }
    }

    // glowing coals right at the base
    const coalW = Math.max(1, Math.round(0.3 * sC));
    const coalRow = Math.floor(br);
    if (coalRow >= 0 && coalRow < rows) {
      for (let col = Math.floor(bc) - coalW; col <= Math.floor(bc) + coalW; col++) {
        if (col < 0 || col >= cols) continue;
        const i = coalRow * cols + col;
        if (this.kind[i] === FIRE) continue;
        const e = hash2(col, Math.floor(t * 4));
        this.put(i, EMBER_CHARS[(e * EMBER_CHARS.length) | 0], 0.3 + 0.5 * e, 1, fDepth, FIRE);
      }
    }
  }

  private drawFireParticles(): void {
    const { cols, rows } = this;
    for (const p of this.smoke) {
      if (!this.project(p.x, p.y, p.z)) continue;
      const col = Math.floor(this.cx + (this.px / this.pz) * this.fCols);
      const row = Math.floor(this.cy - (this.py / this.pz) * this.fRows);
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
      const i = row * cols + col;
      if (this.depth[i] <= this.pz || this.kind[i] === FIRE) continue;
      const f = 1 - p.life / p.max;
      const ch = f < 0.25 ? (Math.floor(p.ph * 10) % 2 ? C.lp : C.rp) : f < 0.6 ? C.tilde : C.dot;
      const L = this.lightAt(p.x, p.y, p.z);
      const l = 0.08 + 0.3 * (1 - f) + L * 0.2;
      this.put(i, ch, l, (L * 0.8) / (l + 0.1), this.pz, TREE);
    }
    for (const p of this.sparks) {
      if (!this.project(p.x, p.y, p.z)) continue;
      const col = Math.floor(this.cx + (this.px / this.pz) * this.fCols);
      const row = Math.floor(this.cy - (this.py / this.pz) * this.fRows);
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
      const i = row * cols + col;
      if (this.depth[i] <= this.pz) continue;
      const f = p.life / p.max;
      const ch = f > 0.6 ? C.star : f > 0.3 ? C.quote : C.dot;
      this.put(i, ch, 0.35 + 0.6 * f, 1, this.pz, FIRE);
    }
  }

  private drawSnow(): void {
    const { cols, rows, cx, cy, fCols, fRows } = this;
    for (let k = 0; k < this.activeFlakes; k++) {
      if (!this.project(this.fx[k], this.fy[k], this.fz[k])) continue;
      const z = this.pz;
      if (z < 0.35) continue;
      const col = Math.floor(cx + (this.px / z) * fCols);
      const row = Math.floor(cy - (this.py / z) * fRows);
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
      const i = row * cols + col;
      if (this.depth[i] <= z || this.kind[i] === FIRE) continue;   // hidden, or melts in the flames
      const v = this.fp[k];
      let ch: number;
      if (z < 2.5) ch = C.flake;
      else if (z < 5) ch = v > 3 ? C.spark4 : C.star;
      else if (z < 11) ch = v > 2 ? C.star : C.plus;
      else if (z < 22) ch = v > 3.5 ? C.deg : C.plus;
      else if (z < 40) ch = C.mid;
      else ch = C.dot;
      const fog = 1 - Math.exp(-z / 45);
      const L = this.lightAt(this.fx[k], this.fy[k], this.fz[k]);
      const l = (1 - Math.min(0.5, z / 90)) * (1 - fog * 0.6) + L * 0.4;
      this.put(i, ch, l, (L * 1.1) / (l + 0.1), z, this.kind[i]);
    }
  }

  private blit(): void {
    const { ctx, cols, rows, cellW: cw, cellH: chh } = this;
    const atlas = this.atlas!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const chars = this.chars;
    const lum = this.lum;
    const warm = this.warm;
    let i = 0;
    for (let row = 0; row < rows; row++) {
      const y = row * chh;
      for (let col = 0; col < cols; col++, i++) {
        const c = chars[i];
        if (c === 0) continue;
        const l = lum[i];
        if (l < 0.015) continue;
        ctx.drawImage(atlas, c * cw, colorIndex(l, warm[i]) * chh, cw, chh, col * cw, y, cw, chh);
      }
    }
  }
}
