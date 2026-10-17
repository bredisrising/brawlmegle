// Scale-free "fist toward the camera" signal from relative depth. Depth Anything gives relative inverse depth
// (bigger = closer) with an unknown scale and shift that change every frame, so only ratios of differences
// mean anything:
//
//   toward = (hand - body) / (body - background)
//
// hand       = 90th percentile of depth in a window of ±0.35 shoulder widths around the MediaPipe hand center:
//              the closest thing near the hand, i.e. the fist, even when the landmark lags or slides off a
//              blurred fist (a small patch median at the wrist often lands on the background or the forearm).
// body       = median of the nose and both shoulder patches (robust to one of them sitting on the outline or
//              off-frame; the chest is often below the frame when sitting close).
// background = the frame's 10th percentile.
// The denominator (the frame's depth scale) is smoothed over a few frames, which removes one-frame spikes.
//
// With a far background, inverse depth ~ 1/Z, so toward ~ Z_body / Z_hand - 1: 0 with the hand at face depth,
// ~0.3 for a guard a little in front of the face, 1 when the fist is twice as close as the face.
// See research/depth-spike.md.

import type { Landmark } from '../../src/types';

export type SampleSpec = { x: number; y: number; /** half-size, fraction of image width */ r: number; /** percentile 0..1 */ q: number };
export type DepthSamples = Record<string, number>;
export type DepthPct = { p5: number; p10: number; p50: number; p90: number; p95: number };

const SMALL = 0.012;
const HAND_WINDOW = 0.35;

/** What to sample for one frame (normalized image positions). Hands well outside the frame are skipped. */
export function samplePoints(image: Landmark[], aspect: number): Record<string, SampleSpec> {
  const at = (i: number): SampleSpec => ({ x: image[i].x, y: image[i].y, r: SMALL, q: 0.5 });
  const mean = (...ids: number[]) => ({
    x: ids.reduce((s, i) => s + image[i].x, 0) / ids.length,
    y: ids.reduce((s, i) => s + image[i].y, 0) / ids.length,
  });
  // Shoulder width in image-height units; as a fraction of the width that's / aspect.
  const shoulderW = Math.hypot((image[11].x - image[12].x) * aspect, image[11].y - image[12].y);
  const specs: Record<string, SampleSpec> = {
    nose: at(0),
    lShoulder: at(11),
    rShoulder: at(12),
    lElbow: at(13),
    rElbow: at(14),
    lWrist: at(15),
    rWrist: at(16),
  };
  const hands: [string, number][] = [['lHand', 15], ['rHand', 16]];
  for (const [name, w] of hands) {
    const c = mean(w, w + 2, w + 4); // wrist, pinky, index
    if (c.x < -0.1 || c.x > 1.1 || c.y < -0.1 || c.y > 1.1) continue;
    specs[name] = { ...c, r: (HAND_WINDOW * shoulderW) / aspect, q: 0.9 };
  }
  return specs;
}

/** Per-arm toward-camera signal, with the frame's depth scale smoothed across frames. */
export class TowardSignal {
  private scale = NaN;

  update(s: DepthSamples, pct: DepthPct): { L: number; R: number } {
    const refs = [s.nose, s.lShoulder, s.rShoulder].filter(Number.isFinite).sort((a, b) => a - b);
    if (!refs.length) return { L: NaN, R: NaN };
    const body = refs.length === 2 ? (refs[0] + refs[1]) / 2 : refs[refs.length >> 1];
    // Floor the scale so a frame with no visible background can't blow the ratio up.
    const scale = Math.max(body - pct.p10, 0.25 * (pct.p95 - pct.p5), 1e-6);
    this.scale = Number.isFinite(this.scale) ? this.scale + 0.3 * (scale - this.scale) : scale;
    const toward = (hand: number | undefined) => (hand === undefined || !Number.isFinite(hand) ? NaN : (hand - body) / this.scale);
    return { L: toward(s.lHand), R: toward(s.rHand) };
  }
}
