import type { Landmark, PoseFrame } from '../types';
import { OneEuro, type OneEuroParams } from './oneEuro';

/**
 * Raw MediaPipe frames -> a stable body in body units. Everything downstream works in these units,
 * so camera distance, body size and image aspect ratio don't matter.
 *
 * Steps per frame:
 *  1. drop repeated frames (same camera frame seen twice)
 *  2. undo the aspect stretch (image x and y are normalized separately)
 *  3. fix left/right swaps (MediaPipe sometimes trades the two wrists, knees or ankles)
 *  4. reject one-frame teleports, hold low-confidence points briefly
 *  5. One Euro filter every coordinate (image x/y, and world z much more heavily: it's noisy)
 *  6. express points relative to the hips, scaled by torso length, y up, z toward the camera
 */

export const LM = {
  nose: 0, lEar: 7, rEar: 8,
  lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16,
  lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
} as const;

/** Left/right landmark pairs checked for swaps, grouped by limb so a whole limb swaps together. */
const SWAP_GROUPS: [number, number][][] = [
  [[13, 14], [15, 16], [17, 18], [19, 20], [21, 22]], // elbows, wrists, hands
  [[25, 26], [27, 28], [29, 30], [31, 32]], // knees, ankles, feet
];
/** Hands and feet move fast; everything else is filtered as "core". */
const EXTREMITIES = new Set([15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32]);

export type PreprocessConfig = {
  core: OneEuroParams;
  extremity: OneEuroParams;
  depth: OneEuroParams;
  /** Light smoothing used only for velocities, so motion onsets aren't delayed by the main filter. */
  fast: OneEuroParams;
  /** Below this visibility a point is ignored and held. */
  minVisibility: number;
  /** How long a lost point is held before it counts as missing (ms). */
  holdMs: number;
  /** One-frame moves faster than this (torso lengths per second) are treated as glitches. */
  maxSpeed: number;
  /** Time constant for the slow "home" calibration (seconds). */
  homeSeconds: number;
};

export const DEFAULT_PREPROCESS: PreprocessConfig = {
  core: { minCutoff: 1.0, beta: 0.6, dCutoff: 1.0 },
  extremity: { minCutoff: 1.6, beta: 1.2, dCutoff: 1.0 },
  depth: { minCutoff: 0.6, beta: 0.2, dCutoff: 1.0 },
  fast: { minCutoff: 5, beta: 0.5, dCutoff: 1.0 },
  minVisibility: 0.2,
  holdMs: 200,
  maxSpeed: 40,
  homeSeconds: 2.5,
};

export type Vec3 = { x: number; y: number; z: number };
export type BodyPoint = {
  /** Body units: x to the image right, y up, z toward the camera; origin at the hip center. */
  p: Vec3;
  /** Velocity in body units per second, relative to the hips (from the smooth positions). */
  v: Vec3;
  /** Same, from lightly filtered positions: noisier, but reacts a frame or two sooner. Use it for onsets. */
  vf: Vec3;
  /** Confident this frame (visible, not held, not a glitch). */
  ok: boolean;
  visibility: number;
};
export type Body = {
  t: number;
  dt: number; // seconds since the previous processed frame
  points: BodyPoint[]; // 33, indexed like MediaPipe
  /** Hip center relative to its slow-moving home, in body units (y up). Jumps and ducks show up here. */
  root: { x: number; y: number; vx: number; vy: number };
  /** Current torso size / home torso size. Above 1 = closer to the camera than usual. */
  scale: number;
  /** Whether hips are visible (full-body framing) or the body unit falls back to shoulder width. */
  fullBody: boolean;
  /**
   * Elbow angles in degrees (180 = straight) from MediaPipe's 3D world landmarks, and how fast they open.
   * A straight punch at the camera barely moves the wrist in the image, but the elbow still straightens.
   */
  elbow: { L: number; R: number; vL: number; vR: number };
};

type Raw = { x: number; y: number; z: number; visibility: number };

export class PosePreprocessor {
  private config: PreprocessConfig;
  private readonly filters: { x: OneEuro; y: OneEuro; z: OneEuro }[];
  private readonly fastFilters: { x: OneEuro; y: OneEuro; z: OneEuro }[];
  private prevFast: Vec3[] | null = null;
  private readonly elbowFilters = { L: new OneEuro({ minCutoff: 3, beta: 0.05, dCutoff: 1 }), R: new OneEuro({ minCutoff: 3, beta: 0.05, dCutoff: 1 }) };
  private lastT = -Infinity;
  private lastRawKey = '';
  private prev: Body | null = null;
  private prevRaw: Raw[] | null = null;
  private lastGood: number[] = new Array(33).fill(-Infinity);
  private unitHome = 0;
  private worldUnitHome = 0;
  private home: { x: number; y: number } | null = null;

  constructor(config: PreprocessConfig = DEFAULT_PREPROCESS) {
    this.config = config;
    this.filters = Array.from({ length: 33 }, (_, i) => {
      const xy = EXTREMITIES.has(i) ? config.extremity : config.core;
      return { x: new OneEuro({ ...xy }), y: new OneEuro({ ...xy }), z: new OneEuro({ ...config.depth }) };
    });
    this.fastFilters = Array.from({ length: 33 }, () => ({ x: new OneEuro({ ...config.fast }), y: new OneEuro({ ...config.fast }), z: new OneEuro({ ...config.fast }) }));
  }

  /** Live tuning: swap in new parameters without losing state. */
  setConfig(config: PreprocessConfig) {
    this.config = config;
    this.filters.forEach((f, i) => {
      const xy = EXTREMITIES.has(i) ? config.extremity : config.core;
      f.x.params = { ...xy };
      f.y.params = { ...xy };
      f.z.params = { ...config.depth };
    });
    this.fastFilters.forEach((f) => (f.x.params = { ...config.fast }, f.y.params = { ...config.fast }, f.z.params = { ...config.fast }));
  }

  reset() {
    this.filters.forEach((f) => (f.x.reset(), f.y.reset(), f.z.reset()));
    this.fastFilters.forEach((f) => (f.x.reset(), f.y.reset(), f.z.reset()));
    this.elbowFilters.L.reset();
    this.elbowFilters.R.reset();
    this.prevFast = null;
    this.lastT = -Infinity;
    this.lastRawKey = '';
    this.prev = null;
    this.prevRaw = null;
    this.lastGood.fill(-Infinity);
    this.unitHome = 0;
    this.worldUnitHome = 0;
    this.home = null;
  }

  /** Returns null for repeated or unusable frames; callers keep the previous Body. */
  process(frame: PoseFrame): Body | null {
    if (frame.t <= this.lastT || frame.image.length < 33 || frame.world.length < 33) return null;
    // Same pixels twice (camera slower than the render loop): identical landmarks, new timestamp.
    const key = rawKey(frame.image);
    if (key === this.lastRawKey) return null;
    // After a long gap (player lost, tab hidden), start fresh instead of filtering across it.
    if (this.prev && frame.t - this.lastT > 300) this.reset();
    this.lastRawKey = key;
    const dt = this.prev ? (frame.t - this.lastT) / 1000 : 0;
    this.lastT = frame.t;

    const aspect = frame.aspect ?? 4 / 3;
    let raw: Raw[] = frame.image.map((p, i) => ({
      x: p.x * aspect,
      y: p.y,
      z: frame.world[i].z,
      visibility: p.visibility,
    }));
    raw = this.fixSwaps(raw);

    const { minVisibility, holdMs, maxSpeed } = this.config;
    const unitGuess = this.unitHome || bodyUnit(raw).size;
    const filtered: Raw[] = raw.map((point, i) => {
      const f = this.filters[i];
      const px = f.x.value;
      const py = f.y.value;
      const visible = point.visibility >= minVisibility;
      // A move this fast in one frame is a tracking glitch, not a punch.
      const glitch = px !== null && py !== null && dt > 0
        && Math.hypot(point.x - px, point.y - py) / unitGuess / dt > maxSpeed;
      if (visible && !glitch) {
        this.lastGood[i] = frame.t;
        return { x: f.x.filter(point.x, dt), y: f.y.filter(point.y, dt), z: f.z.filter(point.z, dt), visibility: point.visibility };
      }
      if (px === null || py === null) {
        return { x: f.x.filter(point.x, dt), y: f.y.filter(point.y, dt), z: f.z.filter(point.z, dt), visibility: 0 };
      }
      // Hold the last good value while it's missing.
      return { x: px, y: py, z: f.z.value ?? point.z, visibility: frame.t - this.lastGood[i] <= holdMs ? point.visibility : 0 };
    });

    // Body unit: torso length (shoulder center to hip center). Falls back to shoulder width when hips are off-screen.
    const unit = bodyUnit(filtered);
    const worldUnit = bodyUnit(frame.world).size;
    const k = dt > 0 ? 1 - Math.exp(-dt / this.config.homeSeconds) : 1;
    this.unitHome = this.unitHome ? this.unitHome + k * (unit.size - this.unitHome) : unit.size;
    this.worldUnitHome = this.worldUnitHome ? this.worldUnitHome + k * (worldUnit - this.worldUnitHome) : worldUnit;

    const hip = unit.center;
    this.home = this.home ? { x: this.home.x + k * (hip.x - this.home.x), y: this.home.y + k * (hip.y - this.home.y) } : { ...hip };

    const U = this.unitHome;
    const WU = this.worldUnitHome || 0.5;
    const points: BodyPoint[] = filtered.map((point, i) => {
      const p = { x: (point.x - hip.x) / U, y: (hip.y - point.y) / U, z: -point.z / WU };
      const before = this.prev?.points[i].p;
      const v = before && dt > 0
        ? { x: (p.x - before.x) / dt, y: (p.y - before.y) / dt, z: (p.z - before.z) / dt }
        : { x: 0, y: 0, z: 0 };
      return { p, v, vf: { x: 0, y: 0, z: 0 }, ok: point.visibility >= 0.5 && this.lastGood[i] === frame.t, visibility: point.visibility };
    });

    // Fast channel: same transform, lighter filtering, used only for velocities.
    const fast: Vec3[] = raw.map((point, i) => {
      const f = this.fastFilters[i];
      const ok = this.lastGood[i] === frame.t;
      const x = ok ? f.x.filter(point.x, dt) : (f.x.value ?? point.x);
      const y = ok ? f.y.filter(point.y, dt) : (f.y.value ?? point.y);
      const z = ok ? f.z.filter(point.z, dt) : (f.z.value ?? point.z);
      return { x: (x - hip.x) / U, y: (hip.y - y) / U, z: -z / WU };
    });
    if (this.prevFast && dt > 0) {
      points.forEach((pt, i) => {
        const a = this.prevFast![i];
        pt.vf = { x: (fast[i].x - a.x) / dt, y: (fast[i].y - a.y) / dt, z: (fast[i].z - a.z) / dt };
      });
    }
    this.prevFast = fast;

    const elbowOf = (side: 'L' | 'R') => {
      const [s, e, w] = side === 'L' ? [LM.lShoulder, LM.lElbow, LM.lWrist] : [LM.rShoulder, LM.rElbow, LM.rWrist];
      return this.elbowFilters[side].filter(angle3(frame.world[s], frame.world[e], frame.world[w]), dt);
    };
    const prevElbow = this.prev?.elbow;
    const L = elbowOf('L');
    const R = elbowOf('R');
    const elbow = {
      L, R,
      vL: prevElbow && dt > 0 ? (L - prevElbow.L) / dt : 0,
      vR: prevElbow && dt > 0 ? (R - prevElbow.R) / dt : 0,
    };

    const rootX = (hip.x - this.home.x) / U;
    const rootY = (this.home.y - hip.y) / U;
    const root = {
      x: rootX,
      y: rootY,
      vx: this.prev && dt > 0 ? (rootX - this.prev.root.x) / dt : 0,
      vy: this.prev && dt > 0 ? (rootY - this.prev.root.y) / dt : 0,
    };

    const body: Body = { t: frame.t, dt, points, root, scale: unit.size / U, fullBody: unit.fullBody, elbow };
    this.prev = body;
    this.prevRaw = raw;
    return body;
  }

  /** If swapping a left/right group brings it much closer to last frame, MediaPipe swapped it. */
  private fixSwaps(raw: Raw[]): Raw[] {
    const last = this.prevRaw;
    if (!last) return raw;
    const out = raw.slice();
    for (const group of SWAP_GROUPS) {
      let straight = 0;
      let crossed = 0;
      for (const [l, r] of group) {
        straight += dist(raw[l], last[l]) + dist(raw[r], last[r]);
        crossed += dist(raw[l], last[r]) + dist(raw[r], last[l]);
      }
      if (crossed < straight * 0.4) for (const [l, r] of group) [out[l], out[r]] = [raw[r], raw[l]];
    }
    return out;
  }
}

function bodyUnit(points: { x: number; y: number; visibility: number }[]) {
  const ls = points[LM.lShoulder];
  const rs = points[LM.rShoulder];
  const lh = points[LM.lHip];
  const rh = points[LM.rHip];
  const shoulders = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hipsVisible = lh.visibility > 0.5 && rh.visibility > 0.5;
  if (hipsVisible) {
    const center = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
    return { size: Math.max(1e-4, Math.hypot(shoulders.x - center.x, shoulders.y - center.y)), center, fullBody: true };
  }
  // Upper-body framing: a torso is roughly 1.4 shoulder widths; put the "hips" that far below the shoulders.
  const size = Math.max(1e-4, Math.hypot(ls.x - rs.x, ls.y - rs.y) * 1.4);
  return { size, center: { x: shoulders.x, y: shoulders.y + size }, fullBody: false };
}

/** Angle at b (degrees) between b->a and b->c, in 3D. */
function angle3(a: Landmark, b: Landmark, c: Landmark) {
  const u = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const d = Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z) || 1;
  return (Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y + u.z * v.z) / d))) * 180) / Math.PI;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function rawKey(points: Landmark[]) {
  const a = points[LM.lWrist];
  const b = points[LM.rWrist];
  const c = points[LM.nose];
  return `${a.x},${a.y},${b.x},${b.y},${c.x},${c.y}`;
}
