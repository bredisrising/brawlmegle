import { Euler, Quaternion, Vector3 } from 'three';
import type { PlayerId } from '../types';
import { GUARD_POSE, JOINTS, copyPose, type JointName, type Pose } from './pose';
import { crouch, lean, solve, twist } from './fightPose';
import { BEAT, clamp01, easeInOut, smoothstep, type Beats } from './walkoutTiming';

/**
 * The walkout's choreography: Jamie's walkout from Street Fighter 6, move for move, on the joint pose (fighter space:
 * +z the way the fighter faces, +x their left, feet at y = 0, ~1 m tall). The director turns both fighters to the
 * camera, so it's all built square to the front from a relaxed stand:
 *
 *   fighter 1  dance-walks in, swings an arm up overhead and down across, flings it out, rolling hands, the finger wag,
 *              both hands thrown up; then in the two-shot drops into a handstand freeze (legs scissoring) and wheels
 *              over onto their feet, a hand in their hair and the other arm out.
 *   fighter 2  walks in and grooves while fighter 1's on; then an arm up overhead into a full spin, chin up, a hand on
 *              the chest; in the two-shot rolling hands, a quick spin, a hand on the hip and a flick by the face.
 *
 * Hands follow keyed paths (`[time, x, y, z]`, x toward the other fighter); the body turns, leans, sinks and bounces on
 * the beat. The tricks (spins, the handstand) move the whole body: `perform` fills a Body the view applies to its body
 * group (Motion's slide, lift, turn and roll).
 */
const UPPER_ARM = GUARD_POSE.lShoulder.distanceTo(GUARD_POSE.lElbow);
const FOREARM = GUARD_POSE.lElbow.distanceTo(GUARD_POSE.lWrist);
const THIGH = GUARD_POSE.lHip.distanceTo(GUARD_POSE.lKnee);
const SHIN = GUARD_POSE.lKnee.distanceTo(GUARD_POSE.lAnkle);
/** How far apart the fighters stand for the walkout (each one this far out from their mark, fighter units). */
const SPREAD = 0.16;
/** Where fighter 1 drops into the freeze from, out past their spot (they wheel back onto it). */
const FREEZE_FROM = 0.34;
/** The lowest point of a body in the middle of a trick sits this high (a hand or a foot on the floor). */
const FLOOR = 0.025;

/** Whole-body motion for the trick moves, in the fighter's own space (the view's body group). */
export type Body = {
  /** Sideways (+x, the fighter's left) and up. */
  slide: number;
  lift: number;
  /** Turn about the feet (a spin) and roll about the facing axis (the handstand), radians. */
  turn: number;
  roll: number;
  /** Where the fighter's spot is, sideways (the slide without a trick's own travel): the camera frames this. */
  spot: number;
};

type Key = readonly [t: number, x: number, y: number, z: number];
type Num = readonly [t: number, v: number];
type Side = 1 | -1;

const a = new Vector3();
const b = new Vector3();
const pole = new Vector3();
const pivot = new Vector3();
const moved = new Vector3();
const quat = new Quaternion();
const euler = new Euler();
const base = createScratch();
const layer = createScratch();

function createScratch(): Pose {
  return Object.fromEntries(JOINTS.map((j) => [j, new Vector3()])) as Pose;
}

/** 0 before `start`, easing to 1 over `len`. */
const ramp = (t: number, start: number, len: number) => smoothstep((t - start) / len);
/** 1 inside [from, to] (eased in and out over `edge`), else 0. */
const span = (t: number, from: number, to: number, edge = 0.2) => Math.min(ramp(t, from - edge, edge), 1 - ramp(t, to, edge));

/** Catmull-Rom through keyed values: smooth arcs through every key, held at the ends. */
function cr(t: number, n: number, time: (i: number) => number, value: (i: number) => number) {
  if (t <= time(0)) return value(0);
  if (t >= time(n - 1)) return value(n - 1);
  let i = 0;
  while (t > time(i + 1)) i++;
  const s = (t - time(i)) / Math.max(1e-6, time(i + 1) - time(i));
  const p0 = value(Math.max(0, i - 1));
  const p1 = value(i);
  const p2 = value(i + 1);
  const p3 = value(Math.min(n - 1, i + 2));
  const s2 = s * s;
  const s3 = s2 * s;
  return 0.5 * (2 * p1 + (p2 - p0) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 + (3 * p1 - p0 - 3 * p2 + p3) * s3);
}

/** A keyed scalar at `t`. */
function curve(keys: readonly Num[], t: number) {
  return cr(t, keys.length, (i) => keys[i][0], (i) => keys[i][1]);
}

/** A keyed hand position at `t`, with x toward the inner side (`inner` flips it into fighter space). */
function path(out: Vector3, keys: readonly Key[], t: number, inner: Side) {
  const time = (i: number) => keys[i][0];
  return out.set(
    inner * cr(t, keys.length, time, (i) => keys[i][1]),
    cr(t, keys.length, time, (i) => keys[i][2]),
    cr(t, keys.length, time, (i) => keys[i][3]),
  );
}

const arm = (s: Side) => (s === 1 ? (['lShoulder', 'lElbow', 'lWrist'] as const) : (['rShoulder', 'rElbow', 'rWrist'] as const));

/**
 * Put a hand at `target`. The elbow hangs down and back with the hand low, and swings out to the side as the hand goes
 * up past the shoulder (unless `hint` says where it goes).
 */
function reach(p: Pose, s: Side, target: Vector3, hint?: Vector3) {
  const [sh, el, wr] = arm(s);
  if (!hint) {
    const up = clamp01((target.y - p[sh].y + 0.05) / 0.2);
    hint = pole.set(s * (0.5 + 0.5 * up), -1 + 1.3 * up, -0.5 + 0.2 * up);
  }
  solve(p[sh], target, UPPER_ARM, FOREARM, hint, p[el], p[wr]);
}

/** `reach`, eased on by `k`: the hand moves `k` of the way from where it is now to `target`. */
function reachFrom(p: Pose, s: Side, target: Vector3, hint: Vector3 | undefined, k: number) {
  if (k <= 0) return;
  reach(p, s, target.lerpVectors(p[arm(s)[2]], target, Math.min(1, k)), hint);
}

/** Bend both knees to reach the feet where they are now (after moving the hips or the feet). */
function plant(p: Pose) {
  pole.set(0, 0, 1);
  solve(p.lHip, a.copy(p.lAnkle), THIGH, SHIN, pole, p.lKnee, p.lAnkle);
  solve(p.rHip, a.copy(p.rAnkle), THIGH, SHIN, pole, p.rKnee, p.rAnkle);
}

/**
 * Make every limb its own length again, keeping where its end is and which way its middle joint points: blends between
 * poses and the lean's shear stretch them a little.
 */
function rebuild(p: Pose) {
  for (const [root, mid, end, l1, l2] of LIMBS) {
    a.copy(p[end]);
    b.copy(p[mid]).sub(p[root]);
    solve(p[root], a, l1, l2, b, p[mid], p[end]);
  }
}
const LIMBS = [
  ['lShoulder', 'lElbow', 'lWrist', UPPER_ARM, FOREARM],
  ['rShoulder', 'rElbow', 'rWrist', UPPER_ARM, FOREARM],
  ['lHip', 'lKnee', 'lAnkle', THIGH, SHIN],
  ['rHip', 'rKnee', 'rAnkle', THIGH, SHIN],
] as const;

/** Shift the hips and everything above sideways, feet planted. */
function sway(p: Pose, dx: number) {
  for (const j of JOINTS) if (j !== 'lAnkle' && j !== 'rAnkle' && j !== 'lKnee' && j !== 'rKnee') p[j].x += dx;
  plant(p);
}

function blend(dst: Pose, src: Pose, k: number, joints: readonly JointName[] = JOINTS) {
  if (k <= 0) return;
  for (const j of joints) dst[j].lerp(src[j], Math.min(1, k));
}

/** The beat's bounce: 1 down on the beat, 0 up between. */
function dip(clock: number) {
  const c = Math.cos((2 * Math.PI * clock) / BEAT);
  return ((1 + c) / 2) ** 2;
}

/** A relaxed stand, square to the front: feet apart, arms hanging, breathing. */
export function stand(p: Pose, clock: number) {
  copyPose(p, GUARD_POSE);
  p.lAnkle.set(0.09, 0.03, 0.01);
  p.rAnkle.set(-0.09, 0.03, -0.01);
  crouch(p, 0.012);
  const breathe = Math.sin(clock * 2 * Math.PI * 0.32);
  for (const j of ['neck', 'head', 'lShoulder', 'rShoulder'] as const) p[j].y += 0.004 * breathe;
  for (const s of [1, -1] as const) reach(p, s, a.copy(p[arm(s)[0]]).add(b.set(s * 0.05, -0.27, 0.03)));
}

/**
 * Walking up to the mark, a step on every beat: `clock` seconds of the music's beat, `amount` 0..1 (0 = standing),
 * `swagger` 0..1 how much the hips roll and the shoulders and arms swing with it.
 */
export function walk(p: Pose, clock: number, amount: number, swagger: number) {
  if (amount <= 0) return;
  const phase = (Math.PI * clock) / BEAT;
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  p.lAnkle.z += 0.12 * s * amount;
  p.rAnkle.z -= 0.12 * s * amount;
  p.lAnkle.y += 0.06 * Math.max(0, c) * amount;
  p.rAnkle.y += 0.06 * Math.max(0, -c) * amount;
  // Down onto each step, the hips rolling over the planted foot, the shoulders rolling against them.
  crouch(p, (0.01 + 0.03 * swagger) * s * s * amount);
  sway(p, 0.035 * swagger * c * amount);
  twist(p, (0.1 + 0.12 * swagger) * s * amount);
  lean(p, 0.012 * swagger * amount, -0.02 * swagger * c * amount);
  for (const sd of [1, -1] as const) {
    const swing = -s * sd * amount;
    reach(p, sd, a.copy(p[arm(sd)[0]]).add(b.set(sd * (0.06 + 0.05 * swagger), -0.25 + 0.05 * swagger * Math.max(0, swing), 0.03 + (0.09 + 0.08 * swagger) * swing)));
  }
  p.head.x -= 0.014 * swagger * c * amount;
  plant(p);
}

/** Waiting for their turn: a light groove, hands loose in front, the head and shoulders on the beat. */
export function groove(p: Pose, clock: number, inner: Side) {
  const d = dip(clock);
  const roll = Math.sin((Math.PI * clock) / BEAT);
  crouch(p, 0.008 + 0.012 * d);
  sway(p, 0.012 * roll);
  for (const s of [1, -1] as const) {
    const [sh] = arm(s);
    p[sh].y += 0.006 * roll * s;
    reach(p, s, a.set(s * 0.12, 0.6 + 0.012 * d, 0.12 + 0.01 * roll * s));
  }
  p.head.y -= 0.008 * d;
  p.head.x += inner * 0.006;
}

/** Rolling hands: each hand circles about the line across the chest, half a turn apart. */
function rolling(hand: Vector3, t: number, s: Side, amount: number) {
  if (amount <= 0) return;
  const phi = 2 * Math.PI * 4 * t + (s === 1 ? 0 : Math.PI);
  hand.y += 0.04 * Math.sin(phi) * amount;
  hand.z += 0.04 * Math.cos(phi) * amount;
}

/** Elbows out and down for hands working in front of the chest. */
const chestHint = (s: Side) => pole.set(s, -0.7, -0.3);

// --- Fighter 1: the arm up, the sweep, the finger wag, the hands up (their shot, ~2.6 s; walking in before 0) ---

const SHOW_OUTER: readonly Key[] = [
  [-0.75, -0.17, 0.53, 0.05], [-0.45, -0.25, 0.73, 0.1], [-0.2, -0.15, 1.02, 0.05], [0, -0.07, 1.06, 0.02],
  [0.12, 0.02, 0.99, 0.1], [0.27, 0.11, 0.72, 0.18], [0.4, 0.07, 0.58, 0.16], [0.55, -0.36, 0.76, 0.12],
  [0.7, -0.36, 0.78, 0.1], [0.85, -0.04, 0.68, 0.17], [1.25, -0.04, 0.68, 0.17], [1.35, -0.1, 0.6, 0.14],
  [1.5, -0.13, 0.83, 0.22], [2, -0.13, 0.83, 0.22], [2.12, -0.16, 0.72, 0.16], [2.25, -0.35, 1.04, 0.1],
  [2.45, -0.37, 1.06, 0.08], [2.61, -0.28, 0.84, 0.12],
];
const SHOW_INNER: readonly Key[] = [
  [-0.1, 0.17, 0.54, 0.06], [0.1, 0.16, 0.58, 0.1], [0.3, 0.13, 0.62, 0.15], [0.55, 0.11, 0.64, 0.17],
  [0.85, 0.04, 0.66, 0.17], [1.25, 0.04, 0.66, 0.17], [1.38, 0.14, 0.56, 0.06], [1.5, 0.14, 0.53, 0],
  [2.05, 0.14, 0.53, 0], [2.25, 0.35, 1.04, 0.1], [2.45, 0.37, 1.06, 0.08], [2.61, 0.28, 0.84, 0.12],
];
const SHOW_TWIST: readonly Num[] = [
  [-0.6, 0], [-0.2, -0.12], [0, -0.15], [0.15, 0.05], [0.3, 0.35], [0.45, 0.22], [0.58, -0.3], [0.75, -0.18],
  [0.9, 0], [1.25, 0], [1.5, -0.12], [2, -0.1], [2.25, 0], [2.61, 0],
];
const SHOW_LEAN: readonly Num[] = [
  [-0.6, 0], [-0.2, -0.02], [0, -0.035], [0.3, 0.045], [0.45, 0.03], [0.6, -0.01], [0.9, 0.02], [1.25, 0.02],
  [1.5, -0.03], [2, -0.035], [2.25, -0.06], [2.45, -0.065], [2.61, -0.04],
];
const SHOW_SIDE: readonly Num[] = [[-0.6, 0], [-0.2, 0.015], [0, 0.02], [0.3, -0.01], [0.6, 0.02], [0.9, 0], [1.5, 0.015], [2, 0.015], [2.3, 0]];
const SHOW_SINK: readonly Num[] = [[-0.3, 0], [0, 0], [0.3, 0.045], [0.5, 0.02], [0.9, 0.01], [2.1, 0.01], [2.25, 0.025], [2.61, 0.01]];

function showoff(p: Pose, u: number, clock: number, inner: Side) {
  const outer = -inner as Side;
  crouch(p, curve(SHOW_SINK, u) + 0.012 * dip(clock) * ramp(u, -0.2, 0.3));
  sway(p, 0.018 * Math.sin((Math.PI * clock) / BEAT) * ramp(u, -0.2, 0.3));
  // Each arm eases on from the walk's swing: the outer one rising overhead as they walk, the inner one at the mark.
  const hand = path(a, SHOW_OUTER, u, inner);
  rolling(hand, u - 0.85, outer, span(u, 0.85, 1.25, 0.08));
  // The finger wag: tsk, tsk, in front of the face.
  hand.x += 0.035 * Math.sin(2 * Math.PI * 4.6 * (u - 1.55)) * span(u, 1.55, 2, 0.08);
  reachFrom(p, outer, hand, u > 0.75 && u < 1.3 ? chestHint(outer) : undefined, ramp(u, -0.75, 0.3));
  const h = path(a, SHOW_INNER, u, inner);
  rolling(h, u - 0.85, inner, span(u, 0.85, 1.25, 0.08));
  const onHip = span(u, 1.5, 2.05, 0.12);
  reachFrom(p, inner, h, onHip > 0.5 ? pole.set(inner, 0.1, -0.6) : u > 0.75 && u < 1.3 ? chestHint(inner) : undefined, ramp(u, -0.1, 0.25));
  twist(p, inner * curve(SHOW_TWIST, u));
  lean(p, curve(SHOW_LEAN, u), inner * curve(SHOW_SIDE, u));
  const wag = span(u, 1.55, 2, 0.08);
  p.head.x -= 0.008 * Math.sin(2 * Math.PI * 4.6 * (u - 1.55)) * wag;
  p.head.x += inner * 0.01 * span(u, 1.5, 2.05, 0.15);
  const laugh = span(u, 2.2, 2.6, 0.12);
  p.head.y += 0.006 * laugh;
  p.head.z -= 0.025 * laugh;
}

// --- Fighter 2: the arm up, a full spin, chin up (their shot, ~2.6 s) ---

const SPIN_OUTER: readonly Key[] = [
  [0, -0.17, 0.54, 0.06], [0.35, -0.25, 0.78, 0.12], [0.7, -0.11, 1.04, 0.02], [0.95, -0.05, 1.04, -0.05],
  [1.2, -0.34, 0.86, 0.04], [1.7, -0.34, 0.86, 0.04], [1.95, -0.2, 0.7, 0.12], [2.12, -0.04, 0.7, 0.16],
  [2.35, -0.03, 0.71, 0.17], [2.61, 0.1, 0.75, 0.2],
];
const SPIN_INNER: readonly Key[] = [
  [0, 0.17, 0.54, 0.06], [0.7, 0.13, 0.62, 0.12], [0.95, 0.08, 0.66, 0.16], [1.95, 0.08, 0.66, 0.16],
  [2.12, 0.14, 0.55, 0.03], [2.61, 0.14, 0.53, 0],
];
const SPIN_TWIST: readonly Num[] = [[0, 0], [0.6, 0.15], [0.95, -0.1], [1.4, -0.2], [1.95, 0], [2.35, 0.05], [2.61, 0.2]];
const SPIN_LEAN: readonly Num[] = [[0, 0], [0.7, -0.02], [0.95, 0.01], [1.95, 0], [2.2, -0.03], [2.61, -0.02]];
const SPIN_SINK: readonly Num[] = [[0, 0.01], [0.8, 0.035], [1.1, 0], [1.8, 0], [2, 0.025], [2.3, 0.01]];

function spin(p: Pose, body: Body, v: number, clock: number, inner: Side) {
  const outer = -inner as Side;
  crouch(p, curve(SPIN_SINK, v) + 0.01 * dip(clock) * (1 - span(v, 0.9, 1.95, 0.1)));
  // Up on the ball of the inner foot, the outer knee lifted, for the turn.
  const pirouette = span(v, 1.05, 1.85, 0.15);
  const foot = outer === 1 ? p.lAnkle : p.rAnkle;
  foot.y += 0.1 * pirouette;
  foot.z += 0.04 * pirouette;
  foot.x -= outer * 0.04 * pirouette;
  plant(p);
  reach(p, outer, path(a, SPIN_OUTER, v, inner));
  reach(p, inner, path(a, SPIN_INNER, v, inner), v > 2 ? pole.set(inner, 0.1, -0.6) : chestHint(inner));
  twist(p, inner * curve(SPIN_TWIST, v));
  lean(p, curve(SPIN_LEAN, v));
  const chin = ramp(v, 1.95, 0.25);
  p.head.y += 0.008 * chin;
  p.head.z -= 0.015 * chin;
  // The spin itself, toward the raised arm.
  body.turn += outer * 2 * Math.PI * easeInOut((v - 0.95) / 1.0);
}

// --- The two-shot: fighter 1's handstand freeze, fighter 2's rolling hands and quick spin (~2.6 s) ---

// Arms wide overhead in a V going over (a cartwheel's star), closer in for the handstand itself.
const FREEZE_OUTER: readonly Key[] = [
  [0, -0.17, 0.55, 0.06], [0.3, -0.2, 0.52, -0.06], [0.4, -0.25, 1.0, 0.02], [0.62, -0.15, 1.04, 0.02],
  [1.3, -0.15, 1.04, 0.02], [1.38, -0.25, 1.0, 0.02], [1.5, -0.27, 0.95, 0.04], [1.62, -0.28, 0.78, 0.1],
  [1.95, -0.06, 0.95, -0.02], [2.61, -0.05, 0.95, -0.02],
];
const FREEZE_INNER: readonly Key[] = [
  [0, 0.17, 0.55, 0.06], [0.3, 0.24, 0.3, 0.16], [0.4, 0.25, 1.0, 0.02], [0.62, 0.15, 1.04, 0.02],
  [1.3, 0.15, 1.04, 0.02], [1.38, 0.25, 1.0, 0.02], [1.5, 0.27, 0.95, 0.04], [1.62, 0.28, 0.78, 0.1],
  [1.95, 0.36, 0.8, 0.14], [2.25, 0.38, 0.8, 0.16], [2.32, 0.37, 0.82, 0.21], [2.42, 0.38, 0.8, 0.15], [2.61, 0.38, 0.8, 0.15],
];
const FREEZE_SINK: readonly Num[] = [[0, 0], [0.3, 0.16], [0.4, 0.04], [0.5, 0], [1.48, 0], [1.6, 0.13], [1.85, 0.05], [2.61, 0.035]];
const FREEZE_LEAN: readonly Num[] = [[0, 0], [0.3, 0.08], [0.4, 0], [1.48, 0], [1.62, 0.06], [1.9, 0], [2.61, -0.01]];
const FREEZE_SIDE: readonly Num[] = [[1.95, 0], [2.2, -0.035], [2.61, -0.035]];
const FREEZE_TWIST: readonly Num[] = [[0, 0], [0.3, 0.15], [0.4, 0], [1.95, 0], [2.2, 0.1], [2.61, 0.12]];
/** The wheel: kick up to upside down, hold the freeze, over onto the feet on the far side. */
const FREEZE_ROLL: readonly Num[] = [[0.38, 0], [0.5, 0.9], [0.6, Math.PI], [1.3, Math.PI], [1.4, 1.5 * Math.PI], [1.5, 2 * Math.PI]];
const FREEZE_TRAVEL: readonly Num[] = [[0, 0], [0.38, 0], [1, 0.5], [1.5, 1]];

function freeze(p: Pose, body: Body, w: number, clock: number, inner: Side) {
  const outer = -inner as Side;
  crouch(p, curve(FREEZE_SINK, w) + 0.01 * dip(clock) * ramp(w, 1.9, 0.3));
  // Going over: legs wide like a star; upside down, split in a V and scissoring.
  const legs = span(w, 0.4, 1.48, 0.06);
  if (legs > 0) {
    const sc = Math.sin((2 * Math.PI * (w - 0.62)) / 0.6) * span(w, 0.62, 1.3, 0.1);
    const wide = 0.26 + 0.07 * (1 - span(w, 0.6, 1.3, 0.08));
    for (const s of [1, -1] as const) {
      const ankle = s === 1 ? p.lAnkle : p.rAnkle;
      ankle.lerp(a.set(s * wide, 0.12, s * inner * 0.14 * sc), legs);
    }
    plant(p);
  }
  reach(p, outer, path(a, FREEZE_OUTER, w, inner), w > 1.8 ? pole.set(outer, 0.6, -0.4) : undefined);
  reach(p, inner, path(a, FREEZE_INNER, w, inner));
  twist(p, inner * curve(FREEZE_TWIST, w));
  lean(p, curve(FREEZE_LEAN, w), inner * curve(FREEZE_SIDE, w));
  const smirk = ramp(w, 1.95, 0.2);
  p.head.y -= 0.008 * smirk;
  p.head.x += outer * 0.008 * smirk;
  // Wheeling over toward the other fighter: the head goes over first.
  const roll = curve(FREEZE_ROLL, w) + 0.05 * Math.sin(2 * Math.PI * 1.7 * (w - 0.62)) * span(w, 0.66, 1.26, 0.08);
  body.roll += -inner * (roll >= 2 * Math.PI - 1e-4 ? 0 : roll);
}

const COOL_OUTER: readonly Key[] = [
  [0, 0.1, 0.75, 0.2], [0.15, -0.03, 0.7, 0.17], [0.5, -0.03, 0.7, 0.17], [0.6, -0.04, 0.67, 0.17],
  [1.4, -0.04, 0.67, 0.17], [1.48, -0.2, 0.8, 0.08], [1.75, -0.2, 0.8, 0.08], [1.9, -0.1, 0.88, 0.17],
  [2.1, -0.1, 0.88, 0.17], [2.22, -0.22, 0.93, 0.2], [2.35, -0.12, 0.88, 0.17], [2.61, -0.12, 0.88, 0.17],
];
const COOL_INNER: readonly Key[] = [
  [0, 0.14, 0.53, 0], [0.5, 0.14, 0.53, 0], [0.6, 0.04, 0.66, 0.17], [1.4, 0.04, 0.66, 0.17],
  [1.48, 0.2, 0.8, 0.08], [1.75, 0.2, 0.8, 0.08], [1.9, 0.14, 0.53, 0], [2.61, 0.14, 0.53, 0],
];
const COOL_SINK: readonly Num[] = [[0, 0.01], [1.4, 0.03], [1.5, 0], [1.8, 0], [1.9, 0.02], [2.61, 0.01]];
const COOL_LEAN: readonly Num[] = [[0, -0.02], [0.5, -0.02], [1.4, 0.01], [1.9, -0.03], [2.61, -0.03]];
const COOL_TWIST: readonly Num[] = [[0, 0.2], [0.3, 0], [1.9, 0], [2.2, -0.1], [2.61, -0.08]];

function cool(p: Pose, body: Body, w: number, clock: number, inner: Side) {
  const outer = -inner as Side;
  crouch(p, curve(COOL_SINK, w) + 0.012 * dip(clock) * (1 - span(w, 1.45, 1.8, 0.05)));
  sway(p, 0.014 * Math.sin((Math.PI * clock) / BEAT));
  const rolls = span(w, 0.62, 1.4, 0.08);
  const ho = path(a, COOL_OUTER, w, inner);
  rolling(ho, w, outer, rolls);
  reach(p, outer, ho, w < 1.45 ? chestHint(outer) : w > 1.85 ? pole.set(outer, -0.3, -0.5) : undefined);
  const hi = path(b, COOL_INNER, w, inner);
  rolling(hi, w, inner, rolls);
  reach(p, inner, hi, w < 0.55 || w > 1.85 ? pole.set(inner, 0.1, -0.6) : chestHint(inner));
  twist(p, inner * curve(COOL_TWIST, w));
  lean(p, curve(COOL_LEAN, w));
  p.head.y += 0.008 * ramp(w, 1.85, 0.2);
  body.turn += outer * 2 * Math.PI * easeInOut((w - 1.45) / 0.36);
}

/** Seconds into a stretch from `from` to `to`, scaled so the keyed `len` seconds fit it (a custom track's beats). */
const local = (t: number, from: number, to: number, len = 2.61) => ((t - from) * len) / Math.max(0.4, to - from);

/**
 * Fighter `id`'s pose and trick motion `t` seconds into the walkout, everything but the fight stance at the end (the
 * director blends into that). `p` gets the pose; `body` the whole-body motion. Pure: the same `t` gives the same frame
 * on both laptops.
 */
export function perform(p: Pose, body: Body, id: PlayerId, t: number, B: Beats) {
  const inner: Side = id === 'p1' ? 1 : -1;
  const clock = t - B.open;
  body.slide = body.lift = body.turn = body.roll = 0;
  stand(p, t + (id === 'p2' ? 1.3 : 0));
  const walkEnd = B.p1 - 0.25;
  walk(p, clock + (id === 'p2' ? BEAT * 0.5 : 0), 1 - ramp(t, walkEnd - 0.4, 0.4), id === 'p1' ? 1 : 0.55);
  copyPose(base, p);
  if (id === 'p1') {
    // Their act from the walk to the cut; then (out of shot) a groove while they step out for the freeze; the freeze.
    if (t < B.p2 + 0.3) showoff(p, local(t, B.p1, B.p2), clock, inner);
    const waiting = span(t, B.p2 + 0.3, B.two, 0.3);
    if (waiting > 0) {
      copyPose(layer, base);
      groove(layer, clock, inner);
      if (t >= B.two) copyPose(p, base);
      blend(p, layer, waiting);
    }
    if (t >= B.two) {
      const w = local(t, B.two, B.vs);
      copyPose(layer, p);
      copyPose(p, base);
      freeze(p, body, w, clock, inner);
      blend(p, layer, 1 - ramp(w, 0, 0.2));
    }
  } else {
    // A groove once they're on their mark, until their shot: the spin; then the two-shot.
    const act = ramp(t, B.p2 - 0.15, 0.15);
    if (act < 1) {
      copyPose(layer, base);
      groove(layer, clock, inner);
      blend(p, layer, (1 - act) * ramp(t, B.p1 - 0.6, 0.5));
    }
    if (t >= B.p2 - 0.15 && t < B.two) {
      copyPose(layer, base);
      spin(layer, body, local(t, B.p2, B.two), clock, inner);
      blend(p, layer, act);
    } else if (t >= B.two) {
      copyPose(p, base);
      cool(p, body, local(t, B.two, B.vs), clock, inner);
    }
  }
  rebuild(p);
  body.spot = spotOf(id, t, B);
  body.slide += body.spot;
  if (body.roll) ground(p, body);
}

/**
 * Where fighter `id` stands, sideways from their mark (fighter units, +x their left): out from each other for the
 * walkout, fighter 1 further out while lining up the freeze and wheeling back in, both back on the mark under the fire.
 */
export function spotOf(id: PlayerId, t: number, B: Beats) {
  const inner: Side = id === 'p1' ? 1 : -1;
  let away = 0;
  if (id === 'p1') away = t >= B.two ? 1 - curve(FREEZE_TRAVEL, local(t, B.two, B.vs)) : ramp(t, B.p2 + 0.3, 0.6);
  const home = 1 - ramp(t, B.vs + 0.1, Math.max(0.2, B.end - B.vs - 0.3));
  return -inner * (SPREAD + FREEZE_FROM * away) * home;
}

/**
 * The roll turns the body about its hips, not its feet: move it so it does, and so its lowest point stays on the floor
 * (hands down in the handstand, feet down as it comes over).
 */
function ground(p: Pose, body: Body) {
  pivot.copy(p.lHip).add(p.rHip).multiplyScalar(0.5);
  quat.setFromEuler(euler.set(0, body.turn, body.roll));
  moved.copy(pivot).applyQuaternion(quat);
  body.slide += pivot.x - moved.x;
  body.lift += pivot.y - moved.y;
  let low = Infinity;
  for (const j of JOINTS) low = Math.min(low, moved.copy(p[j]).applyQuaternion(quat).y);
  const upright = Math.min(Math.abs(body.roll) % (2 * Math.PI), 2 * Math.PI - (Math.abs(body.roll) % (2 * Math.PI)));
  // Sideways (going over), the body's up off the floor a little: it springs through, it doesn't lie down.
  const spring = 0.12 * Math.sin(body.roll) ** 2;
  body.lift += (FLOOR + spring - (low + body.lift)) * smoothstep(upright / 0.3);
}
