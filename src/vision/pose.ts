import { Vector3 } from 'three';

/**
 * Pose in fighter-local space:
 *  - meters, normalized so the fighter is ~1m tall (FIGHTER_HEIGHT)
 *  - y up, feet at y = 0
 *  - +z is "forward" (toward the opponent), +x is the fighter's left
 */
export const JOINTS = [
  'head', 'neck',
  'lShoulder', 'rShoulder', 'lElbow', 'rElbow', 'lWrist', 'rWrist',
  'lHip', 'rHip', 'lKnee', 'rKnee', 'lAnkle', 'rAnkle',
] as const;

export type JointName = (typeof JOINTS)[number];
export type Pose = Record<JointName, Vector3>;

export type Hand = 'left' | 'right';
export const HANDS: readonly Hand[] = ['left', 'right'];
export const WRIST: Record<Hand, JointName> = { left: 'lWrist', right: 'rWrist' };

/** Pairs of joints rendered as limbs. */
export const BONES: readonly [JointName, JointName][] = [
  ['neck', 'head'],
  ['lShoulder', 'rShoulder'],
  ['lShoulder', 'lElbow'], ['lElbow', 'lWrist'],
  ['rShoulder', 'rElbow'], ['rElbow', 'rWrist'],
  ['lHip', 'rHip'],
  ['lHip', 'lKnee'], ['lKnee', 'lAnkle'],
  ['rHip', 'rKnee'], ['rKnee', 'rAnkle'],
];

export function createPose(): Pose {
  return Object.fromEntries(JOINTS.map((j) => [j, new Vector3()])) as Pose;
}

export function copyPose(dst: Pose, src: Pose): Pose {
  for (const j of JOINTS) dst[j].copy(src[j]);
  return dst;
}
