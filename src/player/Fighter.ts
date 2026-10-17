import * as THREE from 'three';
import type { PlayerId } from '../types';
import { FIGHTER_SPACING, PLAYER_COLORS } from '../game/constants';
import { BONES, JOINTS, copyPose, createPose, type JointName, type Pose, type PoseTracker } from '../vision';

/**
 * One player in the world: placement, pose input, and the visual model.
 *
 * The rendered pose is NOT 100% the tracked pose — reactions (knockback,
 * head recoil) get layered on top so hits read clearly.
 */
export class Fighter {
  readonly id: PlayerId;
  /** World placement; rotated so local +z faces the opponent. */
  readonly root = new THREE.Group();
  readonly trackedPose = createPose();
  readonly renderPose = createPose();
  tracker: PoseTracker | null = null;

  private readonly joints = new Map<JointName, THREE.Mesh>();
  private readonly bones: THREE.LineSegments;

  constructor(id: PlayerId) {
    this.id = id;
    const side = id === 'p1' ? -1 : 1;
    this.root.position.x = (side * FIGHTER_SPACING) / 2;
    this.root.rotation.y = (-side * Math.PI) / 2;
    this.root.visible = false;

    // Placeholder model: joint spheres + bone lines.
    // TODO: replace with the generated GLB (from services/imageTo3D) skinned to a rig driven by renderPose.
    const material = new THREE.MeshStandardMaterial({ color: PLAYER_COLORS[id], roughness: 0.4 });
    for (const j of JOINTS) {
      const r = j === 'head' ? 0.075 : j.includes('Wrist') ? 0.04 : 0.025;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), material);
      mesh.castShadow = true;
      this.joints.set(j, mesh);
      this.root.add(mesh);
    }
    this.bones = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(BONES.length * 6, 3)),
      new THREE.LineBasicMaterial({ color: PLAYER_COLORS[id] }),
    );
    this.root.add(this.bones);
  }

  setTracker(tracker: PoseTracker | null) {
    this.tracker?.stop();
    this.tracker = tracker;
    this.root.visible = !!tracker;
  }

  /** Fixed-step update: pull latest pose, apply reactions, update the model. */
  step(_dt: number) {
    const pose = this.tracker?.getPose();
    if (!pose) return;
    copyPose(this.trackedPose, pose);
    copyPose(this.renderPose, this.trackedPose);
    // TODO: knockback / head-recoil springs layered onto renderPose + root offset.
    this.applyPose(this.renderPose);
  }

  /** React to being hit. */
  hit(_damage: number, _headshot: boolean) {
    // TODO: knockback impulse along local -z, head recoil, hit flash.
  }

  worldJoint(joint: JointName, out = new THREE.Vector3()) {
    return out.copy(this.renderPose[joint]).applyMatrix4(this.root.matrixWorld);
  }

  dispose() {
    this.setTracker(null);
    this.root.removeFromParent();
  }

  private applyPose(pose: Pose) {
    for (const [j, mesh] of this.joints) mesh.position.copy(pose[j]);
    const attr = this.bones.geometry.getAttribute('position') as THREE.BufferAttribute;
    BONES.forEach(([a, b], i) => {
      attr.setXYZ(i * 2, pose[a].x, pose[a].y, pose[a].z);
      attr.setXYZ(i * 2 + 1, pose[b].x, pose[b].y, pose[b].z);
    });
    attr.needsUpdate = true;
  }
}
