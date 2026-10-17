// Synthetic MediaPipe poses for a person standing at a given yaw, for the scan tests.
import type { Landmark, PoseFrame } from '../../src/types';

/**
 * Body points in meters, facing the camera: x = image right (the person's left), y = down, z = away from
 * the camera. Only the landmarks the scan reads are placed; the rest sit at the hip center.
 */
const BODY: Record<number, [number, number, number]> = {
  0: [0, -0.62, -0.1], // nose
  2: [0.03, -0.66, -0.08], // left eye
  5: [-0.03, -0.66, -0.08], // right eye
  7: [0.07, -0.64, 0], // left ear
  8: [-0.07, -0.64, 0], // right ear
  11: [0.18, -0.5, 0], // left shoulder
  12: [-0.18, -0.5, 0],
  13: [0.22, -0.25, 0], // elbows
  14: [-0.22, -0.25, 0],
  15: [0.22, 0, -0.05], // wrists
  16: [-0.22, 0, -0.05],
  23: [0.1, 0, 0], // hips
  24: [-0.1, 0, 0],
  25: [0.1, 0.42, 0], // knees
  26: [-0.1, 0.42, 0],
  27: [0.1, 0.82, 0], // ankles
  28: [-0.1, 0.82, 0],
};

/**
 * yaw in degrees: 0 = facing the camera, +90 = left side toward the camera (they turned to their right,
 * nose points image-left), -90 = right side toward the camera, 180 = back to the camera.
 * `labelsFlipped` mimics MediaPipe calling a back view a front view (left/right swapped).
 */
export function poseAt(yaw: number, opts: { t?: number; aspect?: number; noise?: number; seed?: number; scale?: number } = {}): PoseFrame {
  const { t = 0, aspect = 4 / 3, noise = 0, scale = 0.45 } = opts;
  let seed = opts.seed ?? 1;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647 - 0.5) * 2 * noise;
  };
  const th = (yaw * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const image: Landmark[] = [];
  const world: Landmark[] = [];
  for (let i = 0; i < 33; i++) {
    const [x, y, z] = BODY[i] ?? [0, 0, 0];
    const xr = x * c + z * s;
    const zr = -x * s + z * c;
    world.push({ x: xr, y, z: zr, visibility: 0.99 });
    image.push({ x: 0.5 + (xr * scale) / aspect + rand(), y: 0.55 + y * scale + rand(), z: zr, visibility: 0.99 });
  }
  return { t, image, world, aspect };
}

/** A frame with left/right labels swapped, the way MediaPipe often reads a back view as a front view. */
export function swapSides(frame: PoseFrame): PoseFrame {
  const pairs = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
  const swap = (pts: Landmark[]) => {
    const out = pts.slice();
    for (const [a, b] of pairs) [out[a], out[b]] = [pts[b], pts[a]];
    return out;
  };
  return { ...frame, image: swap(frame.image), world: swap(frame.world) };
}
