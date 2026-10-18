import * as THREE from 'three';
import type { JointName, Pose } from './pose';

/**
 * Drives a Mixamo-rigged model (every forged fighter) from the display Pose: each bone is turned so it points
 * the way the matching body segment points. Absolute world rotations per bone, so parents and children don't
 * fight; twist along each bone stays as in the rest pose.
 */
/**
 * `follow`: how much of the player's segment direction to take (the rest is the rig's rest direction). The torso
 * and neck only partly follow: a seated player leaning toward the laptop shouldn't make the fighter hunch, and
 * MediaPipe's "head" point is the nose (in front of the head), which would bow the head.
 */
type Segment = { bone: string; child: string; from: JointName | 'hips'; to: JointName; leg?: boolean; follow?: number };
const SEGMENTS: Segment[] = [
  { bone: 'Spine', child: 'Neck', from: 'hips', to: 'neck', follow: 0.4 },
  { bone: 'Neck', child: 'Head', from: 'neck', to: 'head', follow: 0.25 },
  { bone: 'LeftArm', child: 'LeftForeArm', from: 'lShoulder', to: 'lElbow' },
  { bone: 'LeftForeArm', child: 'LeftHand', from: 'lElbow', to: 'lWrist' },
  { bone: 'RightArm', child: 'RightForeArm', from: 'rShoulder', to: 'rElbow' },
  { bone: 'RightForeArm', child: 'RightHand', from: 'rElbow', to: 'rWrist' },
  { bone: 'LeftUpLeg', child: 'LeftLeg', from: 'lHip', to: 'lKnee', leg: true },
  { bone: 'LeftLeg', child: 'LeftFoot', from: 'lKnee', to: 'lAnkle', leg: true },
  { bone: 'RightUpLeg', child: 'RightLeg', from: 'rHip', to: 'rKnee', leg: true },
  { bone: 'RightLeg', child: 'RightFoot', from: 'rKnee', to: 'rAnkle', leg: true },
];

type Rig = { bone: THREE.Bone; restWorldQuat: THREE.Quaternion; restDir: THREE.Vector3; seg: Segment };

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const parentQ = new THREE.Quaternion();
const rootQ = new THREE.Quaternion();

export class SkeletonPose {
  private readonly rigs: Rig[] = [];

  /** Returns null if the model has no Mixamo skeleton. Call after the model is added to the scene graph. */
  static from(model: THREE.Object3D): SkeletonPose | null {
    const find = (name: string) =>
      (model.getObjectByName(`mixamorig${name}`) ?? model.getObjectByName(`mixamorig:${name}`)) as THREE.Bone | undefined;
    if (!find('Hips')) return null;
    model.updateMatrixWorld(true);
    const sp = new SkeletonPose();
    for (const seg of SEGMENTS) {
      const bone = find(seg.bone);
      const child = find(seg.child);
      if (!bone || !child) continue;
      const restDir = child.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3())).normalize();
      sp.rigs.push({ bone, restWorldQuat: bone.getWorldQuaternion(new THREE.Quaternion()), restDir, seg });
    }
    return sp;
  }

  /**
   * Pose the skeleton. `pose` is in `space`'s local coordinates (the fighter root). Legs stay in their rest pose
   * when `legsVisible` is false (sitting players: the camera can't see them, and guessing looks broken).
   * The rest data was captured in world space at load, so `space` must not have rotated since; only moved.
   */
  apply(pose: Pose, space: THREE.Object3D, legsVisible: boolean) {
    space.getWorldQuaternion(rootQ);
    for (const r of this.rigs) {
      const parent = r.bone.parent;
      if (!parent) continue;
      parent.getWorldQuaternion(parentQ);
      let world: THREE.Quaternion;
      if (r.seg.leg && !legsVisible) {
        world = r.restWorldQuat;
      } else {
        const from = r.seg.from === 'hips' ? tmpA.copy(pose.lHip).add(pose.rHip).multiplyScalar(0.5) : tmpA.copy(pose[r.seg.from]);
        const dir = tmpB.copy(pose[r.seg.to]).sub(from);
        if (dir.lengthSq() < 1e-8) continue;
        dir.normalize().applyQuaternion(rootQ);
        if (r.seg.follow !== undefined) dir.lerp(r.restDir, 1 - r.seg.follow).normalize();
        world = tmpQ.setFromUnitVectors(r.restDir, dir).multiply(r.restWorldQuat);
      }
      // local = parentWorld^-1 * world
      r.bone.quaternion.copy(parentQ.invert().multiply(world));
      r.bone.updateMatrixWorld(true);
    }
  }
}
