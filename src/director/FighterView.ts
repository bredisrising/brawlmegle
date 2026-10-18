import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { FightEvent, FighterState, ForgedFighter, PlayerId, PoseFrame } from '../types';
import { FIGHTER_SCALE, FIGHTER_SPACING, PLAYER_COLORS } from '../game/constants';
import { disposeObject } from './dispose';
import { BONES, GUARD_POSE, JOINTS, copyPose, createPose, type JointName, type Pose } from './pose';
import { worldLandmarksToPose } from './livePose';
import { SkeletonPose } from './skeletonPose';

/**
 * How one fighter looks on screen. Driven by the fight engine's FighterState
 * (position, phase, move) plus a light blend of the player's live pose.
 * It never decides anything; it only shows what the engine decided.
 *
 * TODO:
 *  - animate loaded GLBs (Mixamo bones) with AnimationMixer
 *  - layers: locomotion, action clips, live pose (~30% in idle/guard)
 *  - stepped animation (~12 fps poses), IK fist onto target at contact
 *  - reactions from FightEvents: head rock, knockback, hit flash
 */
export class FighterView {
  readonly id: PlayerId;
  /** World placement; rotated so local +z faces the opponent. */
  readonly root = new THREE.Group();
  readonly pose = createPose();
  private readonly livePose = createPose();

  private readonly joints = new Map<JointName, THREE.Mesh>();
  private readonly bones: THREE.LineSegments;
  private readonly placeholder = new THREE.Group();
  private model: THREE.Group | null = null;
  /** Bone driver for rigged (forged) models; null for the default parts model. */
  private skeleton: SkeletonPose | null = null;
  private readonly modelParts = new Map<string, THREE.Object3D>();
  private loadVersion = 0;

  constructor(id: PlayerId) {
    this.id = id;
    const side = id === 'p1' ? -1 : 1;
    this.root.position.x = (side * FIGHTER_SPACING) / 2;
    this.root.rotation.y = (-side * Math.PI) / 2;
    this.root.scale.setScalar(FIGHTER_SCALE);
    this.root.visible = false;

    // Placeholder model: joint spheres + bone lines.
    const material = new THREE.MeshStandardMaterial({ color: PLAYER_COLORS[id], roughness: 0.4 });
    for (const j of JOINTS) {
      const r = j === 'head' ? 0.075 : j.includes('Wrist') ? 0.04 : 0.025;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), material);
      mesh.castShadow = true;
      this.joints.set(j, mesh);
      this.placeholder.add(mesh);
    }
    this.bones = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(BONES.length * 6, 3)),
      new THREE.LineBasicMaterial({ color: PLAYER_COLORS[id] }),
    );
    this.placeholder.add(this.bones);
    this.root.add(this.placeholder);
    this.applyPose(copyPose(this.pose, GUARD_POSE));
  }

  /** Load a selected avatar; fighters without a model keep the joint placeholder. */
  async setFighter(fighter: ForgedFighter) {
    const version = ++this.loadVersion;
    const model = fighter.glbUrl ? (await new GLTFLoader().loadAsync(fighter.glbUrl)).scene : null;
    if (version !== this.loadVersion) {
      if (model) disposeObject(model);
      return;
    }
    if (this.model) {
      this.model.removeFromParent();
      disposeObject(this.model);
    }
    this.model = model;
    this.modelParts.clear();
    this.placeholder.visible = model === null;
    if (model) {
      model.traverse((object) => {
        this.modelParts.set(object.name.toLowerCase(), object);
        if (object instanceof THREE.Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
        }
      });
      // Forged fighters (Tripo) are exported facing +x; this fighter space faces +z toward the opponent.
      if (fighter.glbUrl?.includes('/api/forge/')) model.rotation.y = -Math.PI / 2;
      this.root.add(model);
    }
    this.skeleton = model ? SkeletonPose.from(model) : null;
  }

  setVisible(visible: boolean) {
    this.root.visible = visible;
  }

  /** Called every sim tick with the engine's state and the latest live frame (if any). */
  update(state: Readonly<FighterState>, live: PoseFrame | null) {
    this.root.position.x = state.x;
    if (!live) return;

    worldLandmarksToPose(live.world, this.livePose);
    // Camera data controls the display skeleton directly. Smooth it slightly so
    // tracking jitter does not make the fighter flicker between camera frames.
    for (const joint of JOINTS) this.pose[joint].lerp(this.livePose[joint], 0.35);
    this.applyPose(this.pose);
    if (this.skeleton) {
      // Knees and ankles (25-28) must be seen to pose the legs; sitting players keep a standing stance.
      const legsVisible = [25, 26, 27, 28].every((i) => (live.image[i]?.visibility ?? 0) > 0.5);
      this.skeleton.apply(this.pose, this.root, legsVisible);
    } else {
      this.applyDefaultModelPose(this.pose);
    }
  }

  /** React to a fight event involving this fighter. */
  onEvent(_event: FightEvent) {}

  worldJoint(joint: JointName, out = new THREE.Vector3()) {
    this.root.updateMatrixWorld();
    return out.copy(this.pose[joint]).applyMatrix4(this.root.matrixWorld);
  }

  dispose() {
    ++this.loadVersion;
    disposeObject(this.root);
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

  /** Pose the shipped static default GLB by its named, separate body meshes. */
  private applyDefaultModelPose(pose: Pose) {
    if (!this.model) return;
    const setPosition = (name: string, position: THREE.Vector3) => this.modelParts.get(name)?.position.copy(position);
    const setLimb = (name: string, from: THREE.Vector3, to: THREE.Vector3, restLength: number) => {
      const part = this.modelParts.get(name);
      if (!part) return;
      const direction = to.clone().sub(from);
      part.position.copy(from).add(to).multiplyScalar(0.5);
      part.quaternion.setFromUnitVectors(UP, direction.normalize());
      part.scale.set(1, direction.length() / restLength, 1);
    };

    setLimb('left upper arm', pose.lShoulder, pose.lElbow, GUARD_POSE.lShoulder.distanceTo(GUARD_POSE.lElbow));
    setLimb('left forearm', pose.lElbow, pose.lWrist, GUARD_POSE.lElbow.distanceTo(GUARD_POSE.lWrist));
    setLimb('right upper arm', pose.rShoulder, pose.rElbow, GUARD_POSE.rShoulder.distanceTo(GUARD_POSE.rElbow));
    setLimb('right forearm', pose.rElbow, pose.rWrist, GUARD_POSE.rElbow.distanceTo(GUARD_POSE.rWrist));
    setLimb('left thigh', pose.lHip, pose.lKnee, GUARD_POSE.lHip.distanceTo(GUARD_POSE.lKnee));
    setLimb('left shin', pose.lKnee, pose.lAnkle, GUARD_POSE.lKnee.distanceTo(GUARD_POSE.lAnkle));
    setLimb('right thigh', pose.rHip, pose.rKnee, GUARD_POSE.rHip.distanceTo(GUARD_POSE.rKnee));
    setLimb('right shin', pose.rKnee, pose.rAnkle, GUARD_POSE.rKnee.distanceTo(GUARD_POSE.rAnkle));
    setPosition('left glove', pose.lWrist);
    setPosition('right glove', pose.rWrist);
    setPosition('left shoe', pose.lAnkle);
    setPosition('right shoe', pose.rAnkle);
    setPosition('hips', midpoint(pose.lHip, pose.rHip));
    setPosition('neck', pose.neck);
    setPosition('head', pose.head);
  }
}

const UP = new THREE.Vector3(0, 1, 0);
function midpoint(a: THREE.Vector3, b: THREE.Vector3) {
  return a.clone().add(b).multiplyScalar(0.5);
}
