/**
 * WinterEngine — a real-time 3D scene rendered entirely as ASCII on a canvas.
 *
 * The camera is a first-person walker: WASD / arrows to move, Shift to run,
 * click to capture the mouse and look around. The forest is generated from a
 * seeded grid around the player, so it continues endlessly in every direction.
 *
 * Pipeline, every frame:
 *   1. update simulation (player, wind, flicker, snow / sparks / smoke)
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
}

export interface Stats {
  fps: number;
  flakes: number;
  cols: number;
  rows: number;
  locked: boolean;     // mouse captured for look-around
  game: GameState;
}

export interface GameState {
  fuel: number;        // 0..100, how much the fire has left to burn
  carried: number;     // sticks in hand
  maxCarry: number;
  survived: number;    // seconds the fire has been kept alive
  nearFire: boolean;   // close enough to feed it
  over: boolean;       // the fire went out
  message: string;     // short-lived notice ("+1 stick", ...)
  hp: number;          // 0..100
  ammo: number;
  mag: number;
  reloading: boolean;
  kills: number;
  hurt: number;        // 0..1, red screen flash after being hit
  overReason: 'fire' | 'killed' | '';
}

interface Zombie {
  x: number; z: number; hp: number; speed: number; seed: number;
  phase: number;       // walk cycle
  cd: number;          // attack cooldown
  hitFlash: number;
  dying: boolean; deathT: number;
}

interface Bit { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; blood: boolean }

interface Stick { x: number; z: number; a: number; key: number }

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
const CELL = 3.4;                // forest grid spacing, one tree max per cell
const VIEW_R = 95;               // trees further than this are not drawn
const SNOW_R = 32;               // snow volume half-size around the player
const WALK = 3.2;                // walking speed, units per second
const LOOK = 0.0022;             // mouse sensitivity, radians per pixel
const JUMP_V = 4.3;              // take-off speed, units per second
const FUEL_START = 55;
const FUEL_MAX = 100;
const FUEL_BURN = 0.8;           // fuel per second
const FUEL_PER_STICK = 15;
const MAX_CARRY = 5;
const STICK_CELL = 7;            // stick grid spacing
const STICK_VIEW = 45;           // sticks further than this are not drawn
const FEED_DIST = 2.6;           // how close to the fire you must be to feed it
const HP_MAX = 100;
const MAG = 8;                   // rounds per magazine
const RELOAD_TIME = 1.5;
const FIRE_DELAY = 0.24;         // seconds between shots
const ZOMBIE_HIT = 18;           // damage per claw
const ZOMBIE_H = 1.85;           // zombie height, world units

// first-person pistol, seen from behind; the muzzle is the top of the front sight
const GUN = [
  '         _         ',
  '        |=|        ',
  '   _____|=|_____   ',
  '  |  [___=___]  |  ',
  '  |_____________|  ',
  '     |  | |  |     ',
  '    /   | |   \\    ',
  '   /  __| |__  \\   ',
  '  /  /       \\  \\  ',
];
const GUN_MUZZLE = 9;            // column of the muzzle in the art
const GRAVITY = 11;              // units per second squared

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
  tilde: ci('~'), minus: ci('-'), x: ci('x'), mid: ci('·'), deg: ci('°'), spark4: ci('✦'), flake: ci('❄'), hash: ci('#'),
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

/** The tree in forest-grid cell (i, j), or null. Pure function of the cell. */
function treeAt(i: number, j: number): Tree | null {
  if (hash2(i * 3 + 11, j * 7 + 5) > 0.55) return null;
  const x = (i + 0.15 + 0.7 * hash2(i, j + 913)) * CELL;
  const z = (j + 0.15 + 0.7 * hash2(i + 377, j)) * CELL;
  const h = 6 + hash2(i + 51, j + 77) * 8 + (hash2(i + 9, j + 3) < 0.15 ? 5 : 0);
  const r = h * (0.22 + hash2(i + 17, j + 29) * 0.08);
  const dxF = x - FIRE_X;
  const dzF = z - FIRE_Z;
  if (dxF * dxF + dzF * dzF < (r + 3.5) ** 2) return null;          // clearing round the fire
  if (z > -14 && z < 150 && Math.abs(x) - r * 0.85 < 2 + Math.max(0, z) * 0.08) return null; // the long glade
  return {
    x, z, h, r,
    tiers: 5 + Math.floor(hash2(i + 3, j + 8) * 4),
    seed: Math.floor(hash2(i + 101, j + 202) * 100000),
    phase: hash2(i + 55, j + 66),
  };
}

/** The stick lying in stick-grid cell (i, j), or null. Never inside a tree or by the fire. */
function stickAt(i: number, j: number): Stick | null {
  if (hash2(i * 13 + 7, j * 17 + 3) > 0.42) return null;
  const x = (i + 0.1 + 0.8 * hash2(i + 71, j + 19)) * STICK_CELL;
  const z = (j + 0.1 + 0.8 * hash2(i + 23, j + 97)) * STICK_CELL;
  if ((x - FIRE_X) ** 2 + (z - FIRE_Z) ** 2 < 9 * 9) return null;  // you have to go and look
  const ti = Math.floor(x / CELL);
  const tj = Math.floor(z / CELL);
  for (let a = ti - 1; a <= ti + 1; a++) {
    for (let b = tj - 1; b <= tj + 1; b++) {
      const tr = treeAt(a, b);
      if (tr && (x - tr.x) ** 2 + (z - tr.z) ** 2 < (tr.r * 0.35 + 0.6) ** 2) return null;
    }
  }
  return { x, z, a: hash2(i + 5, j + 41) * Math.PI, key: (i + 100000) * 200003 + (j + 100000) };
}

function makeStars(): Star[] {
  const rnd = mulberry32(7);
  const stars: Star[] = [];
  for (let i = 0; i < 1100; i++) {
    stars.push({
      az: rnd() * Math.PI * 2,
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

  // player
  private posX = 0; private posZ = 0;
  private velX = 0; private velZ = 0;
  private yaw = 0; private pitchLook = 0;
  private bob = 0;
  private jumpY = 0;             // height of the feet above the snow
  private jumpV = 0;
  private jumpQueued = false;
  private landDip = 0;           // brief camera squash after landing

  // survival game
  private fuel = FUEL_START;
  private fireLevel = FUEL_START / FUEL_MAX;   // smoothed fuel, drives the visuals
  private flare = 0;                           // burst after feeding the fire
  private carried = 0;
  private survived = 0;
  private over = false;
  private message = '';
  private messageTime = 0;
  private readonly collected = new Set<number>();
  private sticks: Stick[] = [];

  // combat
  private hp = HP_MAX;
  private ammo = MAG;
  private reloadT = 0;
  private shotCd = 0;
  private muzzle = 0;            // muzzle-flash brightness, also lights the scene
  private kick = 0;              // recoil
  private hitMark = 0;
  private hurt = 0;
  private kills = 0;
  private overReason: 'fire' | 'killed' | '' = '';
  private zombies: Zombie[] = [];
  private bits: Bit[] = [];      // blood and snow puffs from bullet hits
  private spawnIn = 9;
  private locked = false;
  private readonly keys = new Set<string>();
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
  private haloOn = true;

  private readonly treeCache = new Map<number, Tree | null>();
  private visible: Array<{ tr: Tree; d: number }> = [];
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
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('pointerlockchange', this.onLockChange);
    this.canvas.addEventListener('click', this.onClick);
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.canvas.removeEventListener('click', this.onClick);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  setSettings(s: Partial<Settings>): void {
    this.settings = { ...this.settings, ...s };
  }

  // ---------------------------------------------------------------- input
  private onClick = (): void => {
    if (document.pointerLockElement !== this.canvas) {
      void Promise.resolve(this.canvas.requestPointerLock()).catch(() => {});
    }
  };

  private onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (this.locked && e.button === 0) this.shoot();
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.yaw += e.movementX * LOOK;
    this.pitchLook = Math.max(-0.7, Math.min(0.6, this.pitchLook - e.movementY * LOOK));
  };

  // e.code is the physical key, so WASD works on any keyboard layout
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    this.keys.add(e.code);
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) this.jumpQueued = true;          // one jump per press, not auto-repeat
    }
    if (e.code.startsWith('Arrow')) e.preventDefault();
    if (e.code === 'KeyE' && !e.repeat) this.feedFire();
    if (e.code === 'KeyR' && !e.repeat) {
      if (this.over) this.restart();
      else this.reload();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
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
    if (this.statsTimer > 0.1) {
      this.statsTimer = 0;
      this.onStats({
        fps: this.fps, flakes: this.activeFlakes, cols: this.cols, rows: this.rows, locked: this.locked,
        game: {
          fuel: this.fuel, carried: this.carried, maxCarry: MAX_CARRY, survived: this.survived,
          nearFire: this.distToFire() < FEED_DIST, over: this.over,
          message: this.time - this.messageTime < 1.6 ? this.message : '',
          hp: this.hp, ammo: this.ammo, mag: MAG, reloading: this.reloadT > 0,
          kills: this.kills, hurt: this.hurt, overReason: this.overReason,
        },
      });
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
    this.updateGame(dt);
    // the fire's strength drives its light: a dying fire barely lights the snow
    this.lightPower = s.glow * flick * (0.08 + 1.0 * this.fireLevel + 0.35 * this.flare);

    this.updatePlayer(realDt);
    this.updateCombat(dt, realDt);

    this.updateSnow(dt);
    this.updateFireParticles(dt);
  }

  private updatePlayer(dt: number): void {
    const k = this.keys;
    const has = (...codes: string[]) => codes.some((c) => k.has(c));
    // arrow keys can also turn, for playing without a mouse
    this.yaw += ((has('ArrowRight') ? 1 : 0) - (has('ArrowLeft') ? 1 : 0)) * 1.8 * dt;
    const fwd = (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0);
    const side = (has('KeyD') ? 1 : 0) - (has('KeyA') ? 1 : 0);
    const run = has('ShiftLeft', 'ShiftRight') ? 2.1 : 1;
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const len = Math.hypot(fwd, side) || 1;
    const tx = ((sy * fwd + cy * side) / len) * WALK * run;
    const tz = ((cy * fwd - sy * side) / len) * WALK * run;
    const a = 1 - Math.exp(-dt * 9);                    // ease in / out of motion
    this.velX += (tx - this.velX) * a;
    this.velZ += (tz - this.velZ) * a;
    this.collide(this.posX + this.velX * dt, this.posZ + this.velZ * dt);

    // jumping: a simple ballistic arc, only from the ground
    const grounded = this.jumpY <= 0;
    if (this.jumpQueued && grounded) this.jumpV = JUMP_V;
    this.jumpQueued = false;
    if (!grounded || this.jumpV > 0) {
      this.jumpV -= GRAVITY * dt;
      this.jumpY += this.jumpV * dt;
      if (this.jumpY <= 0) {                              // landed
        this.landDip = Math.min(0.14, -this.jumpV * 0.03);
        this.jumpY = 0;
        this.jumpV = 0;
      }
    }
    this.landDip *= Math.exp(-dt * 9);

    const speed = Math.hypot(this.velX, this.velZ);
    if (this.jumpY <= 0) this.bob += speed * dt * 2.3;   // no footstep bob in the air
    const pitch = -0.075 + this.pitchLook;
    this.cosY = cy; this.sinY = sy;
    this.cosP = Math.cos(pitch); this.sinP = Math.sin(pitch);
    this.camX = this.posX;
    this.camZ = this.posZ;
    this.camY = CAM_H + this.jumpY - this.landDip
      + Math.sin(this.bob) * 0.05 * Math.min(1, speed / WALK)
      + 0.012 * Math.sin(this.time * 0.9);              // slow breathing when standing still
  }

  /** Move to (x, z), pushed out of tree trunks and the fire. */
  private collide(x: number, z: number): void {
    const i0 = Math.floor(x / CELL);
    const j0 = Math.floor(z / CELL);
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        const tr = this.treeCached(i, j);
        if (tr) [x, z] = pushOut(x, z, tr.x, tr.z, tr.r * 0.35 + 0.3);
      }
    }
    [x, z] = pushOut(x, z, FIRE_X, FIRE_Z, 1.0);
    this.posX = x;
    this.posZ = z;
  }

  private treeCached(i: number, j: number): Tree | null {
    const key = (i + 100000) * 200003 + (j + 100000);
    let tr = this.treeCache.get(key);
    if (tr === undefined) {
      if (this.treeCache.size > 60000) this.treeCache.clear();
      tr = treeAt(i, j);
      this.treeCache.set(key, tr);
    }
    return tr;
  }

  /** Trees around the player that can be in view, sorted near to far. */
  private gatherTrees(): void {
    const vis = this.visible;
    vis.length = 0;
    const { camX, camZ, sinY, cosY } = this;
    const i0 = Math.floor((camX - VIEW_R) / CELL);
    const i1 = Math.floor((camX + VIEW_R) / CELL);
    const j0 = Math.floor((camZ - VIEW_R) / CELL);
    const j1 = Math.floor((camZ + VIEW_R) / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const tr = this.treeCached(i, j);
        if (!tr) continue;
        const dx = tr.x - camX;
        const dz = tr.z - camZ;
        if (dx * dx + dz * dz > VIEW_R * VIEW_R) continue;
        const d = dx * sinY + dz * cosY;                  // distance along the view direction
        if (d < -tr.r) continue;                          // behind the player
        vis.push({ tr, d });
      }
    }
    vis.sort((a, b) => a.d - b.d);
  }

  private spawnFlake(i: number, top: boolean): void {
    const r = this.rnd;
    this.fx[i] = this.camX + (r() * 2 - 1) * SNOW_R;
    this.fz[i] = this.camZ + (r() * 2 - 1) * SNOW_R;
    this.fy[i] = top ? 13 + r() * 3 : r() * 16;
    this.fv[i] = 0.55 + r() * 0.65;
    this.fp[i] = r() * Math.PI * 2;
  }

  private updateSnow(dt: number): void {
    const want = Math.min(MAX_FLAKES, Math.floor((this.cols * this.rows / 3.5) * this.settings.snow));
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
      // keep the snow volume centred on the player as they walk
      const dx = this.fx[i] - this.camX;
      if (dx > SNOW_R) this.fx[i] -= 2 * SNOW_R;
      else if (dx < -SNOW_R) this.fx[i] += 2 * SNOW_R;
      const dz = this.fz[i] - this.camZ;
      if (dz > SNOW_R) this.fz[i] -= 2 * SNOW_R;
      else if (dz < -SNOW_R) this.fz[i] += 2 * SNOW_R;
    }
  }

  private updateFireParticles(dt: number): void {
    const r = this.rnd;
    const wind = this.windNow;
    this.sparkAcc += dt * 5 * Math.max(0.3, this.settings.glow) * (this.fireLevel + this.flare * 3);
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
    let L = (this.lightPower * 1.5) / (1 + (dx * dx + dy * dy + dz * dz) * 0.7) - 0.02;
    if (L < 0) L = 0;
    if (this.muzzle > 0.01) {
      const mx = x - this.camX;
      const my = y - this.camY;
      const mz = z - this.camZ;
      L += (this.muzzle * 2.2) / (1 + (mx * mx + my * my + mz * mz) * 0.3);
    }
    return L;
  }

  /** Screen-space volumetric glow around the fire. */
  private halo(col: number, row: number): number {
    if (!this.haloOn) return 0;
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

  /** HUD-style drawing (gun, crosshair): changes the picture but not the depth buffer,
   *  so it never blocks the bullet ray or hides the world from the hit test. */
  private overlay(i: number, ch: number, lum: number, warm: number): void {
    this.chars[i] = ch;
    this.lum[i] = lum > 1 ? 1 : lum;
    this.warm[i] = warm > 1 ? 1 : warm;
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
    this.haloOn = this.project(FIRE_X, FLAME_H * 0.4, FIRE_Z) && this.pz > 0.3;
    if (this.haloOn) {
      this.haloX = this.cx + (this.px / this.pz) * this.fCols;
      this.haloY = this.cy - (this.py / this.pz) * this.fRows;
      this.haloRX = (1.4 * this.fCols) / this.pz;
      this.haloRY = (1.0 * this.fRows) / this.pz;
    }
    this.drawBackground();
    this.drawStars();
    this.gatherTrees();
    for (const v of this.visible) this.drawTree(v.tr);
    this.drawSticks();
    this.drawCampfire();
    this.drawFireParticles();
    this.drawZombies();
    this.drawBits();
    this.drawSnow();
    this.drawGun();
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
          if (this.muzzle > 0.01) {
            const mx = gx - camX;
            const mz = gz - camZ;
            L += (this.muzzle * 2.2) / (1 + (mx * mx + mz * mz + camY * camY) * 0.3);
          }
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
      const h = h0 * FLAME_H * this.flameScale()
        * (0.8 + 0.14 * Math.sin(t * sp * 1.4 + ph) + 0.07 * Math.sin(t * sp * 6.5 + ph * 2));
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
        const glowE = this.over ? 0.12 + 0.18 * e : 0.3 + 0.5 * e;   // dull coals once it's out
        this.put(i, EMBER_CHARS[(e * EMBER_CHARS.length) | 0], glowE, 1, fDepth, FIRE);
      }
    }
  }

  // ---------------------------------------------------------- survival game
  private distToFire(): number {
    return Math.hypot(this.posX - FIRE_X, this.posZ - FIRE_Z);
  }

  private flameScale(): number {
    if (this.over) return 0;
    return 0.2 + 0.85 * this.fireLevel + 0.45 * this.flare;
  }

  private say(msg: string): void {
    this.message = msg;
    this.messageTime = this.time;
  }

  private updateGame(dt: number): void {
    if (!this.over) {
      this.fuel = Math.max(0, this.fuel - FUEL_BURN * dt);
      this.survived += dt;
      if (this.fuel <= 0) {
        this.over = true;
        this.overReason = 'fire';
        this.say('');
      }
    }
    const target = this.over ? 0 : this.fuel / FUEL_MAX;
    this.fireLevel += (target - this.fireLevel) * (1 - Math.exp(-dt * 1.5));
    this.flare *= Math.exp(-dt * 1.2);

    // gather the sticks around the player; walking over one picks it up
    this.sticks.length = 0;
    const i0 = Math.floor((this.posX - STICK_VIEW) / STICK_CELL);
    const i1 = Math.floor((this.posX + STICK_VIEW) / STICK_CELL);
    const j0 = Math.floor((this.posZ - STICK_VIEW) / STICK_CELL);
    const j1 = Math.floor((this.posZ + STICK_VIEW) / STICK_CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const st = stickAt(i, j);
        if (!st || this.collected.has(st.key)) continue;
        const d = Math.hypot(st.x - this.posX, st.z - this.posZ);
        if (d < 1.2 && this.jumpY < 0.5 && !this.over) {
          if (this.carried < MAX_CARRY) {
            this.collected.add(st.key);
            this.carried++;
            this.say(this.carried === MAX_CARRY ? 'hands full — bring them to the fire' : '+1 stick');
            continue;
          }
          this.say('hands full — bring them to the fire');
        }
        if (d < STICK_VIEW) this.sticks.push(st);
      }
    }
  }

  private feedFire(): void {
    if (this.over || this.carried === 0 || this.distToFire() > FEED_DIST) return;
    const n = this.carried;
    this.fuel = Math.min(FUEL_MAX, this.fuel + n * FUEL_PER_STICK);
    this.carried = 0;
    this.flare = Math.min(1.2, this.flare + 0.25 * n);
    this.sparkAcc += 6 * n;                                 // a shower of sparks
    this.say(n === 1 ? 'the fire takes the stick' : `the fire takes ${n} sticks`);
  }

  private restart(): void {
    this.fuel = FUEL_START;
    this.fireLevel = 0.15;
    this.flare = 0.8;
    this.carried = 0;
    this.survived = 0;
    this.over = false;
    this.collected.clear();
    this.hp = HP_MAX;
    this.ammo = MAG;
    this.reloadT = 0;
    this.kills = 0;
    this.hurt = 0;
    this.zombies = [];
    this.bits = [];
    this.spawnIn = 9;
    this.overReason = '';
    this.say('the fire is lit again');
  }

  // ------------------------------------------------------------------ combat
  private updateCombat(dt: number, realDt: number): void {
    this.shotCd -= realDt;
    this.muzzle *= Math.exp(-realDt * 22);
    this.kick *= Math.exp(-realDt * 9);
    this.hitMark = Math.max(0, this.hitMark - realDt * 4);
    this.hurt *= Math.exp(-realDt * 2.2);
    if (this.reloadT > 0) {
      this.reloadT -= realDt;
      if (this.reloadT <= 0) {
        this.reloadT = 0;
        this.ammo = MAG;
      }
    }
    if (dt === 0) return;                                  // paused

    // spawn: more often, and more of them, the longer you last
    if (!this.over) {
      this.spawnIn -= dt;
      const alive = this.zombies.filter((z) => !z.dying).length;
      const maxAlive = Math.min(14, 3 + Math.floor(this.survived / 30));
      if (this.spawnIn <= 0 && alive < maxAlive) {
        this.spawnZombie();
        this.spawnIn = Math.max(2.5, 9 - this.survived * 0.04) * (0.7 + this.rnd() * 0.6);
      }
    }

    // zombies will not step into the firelight; a strong fire keeps a wide safe circle
    const safeR = this.overReason === 'fire' ? 0 : 2.4 + 7 * this.fireLevel;
    for (const z of this.zombies) {
      z.hitFlash = Math.max(0, z.hitFlash - dt * 6);
      if (z.dying) {
        z.deathT += dt;
        continue;
      }
      const dx = this.posX - z.x;
      const dz = this.posZ - z.z;
      const d = Math.hypot(dx, dz);
      z.phase += dt * z.speed * 3.3;
      if (d > 0.85) {
        const wob = Math.sin(this.time * 0.8 + z.seed) * 0.4;   // shambling, not a straight line
        const c = Math.cos(wob);
        const sn = Math.sin(wob);
        const ux = dx / d;
        const uz = dz / d;
        let nx = z.x + (ux * c - uz * sn) * z.speed * dt;
        let nz = z.z + (ux * sn + uz * c) * z.speed * dt;
        const i0 = Math.floor(nx / CELL);
        const j0 = Math.floor(nz / CELL);
        for (let i = i0 - 1; i <= i0 + 1; i++) {
          for (let j = j0 - 1; j <= j0 + 1; j++) {
            const tr = this.treeCached(i, j);
            if (tr) [nx, nz] = pushOut(nx, nz, tr.x, tr.z, tr.r * 0.35 + 0.3);
          }
        }
        if (safeR > 0) [nx, nz] = pushOut(nx, nz, FIRE_X, FIRE_Z, safeR);
        z.x = nx;
        z.z = nz;
      }
      z.cd -= dt;
      if (d < 1.05 && z.cd <= 0 && !this.over && this.jumpY < 0.9) {
        z.cd = 1.1;
        this.hp = Math.max(0, this.hp - ZOMBIE_HIT);
        this.hurt = 1;
        if (this.hp <= 0) {
          this.over = true;
          this.overReason = 'killed';
        } else {
          this.say('you are hit!');
        }
      }
    }
    // keep zombies apart a little so they don't stack into one figure
    for (let a = 0; a < this.zombies.length; a++) {
      for (let b = a + 1; b < this.zombies.length; b++) {
        const za = this.zombies[a];
        const zb = this.zombies[b];
        if (za.dying || zb.dying) continue;
        const dx = zb.x - za.x;
        const dz = zb.z - za.z;
        const d = Math.hypot(dx, dz);
        if (d > 0 && d < 0.8) {
          const push = (0.8 - d) / 2;
          za.x -= (dx / d) * push; za.z -= (dz / d) * push;
          zb.x += (dx / d) * push; zb.z += (dz / d) * push;
        }
      }
    }
    this.zombies = this.zombies.filter((z) => !(z.dying && z.deathT > 1.6)
      && Math.hypot(z.x - this.posX, z.z - this.posZ) < 90);

    for (const b of this.bits) {
      b.vy -= 9 * dt;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      if (b.y < 0) { b.y = 0; b.vx *= 0.5; b.vz *= 0.5; b.vy = 0; }
      b.life -= dt;
    }
    this.bits = this.bits.filter((b) => b.life > 0);
  }

  private spawnZombie(): void {
    const r = this.rnd;
    for (let tries = 0; tries < 8; tries++) {
      const a = r() * Math.PI * 2;
      const d = 28 + r() * 14;
      const x = this.posX + Math.cos(a) * d;
      const z = this.posZ + Math.sin(a) * d;
      if (Math.hypot(x - FIRE_X, z - FIRE_Z) < 12) continue;
      const tr = this.treeCached(Math.floor(x / CELL), Math.floor(z / CELL));
      if (tr && Math.hypot(x - tr.x, z - tr.z) < tr.r * 0.35 + 0.5) continue;
      this.zombies.push({
        x, z, hp: 3, speed: 1.05 + r() * 0.55 + Math.min(0.6, this.survived / 400),
        seed: r() * 100, phase: r() * 6, cd: 0, hitFlash: 0, dying: false, deathT: 0,
      });
      return;
    }
  }

  private reload(): void {
    if (this.reloadT > 0 || this.ammo === MAG || this.over) return;
    this.reloadT = RELOAD_TIME;
  }

  /** Hitscan along the view direction; trees and terrain block the shot. */
  private shoot(): void {
    if (this.over || this.settings.paused || this.reloadT > 0 || this.shotCd > 0) return;
    if (this.ammo <= 0) {
      this.reload();
      return;
    }
    this.ammo--;
    this.shotCd = FIRE_DELAY;
    this.muzzle = 1;
    this.kick = 1;

    // whatever is under the crosshair (from the last frame's depth buffer) stops the bullet
    const ci0 = Math.floor(this.cy) * this.cols + Math.floor(this.cx);
    const wall = this.depth[ci0] ?? 1e9;
    let best: Zombie | null = null;
    let bestD = 1e9;
    let bestH = 0;
    for (const z of this.zombies) {
      if (z.dying) continue;
      if (!this.project(z.x, 0, z.z)) continue;
      if (Math.abs(this.px) > 0.36) continue;              // off to the side of the ray
      // height on the zombie where the ray crosses its axis
      const z1 = (this.pz + this.camY * this.sinP) / Math.max(0.2, this.cosP);   // horizontal distance
      const h = this.camY + z1 * this.sinP / Math.max(0.2, this.cosP);
      if (h < 0 || h > ZOMBIE_H) continue;
      if (this.pz > wall + 0.3 || this.pz >= bestD) continue;
      best = z;
      bestD = this.pz;
      bestH = h;
    }
    const dirX = this.cosP * this.sinY;
    const dirY = this.sinP;
    const dirZ = this.cosP * this.cosY;
    if (best) {
      const head = bestH > ZOMBIE_H - 0.38;
      best.hp -= head ? 3 : 1;
      best.hitFlash = 1;
      this.hitMark = 1;
      this.burst(best.x - dirX * 0.3, bestH, best.z - dirZ * 0.3, true, head ? 14 : 7);
      if (best.hp <= 0) {
        best.dying = true;
        this.kills++;
        this.say(head ? 'headshot!' : 'zombie down');
      }
    } else if (wall < 60) {
      // puff of snow where the bullet lands
      const t = wall;                                  // along the view ray, distance == camera depth
      this.burst(this.camX + dirX * t, Math.max(0.05, this.camY + dirY * t), this.camZ + dirZ * t, false, 6);
    }
  }

  private burst(x: number, y: number, z: number, blood: boolean, n: number): void {
    const r = this.rnd;
    for (let k = 0; k < n; k++) {
      this.bits.push({
        x, y, z,
        vx: (r() - 0.5) * 2.4, vy: r() * 2.6, vz: (r() - 0.5) * 2.4,
        life: 0.5 + r() * 0.7, blood,
      });
    }
  }

  private drawZombies(): void {
    const { cols, rows } = this;
    const t = this.time;
    for (const z of this.zombies) {
      if (!this.project(z.x, 0, z.z) || this.pz < 0.5) continue;
      const depth = this.pz;
      const sR = this.fRows / depth;
      const sC = this.fCols / depth;
      const bc = this.cx + this.px * sC;
      const br = this.cy - this.py * sR;
      if (bc + 0.6 * sC < 0 || bc - 0.6 * sC > cols) continue;
      const fall = z.dying ? Math.min(1, z.deathT / 0.9) : 0;  // collapse into the snow
      const sink = fall * fall * ZOMBIE_H * 0.85;
      const fog = 1 - Math.exp(-depth / 55);
      const L = this.lightAt(z.x, 1.0, z.z);
      const step = Math.sin(z.phase);
      const sway = Math.sin(z.phase * 0.5) * 0.04 + fall * 0.25;
      const armSway = Math.sin(t * 2.3 + z.seed) * 0.03;
      const eyeU = Math.max(0.035, 0.55 / sC);
      const eyeV = Math.max(0.03, 0.55 / sR);
      const r0 = Math.max(0, Math.floor(br - ZOMBIE_H * sR) - 1);
      const r1 = Math.min(rows - 1, Math.floor(br));
      const c0 = Math.max(0, Math.floor(bc - 0.6 * sC));
      const c1 = Math.min(cols - 1, Math.ceil(bc + 0.6 * sC));
      for (let row = r0; row <= r1; row++) {
        const v = (br - row - 0.5) / sR + sink;              // height on the body
        for (let col = c0; col <= c1; col++) {
          const i = row * cols + col;
          if (this.depth[i] <= depth) continue;
          const u = (col + 0.5 - bc) / sC - sway * (v / ZOMBIE_H);
          const n = hash2(col * 3 + (z.seed | 0), row * 5);
          let part = 0;                                     // 0 none, 1 head, 2 torso, 3 arm, 4 leg, 5 eye
          if (v > 1.47 && v < 1.79 && (u * u) / 0.0225 + ((v - 1.62) ** 2) / 0.0256 < 1) part = 1;
          if (Math.abs(v - 1.65) < eyeV && Math.abs(Math.abs(u) - 0.055) < eyeU) part = 5;
          else if (!part && v > 0.82 && v < 1.47 && Math.abs(u) < 0.2 - (v < 0.95 ? 0.03 : 0) && n > 0.07) part = 2;
          else if (!part && v > 1.12 && v < 1.42 + armSway && Math.abs(u) > 0.17 && Math.abs(u) < 0.31) part = 3;
          else if (!part && v < 0.84) {
            const lift = Math.max(0, step) * 0.12;
            const liftR = Math.max(0, -step) * 0.12;
            if (Math.abs(u + 0.09 - step * 0.04) < 0.065 && v > lift) part = 4;
            else if (Math.abs(u - 0.09 + step * 0.04) < 0.065 && v > liftR) part = 4;
          }
          if (!part || (part !== 5 && n < 0.04)) continue;  // ragged silhouette
          let ch: number;
          let l: number;
          let w = (L * 1.4) / (0.35 + L);
          if (part === 5) {
            ch = C.star; l = z.dying ? 0.2 : 0.85; w = 1;    // glowing red eyes
          } else if (part === 1) {
            ch = n > 0.5 ? C.at : C.O; l = 0.34 + 0.12 * n;
          } else if (part === 2) {
            ch = R_SNOW[2 + ((n * 6) | 0) % 6]; l = 0.26 + 0.16 * n;
          } else if (part === 3) {
            ch = n > 0.5 ? C.eq : C.minus; l = 0.28 + 0.1 * n;
          } else {
            ch = n > 0.5 ? C.pipe : C.H; l = 0.22 + 0.1 * n;
          }
          l += L * 0.55;
          l = l * (1 - fog) + FOG_LUM * fog;
          if (z.hitFlash > 0 && part !== 5) { l += z.hitFlash * 0.5; w = 0.2; }
          this.put(i, ch, l, w, depth, TREE);
        }
      }
    }
  }

  private drawBits(): void {
    const { cols, rows } = this;
    for (const b of this.bits) {
      if (!this.project(b.x, b.y, b.z)) continue;
      const col = Math.floor(this.cx + (this.px / this.pz) * this.fCols);
      const row = Math.floor(this.cy - (this.py / this.pz) * this.fRows);
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
      const i = row * cols + col;
      if (this.depth[i] <= this.pz) continue;
      const ch = b.y > 0.02 ? C.dot : C.comma;
      if (b.blood) this.put(i, ch === C.dot ? C.star : ch, 0.32, 1, this.pz, TREE);  // dark red
      else this.put(i, ch, 0.8, 0, this.pz, TREE);                                 // snow
    }
  }

  /** First-person gun, recoil, muzzle flash and crosshair, drawn over everything. */
  private drawGun(): void {
    const { cols, rows } = this;
    const sc = Math.max(1, Math.round(cols / 150));         // keep the gun a sensible size
    const artH = GUN.length * sc;
    const artW = GUN[0].length * sc;
    const reloading = this.reloadT > 0 ? Math.sin((1 - this.reloadT / RELOAD_TIME) * Math.PI) : 0;
    const drop = Math.round(this.kick * 1.6 * sc + reloading * artH * 0.9
      + Math.sin(this.bob) * 0.6 * sc * Math.min(1, Math.hypot(this.velX, this.velZ) / WALK));
    const left = Math.floor(cols * 0.6 - artW / 2);
    const top = rows - artH + drop + sc;
    const L = this.lightAt(this.camX, this.camY - 0.35, this.camZ);
    for (let r = 0; r < GUN.length; r++) {
      const line = GUN[r];
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (ch === ' ') continue;
        let l = ch === '=' ? 0.62 : ch === '[' || ch === ']' ? 0.38 : 0.46;
        l += L * 0.35;
        const w = (L * 1.2) / (l + 0.05);
        const glyph = ci(ch);
        for (let dy = 0; dy < sc; dy++) {
          const row = top + r * sc + dy;
          if (row < 0 || row >= rows) continue;
          for (let dx = 0; dx < sc; dx++) {
            const col = left + c * sc + dx;
            if (col < 0 || col >= cols) continue;
            this.overlay(row * cols + col, glyph, l, w);
          }
        }
      }
    }
    // muzzle flash: a short starburst above the front sight
    if (this.muzzle > 0.2) {
      const mc = left + GUN_MUZZLE * sc + (sc >> 1);
      const mr = top - 1;
      const rad = Math.round((1 + 2 * this.muzzle) * sc);
      const rays: Array<[number, number, number]> = [];
      for (let k = 1; k <= rad; k++) {
        rays.push([-k, 0, C.pipe], [0, -k * 2, C.minus], [0, k * 2, C.minus],
          [-k, -k, C.back], [-k, k, C.slash]);
      }
      rays.push([0, 0, C.star]);
      for (const [dr, dc, g] of rays) {
        const row = mr + dr;
        const col = mc + dc;
        if (row >= 0 && row < rows && col >= 0 && col < cols) {
          this.overlay(row * cols + col, g, 0.7 + 0.3 * this.muzzle, 0.6);
        }
      }
    }
    // crosshair (becomes an x on a hit)
    if (this.locked && !this.over) {
      const i = Math.floor(this.cy) * cols + Math.floor(this.cx);
      if (this.hitMark > 0) this.overlay(i, C.x, 1, 0.5);
      else this.overlay(i, C.plus, 0.75, 0);
    }
  }

  private drawSticks(): void {
    const { cols, rows } = this;
    for (const st of this.sticks) {
      const ca = Math.cos(st.a) * 0.38;
      const sa = Math.sin(st.a) * 0.38;
      // project both ends to pick a glyph that follows the stick's on-screen slant
      if (!this.project(st.x - ca, 0.06, st.z - sa)) continue;
      const ax = this.cx + (this.px / this.pz) * this.fCols;
      const ay = this.cy - (this.py / this.pz) * this.fRows;
      if (!this.project(st.x + ca, 0.06, st.z + sa)) continue;
      const bx = this.cx + (this.px / this.pz) * this.fCols;
      const by = this.cy - (this.py / this.pz) * this.fRows;
      const sdx = bx - ax;
      const sdy = by - ay;
      let ch: number;
      if (Math.abs(sdy) < Math.abs(sdx) * 0.35) ch = Math.hypot(sdx, sdy) > 4 ? C.eq : C.minus;
      else ch = sdx * sdy < 0 ? C.slash : C.back;
      const dist = Math.hypot(st.x - this.posX, st.z - this.posZ);
      const near = Math.max(0, 1 - dist / 14);
      const glint = 0.5 + 0.5 * Math.sin(this.time * 2.2 + st.key);   // a slow glint helps find them
      const steps = Math.max(2, Math.ceil(Math.hypot(sdx, sdy)) + 1);
      for (let k = 0; k <= steps; k++) {
        const q = k / steps;
        if (!this.project(st.x - ca + 2 * ca * q, 0.06, st.z - sa + 2 * sa * q)) continue;
        const col = Math.floor(this.cx + (this.px / this.pz) * this.fCols);
        const row = Math.floor(this.cy - (this.py / this.pz) * this.fRows);
        if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
        const i = row * cols + col;
        if (this.depth[i] <= this.pz) continue;
        const L = this.lightAt(st.x, 0.1, st.z);
        const l = 0.42 + 0.3 * near + 0.12 * glint + L * 0.3;
        this.put(i, ch, l, 0.62, this.pz - 0.02, TREE);
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

function pushOut(x: number, z: number, cx: number, cz: number, rad: number): [number, number] {
  const dx = x - cx;
  const dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rad * rad || d2 === 0) return [x, z];
  const d = Math.sqrt(d2);
  return [cx + (dx / d) * rad, cz + (dz / d) * rad];
}
