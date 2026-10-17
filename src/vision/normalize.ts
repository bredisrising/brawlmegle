import type { JointName, Pose } from './pose';

/** MediaPipe Pose landmark indices for the joints we use (neck = shoulder midpoint). */
export const MP_INDEX: Record<Exclude<JointName, 'neck'>, number> = {
  head: 0, // nose
  lShoulder: 11, rShoulder: 12,
  lElbow: 13, rElbow: 14,
  lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24,
  lKnee: 25, rKnee: 26,
  lAnkle: 27, rAnkle: 28,
};

export interface RawLandmark { x: number; y: number; z: number; visibility?: number }

/**
 * MediaPipe world landmarks (meters, hip-centered, y down, -z toward camera)
 * -> fighter-local Pose (y up, +z toward opponent, 1m tall, feet on y=0).
 *
 * TODO: implement (flip y/z, scale to FIGHTER_HEIGHT, drop feet to floor, recover root translation).
 */
export function normalizeLandmarks(_landmarks: RawLandmark[], out: Pose): Pose {
  return out;
}
