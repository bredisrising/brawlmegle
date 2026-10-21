import { Vector3 } from 'three';
import type { FighterState, Hand } from '../types';
import { GUARD_POSE, JOINTS, copyPose, type JointName, type Pose } from './pose';

/**
 * The arcade layer of the director: draws what the engine decided. A fighter stands in a bouncing guard, and when
 * the engine starts a move, the move plays on the frames the engine gives it: wind-up over startup, full
 * extension on the active frames (so the fist lands on the frame the hit lands), back to guard over recovery.
 * Hits snap the head the way the punch pushed it, blocks cover up, evades duck and slip, a K.O. falls over.
 *
 * Players don't puppet their fighter 1:1 (that's the wobbly VR look). Their live pose is blended in lightly by the
 * view for personality; every real move comes from here. Everything is in fighter-local space (see pose.ts):
 * 1 m tall, feet at y = 0, +z toward the opponent, +x is the fighter's left.
 */

const UPPER: readonly JointName[] = ['head', 'neck', 'lShoulder', 'rShoulder', 'lElbow', 'rElbow', 'lWrist', 'rWrist'];
const UPPER_ARM = GUARD_POSE.lShoulder.distanceTo(GUARD_POSE.lElbow);
const FOREARM = GUARD_POSE.lElbow.distanceTo(GUARD_POSE.lWrist);
const ARM = UPPER_ARM + FOREARM;
const THIGH = GUARD_POSE.lHip.distanceTo(GUARD_POSE.lKnee);
const SHIN = GUARD_POSE.lKnee.distanceTo(GUARD_POSE.lAnkle);
export const HIP_HEIGHT = GUARD_POSE.lHip.y;
const NECK_ABOVE_HIP = GUARD_POSE.neck.y - HIP_HEIGHT;
/** Head height to aim at, and where the fist meets the face (head radius). */
const AIM = { head: 0.86, body: 0.64 } as const;
const FACE = 0.07;
/** Farthest the whole body steps in to land a strike (local m). Past that it falls short: a whiff. */
const MAX_LUNGE = 0.24;

/** How much bigger a heavy's wind-up is (fist drawn back, torso turned away). */
const HEAVY_LOAD = 2.4;

/** Per-move shape: how much of startup is wind-up, how far the torso turns and leans in. */
const STRIKES = {
  jab: { wind: 0.2, twist: 0.25, lean: 0.03 },
  cross: { wind: 0.3, twist: 0.8, lean: 0.06 },
  hook: { wind: 0.35, twist: 0.75, lean: 0.05 },
  uppercut: { wind: 0.4, twist: 0.35, lean: 0.03 },
  knee: { wind: 0.35, twist: 0.15, lean: -0.02 },
  kick: { wind: 0.4, twist: 0.2, lean: -0.07 },
} as const;
type StrikeMove = keyof typeof STRIKES;

/** The last hit a fighter took, for the shape of the reaction. */
export type HitInfo = { move: string; hand?: Hand; height?: 'head' | 'body'; strength: number };

/** Whole-body motion the view applies to the fighter's body group (local units / radians). */
export type Motion = {
  /** Step toward the opponent (+z), for lunging strikes. */
  lunge: number;
  /** Rotation about the feet: + leans forward, - back (a K.O. ends at about -π/2, flat on the back). */
  tilt: number;
  /** Lift off the floor (a K.O.'d body's thickness). */
  lift: number;
  /** Sideways (+x, the fighter's left), a turn about the feet, and a roll about the facing axis: the walkout's tricks. */
  slide: number;
  turn: number;
  roll: number;
};

export type ActionInput = {
  state: Readonly<FighterState>;
  /** Center-to-center distance to the opponent, in this fighter's local units. */
  reach: number;
  hit: HitInfo | null;
  won: number;
  /** 0..1 smoothed evades (the view eases them in and out). */
  duck: number;
  slip: number; // -1 (to the fighter's right) .. 1 (left)
  /** 0..1 progress of a wind-up tell before an attack ('anticipate'), and its hand. */
  tell: number;
  tellHand: Hand;
  /** Seconds into the round-start countdown (the ready taunt), or 0. */
  intro: number;
  /** 0..1: how beaten up they are (low HP): slumped, guard sagging, breathing hard. */
  hurt: number;
  lead: 1 | -1;
  /** The view's running clock (s), for breathing. */
  clock: number;
};

const tA = new Vector3();
const tB = new Vector3();
const tC = new Vector3();
const tD = new Vector3();
const pole = new Vector3();

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const smooth = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
const easeIn = (t: number) => clamp01(t) ** 2;
const sideOf = (hand: Hand | undefined) => (hand === 'L' ? 1 : -1);

/**
 * The fighting stance: bladed like a Street Fighter character, lead shoulder and lead foot toward the opponent,
 * rear hand by the chin, and alive: a bounce on the knees, fists bobbing out of step, weight rolling side to side.
 * `lead` 1 leads with the left side (P1), -1 with the right (P2), so both fighters show their chest to the camera.
 * `time` in seconds; `step` 0..1 is how fast they're moving along the fight line, `stepPhase` the shuffle's phase.
 */
export function stance(out: Pose, time: number, guardHigh: number, step = 0, stepPhase = 0, lead: 1 | -1 = 1): Pose {
  copyPose(out, GUARD_POSE);
  const [leadAnkle, rearAnkle] = lead === 1 ? (['lAnkle', 'rAnkle'] as const) : (['rAnkle', 'lAnkle'] as const);
  const [leadWrist, rearWrist] = lead === 1 ? (['lWrist', 'rWrist'] as const) : (['rWrist', 'lWrist'] as const);
  const [leadElbow, rearElbow] = lead === 1 ? (['lElbow', 'rElbow'] as const) : (['rElbow', 'lElbow'] as const);
  const leadShoulder = lead === 1 ? 'lShoulder' : 'rShoulder';
  // Feet staggered: lead foot forward, rear foot back.
  out[leadAnkle].set(lead * 0.075, 0.03, 0.11);
  out[rearAnkle].set(-lead * 0.08, 0.03, -0.1);
  // Moving: feet shuffle, the lifted one comes off the floor.
  if (step > 0) {
    const s = Math.sin(stepPhase);
    out[leadAnkle].z += 0.035 * s * step;
    out[rearAnkle].z -= 0.035 * s * step;
    out[leadAnkle].y += 0.03 * Math.max(0, s) * step;
    out[rearAnkle].y += 0.03 * Math.max(0, -s) * step;
  }
  // Bladed: hips turned a little, shoulders more; the lead hand sits out front, the rear hand guards the chin.
  turnHips(out, -lead * 0.3);
  twist(out, -lead * 0.55);
  out[leadWrist].z += 0.03;
  out[leadWrist].y -= 0.01;
  out[rearWrist].x += lead * 0.02;

  // Life: a bounce on the knees, fists bobbing out of step with it, weight rolling side to side, head riding along.
  const beat = time * 2 * Math.PI * (1.8 + step * 0.8);
  shift(out, 0.012 * Math.sin(time * 2 * Math.PI * 0.45), 0);
  out[leadWrist].y += 0.014 * Math.sin(beat + 0.9);
  out[leadElbow].y += 0.007 * Math.sin(beat + 0.9);
  out[rearWrist].y += 0.012 * Math.sin(beat + 2.6);
  out[rearElbow].y += 0.006 * Math.sin(beat + 2.6);
  out[leadShoulder].y += 0.008 * Math.sin(beat + 1.4);
  out.head.y += 0.006 * Math.sin(beat - 0.7);
  out.head.x += 0.006 * Math.sin(time * 2 * Math.PI * 0.45 - 0.5);
  crouch(out, 0.024 + 0.016 * Math.sin(beat));
  if (guardHigh > 0) highGuard(out, guardHigh);
  return out;
}

/** Turn the hips about the vertical through their middle (+ brings the right hip forward). */
function turnHips(p: Pose, angle: number) {
  const c = hipMid(p, tA);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (const j of ['lHip', 'rHip'] as const) {
    const v = p[j];
    const x = v.x - c.x;
    const z = v.z - c.z;
    v.x = c.x + x * cos + z * sin;
    v.z = c.z - x * sin + z * cos;
  }
}

/** Hands up in front of the face, elbows tucked: blocking. */
export function highGuard(p: Pose, amount: number) {
  for (const s of [1, -1] as const) {
    const [elbow, wrist] = s === 1 ? (['lElbow', 'lWrist'] as const) : (['rElbow', 'rWrist'] as const);
    p[wrist].lerp(tA.set(s * 0.055, 0.87, 0.12), amount);
    p[elbow].lerp(tA.set(s * 0.1, 0.7, 0.09), amount);
  }
}

/**
 * Layer the engine's action onto `pose` (a stance, maybe blended with the live pose) and fill `motion`.
 * Order: evades, then the attack (torso turn, lean, the striking limb), then reactions (hit, block), then K.O.
 */
export function applyAction(pose: Pose, input: ActionInput, motion: Motion): Pose {
  motion.lunge = 0;
  motion.tilt = 0;
  motion.lift = 0;
  motion.slide = 0;
  motion.turn = 0;
  motion.roll = 0;
  const { state } = input;

  if (input.hurt > 0 && state.phase !== 'ko') beatUp(pose, input.hurt, input.clock);
  if (input.intro > 0 && state.phase === 'idle') ready(pose, input.intro, input.lead);
  if (input.duck > 0) {
    crouch(pose, 0.13 * input.duck);
    lean(pose, 0.05 * input.duck);
  }
  if (input.slip !== 0) {
    const a = Math.abs(input.slip);
    shift(pose, 0.09 * input.slip, 0);
    twist(pose, -0.25 * input.slip);
    crouch(pose, 0.03 * a);
  }
  if (input.tell > 0 && state.phase === 'idle') tell(pose, input.tell, input.tellHand);

  if (state.move === 'fireball' && (state.phase === 'startup' || state.phase === 'active' || state.phase === 'recovery')) {
    fireball(pose, state, input.lead, motion);
  }
  const move = state.move as StrikeMove | undefined;
  if (move && move in STRIKES && (state.phase === 'startup' || state.phase === 'active' || state.phase === 'recovery')) {
    strike(pose, move, state, input.reach, motion);
  }

  const L = Math.max(1, state.length ?? 1);
  const p = clamp01(state.frame / L);
  if (state.phase === 'hitstun' && input.hit) react(pose, input.hit, p, motion);
  if (state.phase === 'blockstun') {
    const r = p < 0.2 ? smooth(p / 0.2) : 1 - smooth((p - 0.2) / 0.8);
    highGuard(pose, 1);
    lean(pose, -0.035 * r);
    motion.tilt -= 0.05 * r;
  }
  if (input.won > 0) victory(pose, input.won, input.lead, motion);
  return pose;
}

/** Ext: -1 full wind-up, 0 guard, 1 full extension. Weight: how much the strike overrides the base pose. */
function strikeCurve(move: StrikeMove, st: Readonly<FighterState>) {
  const L = Math.max(1, st.length ?? 1);
  const p = clamp01(st.frame / L);
  // A heavy spends more of its (longer) startup coiled up: the opponent should see it coming.
  const wind = st.heavy ? Math.min(0.8, STRIKES[move].wind * 1.6) : STRIKES[move].wind;
  if (st.phase === 'startup') {
    const ext = p < wind ? -smooth(p / wind) : -1 + 2 * easeIn((p - wind) / (1 - wind));
    return { ext, weight: smooth(p / 0.15) };
  }
  if (st.phase === 'active') return { ext: 1, weight: 1 };
  return { ext: 1 - smooth(p / 0.85), weight: 1 - smooth((p - 0.55) / 0.45) };
}

function strike(pose: Pose, move: StrikeMove, st: Readonly<FighterState>, reach: number, motion: Motion) {
  const { ext, weight } = strikeCurve(move, st);
  if (weight <= 0) return;
  const spec = STRIKES[move];
  const s = sideOf(st.hand);
  const forward = Math.max(0, ext);
  const coil = Math.max(0, -ext);
  const aimY = AIM[st.height ?? 'head'];

  // Torso: coil away on the wind-up, turn the striking side through on the strike, lean in. A heavy loads up big:
  // turned well away and leaning back before it comes.
  const load = st.heavy ? HEAVY_LOAD : 1;
  twist(pose, -s * spec.twist * (forward - 0.35 * coil * load) * weight);
  lean(pose, (spec.lean * forward - (st.heavy ? 0.04 * coil : 0)) * weight);
  if (move === 'uppercut') crouch(pose, (0.05 * coil - 0.01 * forward) * weight);
  if (move === 'kick' || move === 'knee') crouch(pose, 0.02 * weight);

  if (move === 'knee' || move === 'kick') {
    const [hip, knee, ankle] = s === 1 ? (['lHip', 'lKnee', 'lAnkle'] as const) : (['rHip', 'rKnee', 'rAnkle'] as const);
    const H = pose[hip];
    const rest = tA.copy(pose[ankle]);
    // Knee: the foot tucks up under the hip, which drives the knee up and forward. Kick: chamber, then extend.
    const chamber = tB.set(H.x - s * 0.01, 0.3, H.z + 0.02);
    let target: Vector3;
    if (move === 'knee') target = chamber.lerp(rest, 1 - smooth(forward * 1.4));
    else {
      const out = tC.set(H.x - s * 0.02, 0.62, H.z + THIGH + SHIN - 0.02);
      const t = smooth(forward);
      target = t < 0.5 ? chamber.lerp(rest, 1 - t * 2) : chamber.lerp(out, (t - 0.5) * 2);
    }
    const tip = target.lerp(rest, 1 - weight);
    solve(H, tip, THIGH, SHIN, pole.set(0, 0.35, 1), pose[knee], pose[ankle]);
    // The strike's reach: knee or foot, whichever is out front.
    const front = move === 'knee' ? pose[knee].z : pose[ankle].z;
    motion.lunge = lungeFor(reach, front, forward * weight);
    return;
  }

  const [shoulder, elbow, wrist] = s === 1 ? (['lShoulder', 'lElbow', 'lWrist'] as const) : (['rShoulder', 'rElbow', 'rWrist'] as const);
  const S = pose[shoulder];
  const guard = tA.copy(pose[wrist]);
  // Where the fist ends up, and the path there.
  const end = tB;
  const ctrl = tC;
  if (move === 'hook') {
    end.set(-s * 0.03, aimY - 0.02, S.z + 0.22);
    ctrl.set(s * 0.24, aimY, S.z + 0.16);
    pole.set(s, 0.55, -0.1);
  } else if (move === 'uppercut') {
    end.set(s * 0.02, aimY, S.z + 0.19);
    ctrl.set(s * 0.06, 0.58, S.z + 0.22);
    pole.set(s * 0.35, -1, 0.15);
  } else {
    // Straights aim at the face from the shoulder: the arm points where the head is.
    end.set(-s * 0.01, aimY, reach).sub(S).normalize().multiplyScalar(ARM * 0.97).add(S);
    ctrl.copy(guard).lerp(end, 0.5);
    pole.set(s * 0.45, -1, -0.1);
  }
  const target = tD;
  if (ext >= 0) {
    // Quadratic Bézier guard -> ctrl -> end: hooks swing round, uppercuts scoop up, straights go straight.
    const t = ext;
    target.copy(guard).multiplyScalar((1 - t) * (1 - t)).addScaledVector(ctrl, 2 * (1 - t) * t).addScaledVector(end, t * t);
  } else {
    const back = move === 'hook' ? [s * 0.07, -0.02, -0.03] : move === 'uppercut' ? [s * 0.05, -0.17, -0.02] : [0, -0.01, -0.06];
    target.copy(guard).add(tC.set(back[0], back[1], back[2]).multiplyScalar(coil * load));
  }
  target.lerp(guard, 1 - weight);
  solve(S, target, UPPER_ARM, FOREARM, pole, pose[elbow], pose[wrist]);
  motion.lunge = lungeFor(reach, pose[wrist].z, forward * weight);
}

/**
 * The super: both fists drawn back to the rear hip and charged (the whole body coils and sinks), then both palms
 * shoved out at chest height on the release frame, leaning into it, held through the start of recovery.
 */
function fireball(pose: Pose, st: Readonly<FighterState>, lead: 1 | -1, motion: Motion) {
  const L = Math.max(1, st.length ?? 1);
  const p = clamp01(st.frame / L);
  let charge = 0;
  let push = 0;
  if (st.phase === 'startup') charge = smooth(p / 0.6);
  else if (st.phase === 'active') push = 1;
  else push = 1 - smooth((p - 0.35) / 0.65);
  const rear = -lead; // the rear side (+x is the fighter's left)
  if (charge > 0) {
    twist(pose, lead * 0.5 * charge); // coil: rear shoulder back
    crouch(pose, 0.05 * charge);
    lean(pose, -0.02 * charge);
  }
  if (push > 0) {
    twist(pose, -lead * 0.15 * push);
    crouch(pose, 0.03 * push);
    lean(pose, 0.06 * push);
  }
  for (const s of [1, -1] as const) {
    const [shoulder, elbow, wrist] = s === 1 ? (['lShoulder', 'lElbow', 'lWrist'] as const) : (['rShoulder', 'rElbow', 'rWrist'] as const);
    const hip = tA.set(rear * 0.13 + s * 0.035, 0.56, -0.03);
    const out = tB.set(s * 0.035, 0.74, pose[shoulder].z + ARM * 0.95);
    const target = tC.copy(pose[wrist]).lerp(hip, charge).lerp(out, push);
    solve(pose[shoulder], target, UPPER_ARM, FOREARM, pole.set(s * 0.6, -1, 0), pose[elbow], pose[wrist]);
  }
  motion.lunge += 0.04 * push;
}

/** Step in far enough for the strike to touch the opponent's face, up to MAX_LUNGE. */
function lungeFor(reach: number, tipZ: number, amount: number) {
  return clamp(reach - FACE - tipZ, 0, MAX_LUNGE) * amount;
}

/** The tell before an attack: coil the hand back, sink a little. */
function tell(pose: Pose, t: number, hand: Hand) {
  const s = sideOf(hand);
  const k = smooth(t);
  twist(pose, s * 0.18 * k);
  crouch(pose, 0.025 * k);
  pose[hand === 'L' ? 'lWrist' : 'rWrist'].add(tA.set(s * 0.02, -0.03, -0.05).multiplyScalar(k));
}

/** Getting hit: snap fast the way the blow pushed, then recover over the hitstun. */
function react(pose: Pose, hit: HitInfo, p: number, motion: Motion) {
  const r = (p < 0.12 ? smooth(p / 0.12) : 1 - smooth((p - 0.12) / 0.88)) * hit.strength;
  const body = hit.height === 'body' || hit.move === 'knee';
  // Arms fly loose.
  for (const s of [1, -1] as const) {
    const w = pose[s === 1 ? 'lWrist' : 'rWrist'];
    w.y -= (body ? 0.12 : 0.07) * r;
    w.x += s * 0.05 * r;
    w.z -= 0.02 * r;
  }
  if (body) {
    // Folds over the blow.
    crouch(pose, 0.06 * r);
    lean(pose, 0.1 * r);
    motion.tilt += 0.14 * r;
  } else if (hit.move === 'hook') {
    // A right hook lands on the defender's left cheek and turns the head to their right (-x).
    const s = hit.hand === 'L' ? 1 : -1;
    twist(pose, s * 0.6 * r);
    shift(pose, s * 0.06 * r, 0);
    pose.head.x += s * 0.07 * r;
    motion.tilt -= 0.07 * r;
  } else if (hit.move === 'uppercut') {
    pose.head.y += 0.04 * r;
    pose.head.z -= 0.09 * r;
    lean(pose, -0.1 * r);
    crouch(pose, -0.02 * r);
    motion.tilt -= 0.22 * r;
  } else {
    pose.head.z -= 0.08 * r;
    lean(pose, -0.1 * r);
    motion.tilt -= 0.17 * r;
  }
}

/**
 * Winning over a K.O.'d opponent, fighting-game style: turn to the camera, rear fist punched at the sky, lead fist
 * pulled to the hip, chin up, a little bounce, and the odd fist pump.
 */
function victory(pose: Pose, t: number, lead: 1 | -1, motion: Motion) {
  const k = smooth((t - 0.6) / 0.35);
  if (k <= 0) return;
  // Open up to the camera: turn further the way the blade already turns the chest (toward the camera).
  twist(pose, -lead * 0.5 * k);
  lean(pose, -0.03 * k);
  const pump = Math.max(0, Math.sin(t * 2 * Math.PI * 0.9)) ** 4; // a pump about once a second
  const [upS, upE, upW] = lead === 1 ? (['rShoulder', 'rElbow', 'rWrist'] as const) : (['lShoulder', 'lElbow', 'lWrist'] as const);
  const [hipS, hipE, hipW] = lead === 1 ? (['lShoulder', 'lElbow', 'lWrist'] as const) : (['rShoulder', 'rElbow', 'rWrist'] as const);
  const side = -lead; // the raised (rear) arm's side, +x = left
  const up = tA.set(pose[upS].x + side * 0.03, 1.12 + 0.03 * pump, pose[upS].z + 0.02).lerp(pose[upW], 1 - k);
  solve(pose[upS], up, UPPER_ARM, FOREARM, pole.set(side, -0.3, 0.3), pose[upE], pose[upW]);
  const hip = tB.set(pose[hipS].x + lead * 0.06, 0.55, pose[hipS].z + 0.04).lerp(pose[hipW], 1 - k);
  solve(pose[hipS], hip, UPPER_ARM, FOREARM, pole.set(lead, 0, -1), pose[hipE], pose[hipW]);
  pose.head.y += 0.01 * k;
  pose.head.z -= 0.01 * k;
  motion.lift += 0.012 * pump * k;
}

/** Round-start taunt: knock the fists together twice, roll the neck, then settle into the stance. */
function ready(pose: Pose, t: number, lead: 1 | -1) {
  const k = t < 2 ? smooth(t / 0.25) : 1 - smooth((t - 2) / 0.4);
  if (k <= 0) return;
  const knock = Math.max(0, Math.sin(Math.min(t, 1.2) * 2 * Math.PI * 1.6)) ** 6;
  for (const s of [1, -1] as const) {
    const [shoulder, elbow, wrist] = s === 1 ? (['lShoulder', 'lElbow', 'lWrist'] as const) : (['rShoulder', 'rElbow', 'rWrist'] as const);
    const target = tA.set(s * (0.035 + 0.03 * (1 - knock)), 0.74 + 0.02 * knock, 0.17).lerp(pose[wrist], 1 - k);
    solve(pose[shoulder], target, UPPER_ARM, FOREARM, pole.set(s, -0.5, -0.2), pose[elbow], pose[wrist]);
  }
  // Neck roll after the knocks.
  const roll = t > 1.2 && t < 2 ? Math.sin(((t - 1.2) / 0.8) * Math.PI * 2) : 0;
  pose.head.x += lead * 0.025 * roll * k;
  pose.head.y -= 0.008 * Math.abs(roll) * k;
}

/** Low on health: shoulders sag, guard drops, a hunch, and heavy breathing. */
function beatUp(pose: Pose, hurt: number, time: number) {
  const breathe = Math.sin(time * 2 * Math.PI * 1.1);
  crouch(pose, 0.02 * hurt);
  lean(pose, 0.025 * hurt);
  for (const j of ['lWrist', 'rWrist', 'lElbow', 'rElbow'] as const) pose[j].y -= (j.includes('Wrist') ? 0.05 : 0.025) * hurt;
  for (const j of ['lShoulder', 'rShoulder', 'neck', 'head'] as const) pose[j].y += 0.008 * breathe * hurt;
}

// ---------------------------------------------------------------------------
// Body operations on a pose.
// ---------------------------------------------------------------------------

const hipMid = (p: Pose, out: Vector3) => out.copy(p.lHip).add(p.rHip).multiplyScalar(0.5);

/** Turn the upper body about the vertical through the hips. + brings the right shoulder forward. */
export function twist(p: Pose, angle: number) {
  if (!angle) return;
  const c = hipMid(p, tA);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (const j of UPPER) {
    const v = p[j];
    const x = v.x - c.x;
    const z = v.z - c.z;
    v.x = c.x + x * cos + z * sin;
    v.z = c.z - x * sin + z * cos;
  }
}

/** Bend the upper body forward (+) or back (-): joints move by dz at neck height, scaled by height above the hips. */
export function lean(p: Pose, dz: number, dx = 0) {
  if (!dz && !dx) return;
  const hy = (p.lHip.y + p.rHip.y) / 2;
  for (const j of UPPER) {
    const k = Math.max(0, p[j].y - hy) / NECK_ABOVE_HIP;
    p[j].z += dz * k;
    p[j].x += dx * k;
  }
}

/** Slide the upper body sideways (+x is the fighter's left) and forward. */
export function shift(p: Pose, dx: number, dz: number) {
  for (const j of UPPER) {
    p[j].x += dx;
    p[j].z += dz;
  }
}

/** Sink the hips and everything above by `amount`, feet planted: the knees bend forward to take it. */
export function crouch(p: Pose, amount: number) {
  if (!amount) return;
  for (const j of JOINTS) if (j !== 'lKnee' && j !== 'rKnee' && j !== 'lAnkle' && j !== 'rAnkle') p[j].y -= amount;
  pole.set(0, 0, 1);
  solve(p.lHip, tB.copy(p.lAnkle), THIGH, SHIN, pole, p.lKnee, p.lAnkle);
  solve(p.rHip, tB.copy(p.rAnkle), THIGH, SHIN, pole, p.rKnee, p.rAnkle);
}

/**
 * Two-bone IK: places `mid` and `end` so root -> mid -> end (lengths a, b) reaches toward `target`, the joint bending
 * toward `hint`. Past full reach the limb points straight at the target.
 */
export function solve(root: Vector3, target: Vector3, a: number, b: number, hint: Vector3, mid: Vector3, end: Vector3) {
  const dir = tC.copy(target).sub(root);
  let d = dir.length();
  if (d < 1e-6) dir.set(0, -1, 0);
  else dir.divideScalar(d);
  d = clamp(d, Math.abs(a - b) + 1e-4, a + b - 1e-4);
  const cos = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sin = Math.sqrt(1 - cos * cos);
  const perp = tD.copy(hint).addScaledVector(dir, -hint.dot(dir));
  if (perp.lengthSq() < 1e-8) perp.set(0, 0, 1).addScaledVector(dir, -dir.z);
  perp.normalize();
  const midX = root.x + dir.x * a * cos + perp.x * a * sin;
  const midY = root.y + dir.y * a * cos + perp.y * a * sin;
  const midZ = root.z + dir.z * a * cos + perp.z * a * sin;
  end.set(root.x + dir.x * d, root.y + dir.y * d, root.z + dir.z * d);
  mid.set(midX, midY, midZ);
}
