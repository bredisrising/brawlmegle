import type { Landmark, PoseFrame } from '../types';

/**
 * Scan logic with no DOM: which way the player faces, which bucket a frame belongs in, and how sharp
 * a crop is. src/forge/scan.ts feeds it live camera frames; the tests feed it synthetic poses.
 *
 * Directions are the player's own: `left` is the photo of their left side (left cheek toward the camera).
 * Landmark x is in the unmirrored camera image, the way MediaPipe sees it (the UI mirrors only the preview).
 */

export type Bucket = 'front' | 'left' | 'right';
export const BUCKETS: readonly Bucket[] = ['front', 'left', 'right'];

/** 0 = nothing yet, 1 = a usable frame (sides: a 3/4 view), 2 = a good one (sides: a true profile). */
export type Tier = 0 | 1 | 2;

const NOSE = 0, EAR_L = 7, EAR_R = 8, SHOULDER_L = 11, SHOULDER_R = 12, HIP_L = 23, HIP_R = 24;

export type Facing = {
  /** How far the body has turned from facing the camera, 0–90°, from shoulder width (front and back look alike). */
  yaw: number;
  /** Which side turned toward the camera, from the nose offset (plus depth and ears). 0 when unsure. */
  side: -1 | 0 | 1; // 1 = left side toward camera, -1 = right side
  /** Shoulder width over torso length (aspect-corrected). Shrinks as they turn. */
  width: number;
  /** Nose x minus shoulder-midpoint x, over torso length. Negative when the nose points image-left. */
  nose: number;
  /** Left shoulder is on the image right, as when facing the camera. False usually means a back view. */
  frontal: boolean;
};

export const SCAN_DEFAULTS = {
  /** Shoulder width / torso length when square to the camera, until we measure this player's. */
  frontWidth: 0.7,
  /** Front: turned at most this much, nose near the shoulder midpoint. Tier 2, then tier 1. */
  frontYaw: [15, 25],
  frontNose: [0.07, 0.12],
  /** Sides: a true profile counts as tier 2, a 3/4 view as tier 1. */
  profileYaw: 62,
  threeQuarterYaw: 35,
  /** |nose offset| needed to trust the direction on its own. */
  noseSure: 0.04,
  /** Torso must be at least this tall (fraction of image height) and in frame. */
  minTorso: 0.08,
  minVisibility: 0.5,
  /** Done early once every bucket has this many tier-2 frames to pick the sharpest from. */
  minGood: 3,
  durationMs: 15000,
};
export type ScanOptions = typeof SCAN_DEFAULTS;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const usable = (p: Landmark | undefined, minVis: number) =>
  !!p && p.visibility >= minVis && p.x > -0.05 && p.x < 1.05 && p.y > -0.05 && p.y < 1.05;

/**
 * Facing from one frame. `frontWidth` is this player's shoulder width / torso length when square on.
 * Returns null if the torso isn't trackable (out of frame, too small, low confidence).
 */
export function estimateFacing(frame: PoseFrame, frontWidth = SCAN_DEFAULTS.frontWidth, opts: Partial<ScanOptions> = {}): Facing | null {
  const o = { ...SCAN_DEFAULTS, ...opts };
  const L = frame.image;
  const a = frame.aspect ?? 4 / 3;
  if (![SHOULDER_L, SHOULDER_R, HIP_L, HIP_R].every((i) => usable(L[i], o.minVisibility))) return null;
  const x = (i: number) => L[i].x * a; // same units as y
  const midSx = (x(SHOULDER_L) + x(SHOULDER_R)) / 2;
  const midSy = (L[SHOULDER_L].y + L[SHOULDER_R].y) / 2;
  const midHx = (x(HIP_L) + x(HIP_R)) / 2;
  const midHy = (L[HIP_L].y + L[HIP_R].y) / 2;
  const torso = Math.hypot(midSx - midHx, midSy - midHy);
  if (torso < o.minTorso) return null;

  const dx = x(SHOULDER_L) - x(SHOULDER_R);
  const width = Math.abs(dx) / torso;
  const yaw = (Math.acos(clamp(width / frontWidth, 0, 1)) * 180) / Math.PI;
  const nose = L[NOSE] ? (x(NOSE) - midSx) / torso : 0;

  // Direction votes, positive = left side toward the camera. The nose leads (it points where they face:
  // image-left when their left side is toward the camera). World depth and ears help when it's near center.
  const W = frame.world;
  const depth = W?.[SHOULDER_L] && W?.[SHOULDER_R] ? clamp((W[SHOULDER_R].z - W[SHOULDER_L].z) / 0.25, -1, 1) : 0;
  const ears = L[EAR_L] && L[EAR_R] ? clamp(L[EAR_L].visibility - L[EAR_R].visibility, -1, 1) : 0;
  const noseVote = clamp(-nose / 0.1, -1, 1);
  const score = Math.abs(nose) >= o.noseSure ? noseVote : 0.6 * noseVote + 0.3 * depth + 0.1 * ears;
  const side = Math.abs(score) < 0.2 ? 0 : score > 0 ? 1 : -1;
  return { yaw, side, width, nose, frontal: dx > 0 };
}

/** Which bucket and tier a facing counts for, ignoring scan history. */
export function classify(f: Facing, opts: Partial<ScanOptions> = {}): { bucket: Bucket; tier: Tier } | null {
  const o = { ...SCAN_DEFAULTS, ...opts };
  const n = Math.abs(f.nose);
  if (f.frontal && f.yaw <= o.frontYaw[0] && n <= o.frontNose[0]) return { bucket: 'front', tier: 2 };
  if (f.frontal && f.yaw <= o.frontYaw[1] && n <= o.frontNose[1]) return { bucket: 'front', tier: 1 };
  if (f.side === 0 || f.yaw < o.threeQuarterYaw) return null;
  return { bucket: f.side > 0 ? 'left' : 'right', tier: f.yaw >= o.profileYaw ? 2 : 1 };
}

export type BucketState = {
  tier: Tier;
  /** Frames seen at the current tier (the sharpest of them is kept). */
  count: number;
  sharpness: number;
};

export type ScanProgress = {
  buckets: Record<Bucket, BucketState>;
  /** 0–1 for a progress ring: each bucket counts a third, half of that for a 3/4 view. */
  fraction: number;
  elapsedMs: number;
  done: boolean;
  /** What to tell the player right now. */
  hint: string;
};

export type Offer = { bucket: Bucket; tier: Tier; facing: Facing };

/**
 * Bucketing over a whole scan. Call `offer(frame, t)` per tracked frame: it says which bucket the frame
 * is a candidate for (or null). Measure the candidate's sharpness and call `submit`; it returns true if
 * the frame is the new keeper for that bucket. A higher tier always wins, then the sharper frame.
 *
 * Back views look like the front (shoulders wide, nose guessed near the middle), so the front bucket
 * only takes frames before the player has turned to a side, or after they've shown both sides
 * (they've come all the way around).
 */
export class ScanBuckets {
  private readonly opts: ScanOptions;
  private readonly state: Record<Bucket, BucketState> = {
    front: { tier: 0, count: 0, sharpness: 0 },
    left: { tier: 0, count: 0, sharpness: 0 },
    right: { tier: 0, count: 0, sharpness: 0 },
  };
  private startT: number | null = null;
  private lastT = 0;
  private frontWidth: number;
  private measuredFront = 0;
  private sidesSeen = new Set<Bucket>();
  private tracked = false;

  constructor(opts: Partial<ScanOptions> = {}) {
    this.opts = { ...SCAN_DEFAULTS, ...opts };
    this.frontWidth = this.opts.frontWidth;
  }

  offer(frame: PoseFrame, t = frame.t): Offer | null {
    this.startT ??= t;
    this.lastT = t;
    const facing = estimateFacing(frame, this.frontWidth, this.opts);
    this.tracked = facing !== null;
    if (!facing) return null;

    // Learn this player's square-on shoulder width from frames where the nose is centered.
    if (facing.frontal && Math.abs(facing.nose) < this.opts.frontNose[0] && facing.width > this.measuredFront) {
      this.measuredFront = facing.width;
      this.frontWidth = clamp(this.measuredFront, 0.45, 1.1);
    }

    const hit = classify(facing, this.opts);
    if (!hit) return null;
    if (hit.bucket !== 'front' && facing.yaw >= this.opts.profileYaw - 10) this.sidesSeen.add(hit.bucket);
    if (hit.bucket === 'front') {
      const turnedAway = this.sidesSeen.size > 0;
      const cameBack = this.sidesSeen.size === 2;
      if (turnedAway && !cameBack) return null;
    }
    if (hit.tier < this.state[hit.bucket].tier) return null;
    return { ...hit, facing };
  }

  /** No tracked person right now (the camera sends no frames then): keeps the clock and the hint current. */
  idle(t: number) {
    this.startT ??= t;
    this.lastT = t;
    this.tracked = false;
  }

  /** Record a candidate's sharpness. True if it's the new best for its bucket (keep its image). */
  submit(offer: Offer, sharpness: number): boolean {
    const s = this.state[offer.bucket];
    if (offer.tier > s.tier) {
      Object.assign(s, { tier: offer.tier, count: 1, sharpness });
      return true;
    }
    if (offer.tier < s.tier) return false;
    s.count++;
    if (sharpness <= s.sharpness) return false;
    s.sharpness = sharpness;
    return true;
  }

  get progress(): ScanProgress {
    const elapsedMs = this.startT === null ? 0 : this.lastT - this.startT;
    const b = this.state;
    const allGood = BUCKETS.every((k) => b[k].tier === 2 && b[k].count >= this.opts.minGood);
    const done = allGood || elapsedMs >= this.opts.durationMs;
    const fraction = BUCKETS.reduce((sum, k) => sum + (b[k].tier === 2 ? 1 : b[k].tier === 1 ? 0.5 : 0) / 3, 0);
    return { buckets: structuredClone(b), fraction, elapsedMs, done, hint: this.hint(done) };
  }

  private hint(done: boolean): string {
    const b = this.state;
    if (done) return BUCKETS.every((k) => b[k].tier > 0) ? 'Got you!' : 'Time! Using what we got';
    if (!this.tracked) return 'Step back so the camera sees you, head to hips';
    if (this.sidesSeen.size === 0 && (b.front.tier < 2 || b.front.count < this.opts.minGood)) return 'Face the camera…';
    if (b.right.tier < 2 && b.left.tier < 2) return 'Turn slowly to your left…';
    if (b.right.tier < 2 || b.left.tier < 2) return 'Keep going, all the way around…';
    if (b.front.tier < 2) return 'Back to facing the camera…';
    return 'Hold it…';
  }
}

// ---------------------------------------------------------------------------
// Crop + sharpness
// ---------------------------------------------------------------------------

export type Box = { x: number; y: number; w: number; h: number };

/**
 * Pixel box around the person from landmarks, padded generously (the forge wants the whole person
 * plus some room: hair, hands, shoes). Landmarks stop at the face, so the top gets extra for the head.
 * Clamped to the frame; null if nothing usable.
 */
export function personBox(frame: PoseFrame, width: number, height: number, minVisibility = 0.3): Box | null {
  const pts = frame.image.filter((p) => p.visibility >= minVisibility);
  if (pts.length < 4) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x * width);
    x1 = Math.max(x1, p.x * width);
    y0 = Math.min(y0, p.y * height);
    y1 = Math.max(y1, p.y * height);
  }
  const L = frame.image;
  const nose = L[NOSE], sl = L[SHOULDER_L], sr = L[SHOULDER_R];
  const neck = nose && sl && sr ? Math.abs((sl.y + sr.y) / 2 - nose.y) * height : 0;
  const bodyH = y1 - y0;
  y0 -= Math.max(neck * 1.1, bodyH * 0.08); // top of the head
  y1 += bodyH * 0.06;
  const h = y1 - y0;
  // At least a 3:5 box, so a profile isn't a thin sliver.
  const w = Math.max(x1 - x0 + h * 0.2, h * 0.6);
  const cx = (x0 + x1) / 2;
  return clampBox({ x: cx - w / 2, y: y0, w, h }, width, height);
}

function clampBox(b: Box, width: number, height: number): Box | null {
  const x0 = clamp(Math.round(b.x), 0, width), y0 = clamp(Math.round(b.y), 0, height);
  const x1 = clamp(Math.round(b.x + b.w), 0, width), y1 = clamp(Math.round(b.y + b.h), 0, height);
  return x1 - x0 < 8 || y1 - y0 < 8 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Size to scale a w×h image to so its long side is at most `max` (never upscales). */
export function fitLongSide(w: number, h: number, max: number): { w: number; h: number } {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** RGBA pixels (ImageData.data) to luma. */
export function toGray(rgba: ArrayLike<number>, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return out;
}

/** Variance of the 4-neighbour Laplacian: higher = sharper. Blur from turning or bad focus drops it. */
export function laplacianVariance(gray: ArrayLike<number>, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}
