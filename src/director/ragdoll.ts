import * as THREE from 'three';
import { GUARD_POSE, JOINTS, type JointName, type Pose } from './pose';

/**
 * A K.O.'d fighter goes limp: the pose's joints become particles (Verlet) held together by the skeleton's lengths,
 * thrown by the finishing blow and dropped by gravity onto the floor, where they slide to a stop. No randomness and a
 * fixed step, so the same blow falls the same way on both laptops and in the replay.
 *
 * It runs in the fighter's root space (feet on the floor at y = 0, +z toward the opponent, +x the fighter's left).
 * The torso is kept rigid; `write` turns the body to follow it and gives back the pose relative to the torso, which
 * is what SkeletonPose expects (it doesn't rotate the hips bone itself).
 */
export type KoBlow = { move?: string; hand?: 'L' | 'R'; height?: string; strength: number };

const STEP = 1 / 120;
const ITERATIONS = 10;
/** Root-space units are ~1 per body height: heavier than real gravity, for an arcade drop. */
const GRAVITY = 8;
const AIR_DAMPING = 0.997;
const GROUND_FRICTION = 0.8;
const RESTITUTION = 0.22;
/** Settled: stop simulating after this long with nothing moving. */
const REST_SPEED = 0.02;
const HIP_REST = GUARD_POSE.lHip.y;

const index = Object.fromEntries(JOINTS.map((j, i) => [j, i])) as Record<JointName, number>;
/** How far each joint's surface is from its center (so a body lying down rests on its back, not its bones). */
const RADIUS: Record<JointName, number> = {
  head: 0.075, neck: 0.05, lShoulder: 0.05, rShoulder: 0.05, lElbow: 0.035, rElbow: 0.035, lWrist: 0.04, rWrist: 0.04,
  lHip: 0.06, rHip: 0.06, lKnee: 0.04, rKnee: 0.04, lAnkle: 0.035, rAnkle: 0.035,
};

/** [a, b, min, max] as fractions of the rest length; `torso` links take their length from the neutral guard pose. */
type Link = { a: number; b: number; rest: number; min: number; max: number; torso: boolean };
const SPEC: [JointName, JointName, number, number, boolean][] = [
  // Torso: a rigid box.
  ['lShoulder', 'rShoulder', 1, 1, true], ['lHip', 'rHip', 1, 1, true],
  ['lShoulder', 'lHip', 1, 1, true], ['rShoulder', 'rHip', 1, 1, true],
  ['lShoulder', 'rHip', 1, 1, true], ['rShoulder', 'lHip', 1, 1, true],
  ['neck', 'lShoulder', 1, 1, true], ['neck', 'rShoulder', 1, 1, true],
  ['neck', 'lHip', 1, 1, true], ['neck', 'rHip', 1, 1, true],
  // Head: fixed to the neck, free to loll a little.
  ['neck', 'head', 1, 1, false], ['head', 'lShoulder', 0.82, 1.12, true], ['head', 'rShoulder', 0.82, 1.12, true],
  // Limbs: fixed lengths, and they can't fold flat.
  ['lShoulder', 'lElbow', 1, 1, false], ['lElbow', 'lWrist', 1, 1, false],
  ['rShoulder', 'rElbow', 1, 1, false], ['rElbow', 'rWrist', 1, 1, false],
  ['lHip', 'lKnee', 1, 1, false], ['lKnee', 'lAnkle', 1, 1, false],
  ['rHip', 'rKnee', 1, 1, false], ['rKnee', 'rAnkle', 1, 1, false],
  ['lShoulder', 'lWrist', 0.35, 1, false], ['rShoulder', 'rWrist', 0.35, 1, false],
  ['lHip', 'lAnkle', 0.5, 1, false], ['rHip', 'rAnkle', 0.5, 1, false],
  // Knees and feet don't pass through each other.
  ['lKnee', 'rKnee', 0.6, 99, true], ['lAnkle', 'rAnkle', 0.5, 99, true],
];

const tA = new THREE.Vector3();
const tB = new THREE.Vector3();
const tC = new THREE.Vector3();
const tD = new THREE.Vector3();
const tE = new THREE.Vector3();
const tF = new THREE.Vector3();
const basis = new THREE.Matrix4();

export class Ragdoll {
  active = false;
  /** The torso has hit the floor (once per fall). */
  landed = false;
  private readonly pos = JOINTS.map(() => new THREE.Vector3());
  private readonly prev = JOINTS.map(() => new THREE.Vector3());
  private links: Link[] = [];
  private acc = 0;
  private still = 0;

  /**
   * Go limp from the pose on screen. `body` is the body group's matrix in root space (its lunge and lean), and the
   * blow decides the throw: back off the hit, up off an uppercut, sideways off a hook.
   */
  start(pose: Pose, body: THREE.Matrix4, blow: KoBlow | null) {
    for (const j of JOINTS) this.pos[index[j]].copy(pose[j]).applyMatrix4(body);
    this.links = SPEC.map(([a, b, min, max, torso]) => {
      const rest = (torso ? GUARD_POSE[a].distanceTo(GUARD_POSE[b]) : pose[a].distanceTo(pose[b])) || 0.01;
      return { a: index[a], b: index[b], rest, min, max, torso };
    });
    const s = blow?.strength ?? 0.8;
    const move = blow?.move ?? '';
    const up = move === 'uppercut' ? 2.6 : move === 'kick' || move === 'knee' ? 1.4 : 0.9;
    // A hook from the attacker's left lands on this fighter's right side and carries the head toward its left (+x).
    const side = move === 'hook' ? (blow?.hand === 'L' ? 1 : -1) : 0;
    const v = tA;
    for (const j of JOINTS) {
      const upper = j === 'head' ? 1.6 : j === 'neck' || j.includes('Shoulder') ? 1 : j.includes('Elbow') || j.includes('Wrist') ? 0.8 : 0.45;
      v.set(side * 0.9 * s * (j === 'head' ? 1.4 : upper * 0.5), up * s * (0.5 + 0.4 * upper), -(1.1 + 0.8 * upper) * s);
      // The feet get swept forward as the body flies back, so it tips over instead of sliding upright.
      // The guard lets go: hands drop and fall open, so the arms flop instead of staying up by the face.
      const open = j[0] === 'l' ? 1 : -1;
      if (j.includes('Wrist')) v.add(tB.set(open * 1.1, -1.6, 0.3));
      if (j.includes('Elbow')) v.add(tB.set(open * 0.8, -0.7, 0));
      if (j.includes('Ankle')) v.z += 0.5 * s;
      if (j.includes('Knee')) v.z += 0.2 * s;
      this.prev[index[j]].copy(this.pos[index[j]]).addScaledVector(v, -STEP);
    }
    this.acc = 0;
    this.still = 0;
    this.landed = false;
    this.active = true;
  }

  /** Advance by dt (fixed steps). True on the step the torso first lands. */
  step(dt: number): boolean {
    if (!this.active || this.still > 1) return false;
    const wasLanded = this.landed;
    this.acc = Math.min(this.acc + dt, 0.25);
    let fastest = 0;
    while (this.acc >= STEP - 1e-9) {
      this.acc -= STEP;
      fastest = 0;
      for (let i = 0; i < this.pos.length; i++) {
        const p = this.pos[i];
        const q = this.prev[i];
        const vx = (p.x - q.x) * AIR_DAMPING;
        const vy = (p.y - q.y) * AIR_DAMPING - GRAVITY * STEP * STEP;
        const vz = (p.z - q.z) * AIR_DAMPING;
        q.copy(p);
        p.x += vx;
        p.y += vy;
        p.z += vz;
      }
      for (let k = 0; k < ITERATIONS; k++) {
        for (const l of this.links) this.solveLink(l);
        this.keepKneesForward();
        for (let i = 0; i < this.pos.length; i++) this.pos[i].y = Math.max(this.pos[i].y, RADIUS[JOINTS[i]] * 0.98);
      }
      for (let i = 0; i < this.pos.length; i++) {
        const p = this.pos[i];
        const q = this.prev[i];
        const r = RADIUS[JOINTS[i]];
        if (p.y < r) {
          const vy = p.y - q.y;
          p.y = r;
          q.y = r + (vy < 0 ? vy * RESTITUTION : 0);
          // Floor friction: the body skids and stops.
          q.x = p.x - (p.x - q.x) * GROUND_FRICTION;
          q.z = p.z - (p.z - q.z) * GROUND_FRICTION;
          const torso = JOINTS[i] === 'neck' || JOINTS[i].includes('Hip') || JOINTS[i].includes('Shoulder');
          if (torso) this.landed = true;
        }
        fastest = Math.max(fastest, p.distanceTo(q) / STEP);
      }
    }
    this.still = fastest < REST_SPEED ? this.still + dt : 0;
    return this.landed && !wasLanded;
  }

  /**
   * Put the body group on the torso (hips at the guard pose's hip height, upright in its own frame) and write the
   * pose relative to it into `out`.
   */
  write(out: Pose, body: THREE.Object3D) {
    const p = (j: JointName) => this.pos[index[j]];
    const hip = tA.copy(p('lHip')).add(p('rHip')).multiplyScalar(0.5);
    const x = tB.copy(p('lHip')).sub(p('rHip')).normalize();
    const y = tC.copy(p('lShoulder')).add(p('rShoulder')).multiplyScalar(0.5).sub(hip).normalize();
    const z = tD.crossVectors(x, y).normalize();
    y.crossVectors(z, x).normalize();
    basis.makeBasis(x, y, z);
    body.quaternion.setFromRotationMatrix(basis);
    // body.position + R * (0, HIP_REST, 0) = hip
    body.position.copy(hip).sub(y.multiplyScalar(HIP_REST));
    body.updateMatrix();
    const inverse = basis.copy(body.matrix).invert();
    for (const j of JOINTS) out[j].copy(this.pos[index[j]]).applyMatrix4(inverse);
  }

  /** Where a joint is (root space). */
  joint(j: JointName, out: THREE.Vector3) {
    return out.copy(this.pos[index[j]]);
  }

  private solveLink(l: Link) {
    const a = this.pos[l.a];
    const b = this.pos[l.b];
    const d = tA.subVectors(b, a);
    const len = d.length() || 1e-6;
    const lo = l.rest * l.min;
    const hi = l.rest * l.max;
    const target = len < lo ? lo : len > hi ? hi : len;
    if (target === len) return;
    d.multiplyScalar((len - target) / len / 2);
    a.add(d);
    b.sub(d);
  }

  /** Knees only bend one way: one that ends up behind the hip-to-ankle line (relative to the torso) is pushed back to it. */
  private keepKneesForward() {
    const p = (j: JointName) => this.pos[index[j]];
    const x = tA.copy(p('lHip')).sub(p('rHip'));
    const y = tB.copy(p('neck')).sub(p('lHip')).add(p('neck')).sub(p('rHip'));
    const forward = tC.crossVectors(x, y).normalize();
    for (const [hipJ, kneeJ, ankleJ] of [['lHip', 'lKnee', 'lAnkle'], ['rHip', 'rKnee', 'rAnkle']] as const) {
      const hip = p(hipJ);
      const knee = p(kneeJ);
      const line = tD.subVectors(p(ankleJ), hip);
      const along = tE.subVectors(knee, hip).dot(line) / (line.lengthSq() || 1e-6);
      const foot = tE.copy(hip).addScaledVector(line, along);
      const off = tF.subVectors(knee, foot);
      // A joint limit, not a teleport: push it back onto the line (mirroring it would throw the leg).
      const back = off.dot(forward);
      if (back < 0) knee.addScaledVector(forward, -back);
    }
  }
}
