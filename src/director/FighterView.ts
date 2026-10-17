import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { FightEvent, FighterState, ForgedFighter, PlayerId, PoseFrame } from '../types';
import { FIGHTER_SCALE, FIGHTER_SPACING, PLAYER_COLORS } from '../game/constants';
import { BONES, GUARD_POSE, JOINTS, copyPose, createPose, type JointName, type Pose } from './pose';

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

  private readonly joints = new Map<JointName, THREE.Mesh>();
  private readonly bones: THREE.LineSegments;
  private readonly placeholder = new THREE.Group();
  private model: THREE.Group | null = null;
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
    this.placeholder.visible = model === null;
    if (model) {
      model.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
        }
      });
      this.root.add(model);
    }
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
}

function disposeObject(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}
