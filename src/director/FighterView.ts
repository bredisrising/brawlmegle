import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { FightEvent, FighterState, ForgedFighter, Hand, PlayerId, PoseFrame } from '../types';
import { FIGHTER_SCALE, FIGHTER_SPACING, FIGHT_LINE_SCALE, PLAYER_COLORS } from '../game/constants';
import { config } from '../config';
import { disposeObject } from './dispose';
import { BONES, GUARD_POSE, JOINTS, copyPose, createPose, type JointName, type Pose } from './pose';
import { LivePoseMapper } from './livePose';
import { SkeletonPose } from './skeletonPose';
import { HIP_HEIGHT, applyAction, stance, type HitInfo, type Motion } from './fightPose';

/** What the view needs each sim tick. */
export type ViewInput = {
  state: Readonly<FighterState>;
  /** The player's latest camera frame (null for a CPU, or nobody tracked). */
  live: PoseFrame | null;
  /** Guard up this tick (the player's stance, or the CPU's). */
  guard: boolean;
  /** Center-to-center distance on the fight line (engine meters). */
  distance: number;
  opponentKo: boolean;
  dt: number;
};

/** How much of the live pose each joint takes, relative to config.liveBlend. Legs only when they're in view. */
const LIVE_WEIGHT: Record<JointName, number> = {
  head: 1.4, neck: 1.4, lShoulder: 1.2, rShoulder: 1.2,
  lElbow: 1, rElbow: 1, lWrist: 1, rWrist: 1,
  lHip: 0.5, rHip: 0.5, lKnee: 0.6, rKnee: 0.6, lAnkle: 0.6, rAnkle: 0.6,
};
const LEG_JOINTS = new Set<JointName>(['lKnee', 'rKnee', 'lAnkle', 'rAnkle']);

/**
 * How one fighter looks on screen: an arcade fighter, not a puppet. It stands in a fighting stance; moves, hits,
 * blocks, evades and K.O.s play out exactly as the fight engine timed them (fightPose.ts); the player's own body
 * is blended in lightly on top (config.liveBlend) so it still feels like them. It never decides anything.
 *
 *   root (placement on the fight line, facing, display scale)
 *     body (lunge, tilt, K.O. fall; origin at the feet)
 *       placeholder (joint spheres)   |   modelHolder (hip drop) -> model (forged GLB, Mixamo bones)
 */
export class FighterView {
  readonly id: PlayerId;
  /** World placement; rotated so local +z faces the opponent. */
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly modelHolder = new THREE.Group();
  readonly pose = createPose();
  private readonly target = createPose();
  private readonly livePose = createPose();
  private readonly smoothLive = createPose();
  private readonly mapper = new LivePoseMapper();
  private liveReady = false;

  private readonly joints = new Map<JointName, THREE.Mesh>();
  private readonly bones: THREE.LineSegments;
  private readonly placeholder = new THREE.Group();
  private model: THREE.Group | null = null;
  /** Bone driver for rigged (forged) models; null for the default parts model. */
  private skeleton: SkeletonPose | null = null;
  private readonly modelParts = new Map<string, THREE.Object3D>();
  private flashMaterials: { material: THREE.MeshStandardMaterial; emissive: THREE.Color; intensity: number }[] = [];
  private loadVersion = 0;

  // Animation state.
  private time = Math.random() * 10;
  private lastX: number | null = null;
  private step = 0;
  private stepPhase = 0;
  private guardAmt = 0;
  private duck = 0;
  private slip = 0;
  private tellAt = -1;
  private tellHand: Hand = 'R';
  private koTime = 0;
  private wonTime = 0;
  private hit: HitInfo | null = null;
  private flash = 0;
  private readonly motion: Motion = { lunge: 0, tilt: 0, lift: 0 };
  /** Stepped animation: time since the shown pose last changed, and what the engine was doing then. */
  private sinceStep = Infinity;
  private shownPhase = '';
  private forceStep = false;
  /** Materialize-in: world height up to which the fighter is drawn (rises from the floor when it spawns). */
  private readonly reveal = { value: 100 };
  private readonly revealColor = { value: new THREE.Color() };
  private revealT = -1;

  constructor(id: PlayerId) {
    this.id = id;
    const side = id === 'p1' ? -1 : 1;
    this.root.position.x = (side * FIGHTER_SPACING * FIGHT_LINE_SCALE) / 2;
    this.root.rotation.y = (-side * Math.PI) / 2;
    this.root.scale.setScalar(FIGHTER_SCALE);
    this.root.visible = false;
    this.root.add(this.body);
    this.body.add(this.modelHolder);

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
    this.body.add(this.placeholder);
    this.flashMaterials = [{ material, emissive: material.emissive.clone(), intensity: material.emissiveIntensity }];
    this.revealColor.value.set(PLAYER_COLORS[id]).multiplyScalar(6);
    this.patchReveal(material);
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
    this.flashMaterials = [];
    const collect = (m: THREE.Material) => {
      if (m instanceof THREE.MeshStandardMaterial) this.flashMaterials.push({ material: m, emissive: m.emissive.clone(), intensity: m.emissiveIntensity });
      this.patchReveal(m);
    };
    if (model) {
      model.traverse((object) => {
        this.modelParts.set(object.name.toLowerCase(), object);
        if (object instanceof THREE.Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
          for (const m of Array.isArray(object.material) ? object.material : [object.material]) collect(m);
        }
      });
      // Forged fighters (Tripo) are exported facing +x; this fighter space faces +z toward the opponent.
      if (fighter.glbUrl?.includes('/api/forge/')) model.rotation.y = -Math.PI / 2;
      // Rest data is captured with the body upright and unshifted.
      this.body.position.set(0, 0, 0);
      this.body.rotation.set(0, 0, 0);
      this.modelHolder.position.set(0, 0, 0);
      this.modelHolder.add(model);
    } else {
      for (const mesh of this.joints.values()) collect(mesh.material as THREE.Material);
    }
    this.skeleton = model ? SkeletonPose.from(model, this.body) : null;
  }

  setVisible(visible: boolean) {
    this.root.visible = visible;
  }

  /** Build the fighter up out of light, feet first (spawning in, a player joining). */
  materialize() {
    this.revealT = 0;
    this.reveal.value = -0.05;
  }

  /** Back to a fresh fighter (rematch). */
  reset() {
    this.koTime = this.wonTime = 0;
    this.hit = null;
    this.tellAt = -1;
    this.flash = 0;
    this.lastX = null;
  }

  /** The reader (or the CPU) saw a wind-up: show the tell right away, before the engine commits to a move. */
  anticipate(hand: Hand) {
    this.tellAt = this.time;
    this.tellHand = hand;
  }

  /** Called every sim tick with the engine's state and the latest live frame (if any). */
  update({ state, live, guard, distance, opponentKo, dt }: ViewInput) {
    this.time += dt;
    this.root.position.x = state.x * FIGHT_LINE_SCALE;

    // Walking: feet shuffle with speed along the fight line.
    const speed = this.lastX === null ? 0 : Math.abs(state.x - this.lastX) / Math.max(dt, 1e-3);
    this.lastX = state.x;
    this.step = approach(this.step, Math.min(1, speed / 0.4), dt, 8);
    this.stepPhase += dt * 2 * Math.PI * 2.6 * (this.step > 0.05 ? 1 : 0);

    // Smoothed switches, so guard and evades ease in and out instead of popping.
    const free = state.phase === 'idle' || state.phase === 'blockstun';
    this.guardAmt = approach(this.guardAmt, guard && free ? 1 : 0, dt, 14);
    this.duck = approach(this.duck, state.evade === 'duck' ? 1 : 0, dt, state.evade === 'duck' ? 22 : 9);
    this.slip = approach(this.slip, state.evade === 'slip' ? (state.evadeDir === 'R' ? -1 : 1) : 0, dt, state.evade === 'slip' ? 22 : 9);
    if (state.phase !== 'idle' || this.time - this.tellAt > 0.6) this.tellAt = -1;
    this.koTime = state.phase === 'ko' ? this.koTime + dt : 0;
    this.wonTime = opponentKo && state.phase !== 'ko' ? this.wonTime + dt : 0;
    if (state.phase !== 'hitstun') this.hit = null;

    stance(this.target, this.time, this.guardAmt, this.step, this.stepPhase);
    if (live) this.blendLive(live);
    applyAction(
      this.target,
      {
        state,
        reach: (distance * FIGHT_LINE_SCALE) / FIGHTER_SCALE,
        hit: this.hit,
        koTime: this.koTime,
        won: this.wonTime,
        duck: this.duck,
        slip: this.slip,
        tell: this.tellAt < 0 ? 0 : Math.min(1, (this.time - this.tellAt) / 0.15),
        tellHand: this.tellHand,
      },
      this.motion,
    );
    this.updateReveal(dt);
    // Stepped ("on twos") animation: the shown pose holds and jumps at config.animFps, except that a change in what
    // the engine is doing (a strike going active, a hit, a K.O.) shows on its exact frame.
    const phaseKey = `${state.phase}:${state.move ?? ''}`;
    if (phaseKey !== this.shownPhase) this.forceStep = true;
    this.sinceStep += dt;
    const stepped = config.animFps > 0;
    if (stepped && !this.forceStep && this.sinceStep < 1 / config.animFps) {
      this.updateFlash(dt);
      return;
    }
    this.sinceStep = 0;
    this.forceStep = false;
    this.shownPhase = phaseKey;
    // Smooth mode eases a little to hide the odd pop (a strike cut off by a hit); stepped mode pops on purpose.
    for (const j of JOINTS) this.pose[j].lerp(this.target[j], stepped ? 1 : 0.6);
    this.body.position.set(0, this.motion.lift, this.motion.lunge);
    this.body.rotation.x = this.motion.tilt;

    this.applyPose(this.pose);
    if (this.skeleton) {
      this.skeleton.apply(this.pose);
      // The hips bone isn't driven: drop the whole model by as much as the pose's hips dropped (crouch, duck).
      const hipY = (this.pose.lHip.y + this.pose.rHip.y) / 2;
      this.modelHolder.position.y = (hipY - HIP_HEIGHT) * (this.skeleton.hipHeight / HIP_HEIGHT);
    } else {
      this.applyDefaultModelPose(this.pose);
    }
    this.updateFlash(dt);
  }

  /** React to a fight event that hit (or was blocked by) this fighter. `by` is the attacker's state at the time. */
  onEvent(event: FightEvent, by?: Readonly<FighterState>) {
    if (event.type === 'hit' || event.type === 'counter') {
      const strength = Math.min(1.4, Math.max(0.5, (event.damage ?? 5) / 10)) * (event.type === 'counter' ? 1.25 : 1);
      this.hit = { move: event.move, hand: by?.hand, height: by?.height, strength };
      this.flash = event.type === 'counter' ? 1 : 0.7;
      this.forceStep = true;
    } else if (event.type === 'blocked') {
      this.flash = 0.25;
      this.forceStep = true;
    }
  }

  worldJoint(joint: JointName, out = new THREE.Vector3()) {
    this.body.updateMatrixWorld();
    return out.copy(this.pose[joint]).applyMatrix4(this.body.matrixWorld);
  }

  dispose() {
    ++this.loadVersion;
    disposeObject(this.root);
    this.root.removeFromParent();
  }

  /** Mix the player's (smoothed) live pose into the stance. */
  private blendLive(live: PoseFrame) {
    this.mapper.map(live, this.livePose);
    if (!this.liveReady) copyPose(this.smoothLive, this.livePose);
    this.liveReady = true;
    const base = config.liveBlend;
    for (const j of JOINTS) {
      // Heavily smoothed: this layer is only personality (lean, head, hands), and camera jitter on a held pose
      // reads as glitching, more so on stepped animation.
      this.smoothLive[j].lerp(this.livePose[j], 0.18);
      const w = LEG_JOINTS.has(j) && !this.mapper.legsVisible ? 0 : Math.min(1, base * LIVE_WEIGHT[j]);
      if (w > 0) this.target[j].lerp(this.smoothLive[j], w);
    }
  }

  /** Rises from the floor to over the head in ~1.4 s; the glowing edge band is drawn by the patched shader. */
  private updateReveal(dt: number) {
    if (this.revealT < 0) return;
    this.revealT += dt;
    const t = Math.min(1, this.revealT / 1.4);
    // Ease out: fast up the legs, slowing into the head. Heights in world units (fighters ~0.75 tall on screen).
    this.reveal.value = -0.05 + (1 - (1 - t) ** 2) * 0.95;
    if (t >= 1) {
      this.revealT = -1;
      this.reveal.value = 100;
    }
  }

  /**
   * Materialize shader: everything above the reveal height is cut away, and a band just under it glows in the
   * player's color with a little noise, like it's being printed out of light.
   */
  private patchReveal(material: THREE.Material) {
    if (!(material instanceof THREE.MeshStandardMaterial) || material.userData.reveal) return;
    material.userData.reveal = true;
    const reveal = this.reveal;
    const color = this.revealColor;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uReveal = reveal;
      shader.uniforms.uRevealColor = color;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRevealPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvRevealPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vRevealPos;\nuniform float uReveal;\nuniform vec3 uRevealColor;',
        )
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
          float revealNoise = fract(sin(dot(floor(vRevealPos.xz * 90.0), vec2(12.9898, 78.233))) * 43758.5453) * 0.025;
          if (vRevealPos.y > uReveal + revealNoise) discard;`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          float revealBand = 1.0 - smoothstep(0.0, 0.06, uReveal + revealNoise - vRevealPos.y);
          totalEmissiveRadiance += uRevealColor * revealBand * step(uReveal, 50.0);`,
        );
    };
    material.customProgramCacheKey = () => 'reveal';
    material.needsUpdate = true;
  }

  /** Hit flash: the fighter's materials glow white for a moment. */
  private updateFlash(dt: number) {
    if (this.flash <= 0 && this.flashMaterials.every((f) => f.material.emissiveIntensity === f.intensity)) return;
    this.flash = Math.max(0, this.flash - dt * 6);
    for (const f of this.flashMaterials) {
      if (this.flash > 0) {
        f.material.emissive.setRGB(1, 1, 1);
        f.material.emissiveIntensity = this.flash * 0.8;
      } else {
        f.material.emissive.copy(f.emissive);
        f.material.emissiveIntensity = f.intensity;
      }
    }
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
      const length = direction.length();
      part.position.copy(from).add(to).multiplyScalar(0.5);
      part.quaternion.setFromUnitVectors(UP, direction.normalize());
      part.scale.set(1, length / restLength, 1);
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
/** Exponential approach toward `target` at `rate` per second. */
function approach(value: number, target: number, dt: number, rate: number) {
  return value + (target - value) * (1 - Math.exp(-rate * dt));
}
