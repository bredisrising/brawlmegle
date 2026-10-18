import type { Landmark, PoseFrame } from '../types';

/**
 * Scan logic with no DOM: which way the player faces, which bucket a frame belongs in, and how sharp
 * a crop is. The guided scan (scanGuide.ts) builds on it; the tests feed it synthetic poses.
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
  /** Like yaw but 0–180: past 90 when the shoulders say it's a back view (see `frontal`). */
  turn: number;
  /** Which side turned toward the camera, from the nose offset (plus depth and ears). 0 when unsure. */
  side: -1 | 0 | 1; // 1 = left side toward camera, -1 = right side
  /** Shoulder width over torso length (aspect-corrected). Shrinks as they turn. */
  width: number;
  /** Nose x minus shoulder-midpoint x, over torso length. Negative when the nose points image-left. */
  nose: number;
  /** Left shoulder is on the image right, as when facing the camera. False usually means a back view. */
  frontal: boolean;
  /** World nose depth minus the ears', meters: about -0.1 facing the camera, 0 in profile, positive facing away. */
  noseDepth: number;
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
  /** Nose this far (m) behind the ears means they're facing away: we'd get the back of their head. */
  maxNoseDepth: 0.045,
  /** |nose offset| needed to trust the direction on its own. */
  noseSure: 0.04,
  /** Torso must be at least this tall (fraction of image height) and in frame. */
  minTorso: 0.08,
  minVisibility: 0.5,
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
  const frontal = dx > 0;
  const noseDepth = W?.[NOSE] && W[EAR_L] && W[EAR_R] ? W[NOSE].z - (W[EAR_L].z + W[EAR_R].z) / 2 : 0;
  return { yaw, turn: frontal ? yaw : 180 - yaw, side, width, nose, frontal, noseDepth };
}

/** Which bucket and tier a facing counts for, ignoring scan history. */
export function classify(f: Facing, opts: Partial<ScanOptions> = {}): { bucket: Bucket; tier: Tier } | null {
  const o = { ...SCAN_DEFAULTS, ...opts };
  const n = Math.abs(f.nose);
  if (f.noseDepth > o.maxNoseDepth) return null;
  if (f.frontal && f.yaw <= o.frontYaw[0] && n <= o.frontNose[0]) return { bucket: 'front', tier: 2 };
  if (f.frontal && f.yaw <= o.frontYaw[1] && n <= o.frontNose[1]) return { bucket: 'front', tier: 1 };
  // A profile is good from either side of 90°; a 3/4 view only from the front (a 3/4 back view is mostly back).
  if (f.side === 0 || f.turn < o.threeQuarterYaw || f.turn > 180 - o.profileYaw) return null;
  return { bucket: f.side > 0 ? 'left' : 'right', tier: f.turn >= o.profileYaw ? 2 : 1 };
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
