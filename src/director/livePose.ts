import type { Landmark } from '../types';
import type { JointName, Pose } from './pose';

const FIGHTER_HEIGHT = 1;

/** MediaPipe Pose landmark indices for the joints we display (neck = shoulder midpoint). */
export const MP_INDEX: Record<Exclude<JointName, 'neck'>, number> = {
  head: 0, // nose
  lShoulder: 11, rShoulder: 12,
  lElbow: 13, rElbow: 14,
  lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24,
  lKnee: 25, rKnee: 26,
  lAnkle: 27, rAnkle: 28,
};

/**
 * PoseFrame.world landmarks (meters, hip-centered, y down, smaller z toward camera)
 * -> fighter-local 2.5D pose: X = lateral dodge lane, Y = height,
 * +Z = forward toward opponent; height is normalized to 1 m and feet sit at y=0.
 * Feeds the live-pose layer (~30% blend during idle/guard, 0% during attacks).
 *
 */
export function worldLandmarksToPose(world: Landmark[], out: Pose): Pose {
  const landmark = (joint: Exclude<JointName, 'neck'>) => world[MP_INDEX[joint]];
  const leftAnkle = landmark('lAnkle');
  const rightAnkle = landmark('rAnkle');
  const head = landmark('head');
  if (!leftAnkle || !rightAnkle || !head) return out;

  const floor = (leftAnkle.y + rightAnkle.y) / 2;
  const height = Math.abs(head.y - floor);
  if (!Number.isFinite(height) || height < 0.15) return out;
  const scale = FIGHTER_HEIGHT / height;

  for (const joint of Object.keys(MP_INDEX) as Exclude<JointName, 'neck'>[]) {
    const point = landmark(joint);
    if (!point) continue;
    // MediaPipe uses y down and reports negative z toward the camera.
    out[joint].set(point.x * scale, (floor - point.y) * scale, -point.z * scale);
  }
  out.neck.copy(out.lShoulder).add(out.rShoulder).multiplyScalar(0.5);
  return out;
}
