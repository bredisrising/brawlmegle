import { Vector3 } from 'three';

/**
 * Display skeleton used by the director (placeholder fighters, live-pose layer).
 * Fighter-local space: meters, ~1m tall, y up, feet at y = 0,
 * +z toward the opponent, +x is the fighter's left.
 */
export const JOINTS = [
  'head', 'neck',
  'lShoulder', 'rShoulder', 'lElbow', 'rElbow', 'lWrist', 'rWrist',
  'lHip', 'rHip', 'lKnee', 'rKnee', 'lAnkle', 'rAnkle',
] as const;

export type JointName = (typeof JOINTS)[number];
export type Pose = Record<JointName, Vector3>;

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

/** Rough standing guard pose, used until real models + animation exist. */
export const GUARD_POSE: Pose = (() => {
  const p = createPose();
  p.head.set(0, 0.9, 0);
  p.neck.set(0, 0.82, 0);
  p.lShoulder.set(0.12, 0.78, 0); p.rShoulder.set(-0.12, 0.78, 0);
  p.lElbow.set(0.15, 0.66, 0.04); p.rElbow.set(-0.15, 0.66, 0.04);
  p.lWrist.set(0.07, 0.76, 0.15); p.rWrist.set(-0.07, 0.76, 0.12);
  p.lHip.set(0.07, 0.5, 0); p.rHip.set(-0.07, 0.5, 0);
  p.lKnee.set(0.075, 0.27, 0.05); p.rKnee.set(-0.075, 0.27, -0.03);
  p.lAnkle.set(0.07, 0.03, 0.08); p.rAnkle.set(-0.07, 0.03, -0.06);
  return p;
})();
