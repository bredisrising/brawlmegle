import * as THREE from 'three';
import type { FightEvent, FighterState, PlayerId, PoseFrame } from '../types';
import { FIGHTER_SPACING, PLAYER_COLORS } from '../game/constants';
import { BONES, GUARD_POSE, JOINTS, copyPose, createPose, type JointName, type Pose } from './pose';

/**
 * How one fighter looks on screen. Driven by the fight engine's FighterState
 * (position, phase, move) plus a light blend of the player's live pose.
 * It never decides anything; it only shows what the engine decided.
 *
 * TODO:
 *  - swap the placeholder for the forged GLB (Mixamo bones) + AnimationMixer
 *  - layers: locomotion, action clips, live pose (~30% in idle/guard)
 *  - stepped animation (~12 fps poses), IK fist onto target at contact
 *  - reactions from FightEvents: head rock, knockback, hit flash
 */
export class FighterView {
  readonly id: PlayerId;
  /** World placement; rotated so local +z faces the opponent. */
  readonly root = new THREE.Group();
  readonly pose = createPose();

  private readonly joints = new Map<JointName, THREE.Mesh>();
  private readonly bones: THREE.LineSegments;

  constructor(id: PlayerId) {
    this.id = id;
    const side = id === 'p1' ? -1 : 1;
    this.root.position.x = (side * FIGHTER_SPACING) / 2;
    this.root.rotation.y = (-side * Math.PI) / 2;
    this.root.visible = false;

    // Placeholder model: joint spheres + bone lines.
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
    this.applyPose(copyPose(this.pose, GUARD_POSE));
  }

  setVisible(visible: boolean) {
    this.root.visible = visible;
  }

  /** Called every sim tick with the engine's state and the latest live frame (if any). */
  update(_state: Readonly<FighterState>, _live: PoseFrame | null) {}

  /** React to a fight event involving this fighter. */
  onEvent(_event: FightEvent) {}

  worldJoint(joint: JointName, out = new THREE.Vector3()) {
    this.root.updateMatrixWorld();
    return out.copy(this.pose[joint]).applyMatrix4(this.root.matrixWorld);
  }

  dispose() {
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
