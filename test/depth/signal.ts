// Scale-free "fist toward the camera" signal from relative depth (Depth Anything: inverse depth, bigger = closer,
// with an unknown scale and shift that change every frame).
//
//   toward = (d_hand - d_chest) / (d_chest - d_background)
//
// Differences cancel the shift; dividing by another difference cancels the scale. With a far background,
// inverse depth d ~ 1/Z, so this is about Z_chest / Z_hand - 1: 0 with the hand at chest depth, ~0.25 with
// the fist a fifth of the way to the camera, 1 when it is twice as close as the chest. The chest (below the
// shoulder midpoint) is the reference rather than the shoulders, because shoulder landmarks sit on the body
// outline and their patch often catches background. The background is the frame's 10th percentile.

import type { Landmark } from '../../src/types';

export type DepthSamples = Record<string, number>;
export type DepthPct = { p5: number; p10: number; p50: number; p90: number; p95: number };

/** Landmarks to sample, as normalized image positions. */
export function samplePoints(image: Landmark[], aspect: number): Record<string, [number, number]> {
  const at = (i: number): [number, number] => [image[i].x, image[i].y];
  const mean = (...ids: number[]): [number, number] => [
    ids.reduce((s, i) => s + image[i].x, 0) / ids.length,
    ids.reduce((s, i) => s + image[i].y, 0) / ids.length,
  ];
  const [sx, sy] = mean(11, 12);
  const shoulderW = Math.hypot((image[11].x - image[12].x) * aspect, image[11].y - image[12].y);
  return {
    nose: at(0),
    lShoulder: at(11),
    rShoulder: at(12),
    lElbow: at(13),
    rElbow: at(14),
    lWrist: at(15),
    rWrist: at(16),
    // Hand center (wrist, pinky, index): when the fist comes at the camera it covers the wrist anyway.
    lHand: mean(15, 17, 19),
    rHand: mean(16, 18, 20),
    // Upper chest: a third of a shoulder width below the shoulder midpoint.
    chest: [sx, sy + 0.33 * shoulderW],
  };
}

/** Per-arm toward-camera signal; NaN if the samples are missing. */
export function towardSignal(s: DepthSamples, pct: DepthPct, side: 'L' | 'R'): number {
  const hand = side === 'L' ? s.lHand : s.rHand;
  const chest = s.chest;
  // Floor the denominator so a frame with no visible background can't blow the ratio up.
  const denom = Math.max(chest - pct.p10, 0.25 * (pct.p95 - pct.p5), 1e-6);
  return (hand - chest) / denom;
}
