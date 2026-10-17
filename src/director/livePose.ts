import type { Landmark } from '../types';
import type { JointName, Pose } from './pose';

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
 * PoseFrame.world landmarks (meters, hip-centered, y down, -z toward camera)
 * -> display Pose (y up, +z toward opponent, 1m tall, feet on y=0).
 * Feeds the live-pose layer (~30% blend during idle/guard, 0% during attacks).
 *
 * TODO: implement (flip y/z, scale to FIGHTER_HEIGHT, drop feet to the floor).
 */
export function worldLandmarksToPose(_world: Landmark[], out: Pose): Pose {
  return out;
}
