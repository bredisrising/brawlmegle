import type { Landmark, PoseFrame } from '../types';
import { GUARD_POSE, type JointName, type Pose } from './pose';

/** MediaPipe Pose landmark indices for the joints we display (neck = shoulder midpoint, head = between the ears). */
export const MP_INDEX: Record<Exclude<JointName, 'neck'>, number> = {
  head: 0, // nose (the head point itself is the ear midpoint, see LivePoseMapper)
  lShoulder: 11, rShoulder: 12,
  lElbow: 13, rElbow: 14,
  lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24,
  lKnee: 25, rKnee: 26,
  lAnkle: 27, rAnkle: 28,
};

const UPPER = ['head', 'lShoulder', 'rShoulder', 'lElbow', 'rElbow', 'lWrist', 'rWrist', 'lHip', 'rHip'] as const;
const LEGS = ['lKnee', 'rKnee', 'lAnkle', 'rAnkle'] as const;
/** Display torso: shoulder midpoint to hip midpoint. */
const TORSO = GUARD_POSE.neck.y - (GUARD_POSE.lHip.y + GUARD_POSE.rHip.y) / 2;
const HIP_Y = (GUARD_POSE.lHip.y + GUARD_POSE.rHip.y) / 2;

/**
 * PoseFrame -> display Pose (y up, +z toward the opponent, fighter-local units, feet on y = 0), for the live layer.
 * Works sitting or standing, whatever the camera:
 * - Scale comes from the torso (shoulders to hips, in MediaPipe's metric world space), smoothed, not from head-to-feet
 *   height: a crouch shouldn't stretch the fighter back to full height, and a seated player has no feet in view.
 * - With knees and ankles in view the feet go on the floor, so a real duck lowers the fighter. Without them (sitting,
 *   close framing) the hips stay at standing height and the legs come from the guard stance instead of guesses.
 * - The head is the ear midpoint, not the nose (which sits in front of the face and bows the head).
 */
export class LivePoseMapper {
  private scale = 0;
  legsVisible = false;

  map(frame: PoseFrame, out: Pose): Pose {
    const w = frame.world;
    if (w.length < 29) return out;
    const torso = dist(mid(w[11], w[12]), mid(w[23], w[24]));
    if (!Number.isFinite(torso) || torso < 0.1) return out;
    const target = TORSO / torso;
    this.scale = this.scale ? this.scale + (target - this.scale) * 0.05 : target;
    const s = this.scale;
    // MediaPipe world: meters, hip-centered, y down, -z toward the camera. The person's left is +x.
    const put = (v: { x: number; y: number; z: number }, o: { set(x: number, y: number, z: number): unknown }) =>
      o.set(v.x * s, -v.y * s, -v.z * s);

    for (const j of UPPER) put(j === 'head' ? mid(w[7], w[8]) : w[MP_INDEX[j]], out[j]);
    out.head.y += 0.03; // ears sit a little below the middle of the head

    const vis = (i: number) => (frame.image[i]?.visibility ?? 0) > 0.5;
    // A little hysteresis so the legs don't flicker in and out at the frame edge.
    const seen = [25, 26, 27, 28].every(vis);
    const partly = [25, 26, 27, 28].filter(vis).length >= 3;
    this.legsVisible = this.legsVisible ? partly : seen;

    let lift: number;
    if (this.legsVisible) {
      for (const j of LEGS) put(w[MP_INDEX[j]], out[j]);
      lift = -Math.min(out.lAnkle.y, out.rAnkle.y) + 0.03;
    } else {
      // Hips at standing height; legs from the stance, under wherever the hips are.
      lift = HIP_Y;
      const hx = (out.lHip.x + out.rHip.x) / 2;
      const hz = (out.lHip.z + out.rHip.z) / 2;
      for (const j of LEGS) out[j].set(GUARD_POSE[j].x + hx, GUARD_POSE[j].y - lift, GUARD_POSE[j].z + hz);
    }
    for (const j of [...UPPER, ...LEGS]) out[j].y += lift;
    out.neck.copy(out.lShoulder).add(out.rShoulder).multiplyScalar(0.5);
    return out;
  }
}

/** One-shot version (no smoothing, no hysteresis), for tools. */
export function worldLandmarksToPose(world: Landmark[], out: Pose, image: Landmark[] = world): Pose {
  return new LivePoseMapper().map({ t: 0, world, image }, out);
}

type P = { x: number; y: number; z: number };
const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
