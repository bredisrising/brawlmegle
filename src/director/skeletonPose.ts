import * as THREE from 'three';
import type { JointName, Pose } from './pose';

/**
 * Drives a Mixamo-rigged model (every forged fighter) from the display Pose: each bone is turned so it points
 * the way the matching body segment points. Absolute rotations per bone, so parents and children don't fight;
 * twist along each limb stays as in the rest pose. The spine also turns with the shoulder line, so a cross or a
 * hook turns the chest, not just the arm.
 *
 * Everything is relative to `space` (the fighter's body group), so the whole body can tilt (a K.O. fall, a hit)
 * and the bones still come out right.
 */
/**
 * `follow`: how much of the segment's direction to take (the rest is the rig's rest direction). The torso and
 * neck only partly follow, so the head and chest stay upright under the arcade poses' extremes.
 */
type Segment = { bone: string; child: string; from: JointName | 'hips'; to: JointName; follow?: number; turn?: boolean };
const SEGMENTS: Segment[] = [
  { bone: 'Spine', child: 'Neck', from: 'hips', to: 'neck', follow: 0.6, turn: true },
  { bone: 'Neck', child: 'Head', from: 'neck', to: 'head', follow: 0.6 },
  { bone: 'LeftArm', child: 'LeftForeArm', from: 'lShoulder', to: 'lElbow' },
  { bone: 'LeftForeArm', child: 'LeftHand', from: 'lElbow', to: 'lWrist' },
  { bone: 'RightArm', child: 'RightForeArm', from: 'rShoulder', to: 'rElbow' },
  { bone: 'RightForeArm', child: 'RightHand', from: 'rElbow', to: 'rWrist' },
  { bone: 'LeftUpLeg', child: 'LeftLeg', from: 'lHip', to: 'lKnee' },
  { bone: 'LeftLeg', child: 'LeftFoot', from: 'lKnee', to: 'lAnkle' },
  { bone: 'RightUpLeg', child: 'RightLeg', from: 'rHip', to: 'rKnee' },
  { bone: 'RightLeg', child: 'RightFoot', from: 'rKnee', to: 'rAnkle' },
];

/** Rest data in `space` coordinates. `across` (right shoulder -> left shoulder) only for turning segments. */
type Rig = { bone: THREE.Bone; restQuat: THREE.Quaternion; restDir: THREE.Vector3; across?: THREE.Vector3; seg: Segment };

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const parentQ = new THREE.Quaternion();
const spaceQ = new THREE.Quaternion();
const basis = new THREE.Matrix4();

export class SkeletonPose {
  private readonly rigs: Rig[] = [];
  /** Height of the hips bone above `space`'s origin (the feet) at rest, in `space` units. */
  hipHeight = 0.5;

  private constructor(private readonly space: THREE.Object3D) {}

  /** Returns null if the model has no Mixamo skeleton. Call after the model is added under `space`. */
  static from(model: THREE.Object3D, space: THREE.Object3D): SkeletonPose | null {
    const find = (name: string) =>
      (model.getObjectByName(`mixamorig${name}`) ?? model.getObjectByName(`mixamorig:${name}`)) as THREE.Bone | undefined;
    const hips = find('Hips');
    if (!hips) return null;
    space.updateWorldMatrix(true, true);
    const toSpace = space.getWorldQuaternion(new THREE.Quaternion()).invert();
    const local = (o: THREE.Object3D) => space.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
    const sp = new SkeletonPose(space);
    sp.hipHeight = local(hips).y;
    const lArm = find('LeftArm');
    const rArm = find('RightArm');
    for (const seg of SEGMENTS) {
      const bone = find(seg.bone);
      const child = find(seg.child);
      if (!bone || !child) continue;
      const restDir = local(child).sub(local(bone)).normalize();
      const restQuat = toSpace.clone().multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
      const across = seg.turn && lArm && rArm ? local(lArm).sub(local(rArm)).normalize() : undefined;
      sp.rigs.push({ bone, restQuat, restDir, across, seg });
    }
    return sp;
  }

  /** Pose the skeleton. `pose` is in `space`'s local coordinates. */
  apply(pose: Pose) {
    this.space.getWorldQuaternion(spaceQ);
    for (const r of this.rigs) {
      const parent = r.bone.parent;
      if (!parent) continue;
      const from = r.seg.from === 'hips' ? tmpA.copy(pose.lHip).add(pose.rHip).multiplyScalar(0.5) : tmpA.copy(pose[r.seg.from]);
      const dir = tmpB.copy(pose[r.seg.to]).sub(from);
      if (dir.lengthSq() < 1e-8) continue;
      dir.normalize();
      if (r.seg.follow !== undefined) dir.lerp(r.restDir, 1 - r.seg.follow).normalize();
      let q: THREE.Quaternion;
      if (r.across) {
        // Match both the up direction and the shoulder line.
        const across = tmpC.copy(pose.lShoulder).sub(pose.rShoulder);
        q = frame(dir, across, tmpQ).multiply(frame(r.restDir, r.across, tmpQ2).invert());
      } else {
        q = tmpQ.setFromUnitVectors(r.restDir, dir);
      }
      // world = space * q * rest; local = parentWorld^-1 * world
      const world = q.premultiply(spaceQ).multiply(r.restQuat);
      parent.getWorldQuaternion(parentQ);
      r.bone.quaternion.copy(parentQ.invert().multiply(world));
      r.bone.updateMatrixWorld(true);
    }
  }
}

const fx = new THREE.Vector3();
const fz = new THREE.Vector3();
/** Rotation whose y axis is `up` and whose x axis is `across` made perpendicular to it. */
function frame(up: THREE.Vector3, across: THREE.Vector3, out: THREE.Quaternion) {
  fx.copy(across).addScaledVector(up, -across.dot(up));
  if (fx.lengthSq() < 1e-8) fx.set(1, 0, 0);
  fx.normalize();
  fz.crossVectors(fx, up);
  return out.setFromRotationMatrix(basis.makeBasis(fx, up, fz));
}
