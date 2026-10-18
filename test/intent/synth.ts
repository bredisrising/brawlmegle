// Synthetic pose clips with ground-truth labels: a procedural body throws scripted moves in front of a
// virtual webcam, and the landmarks get MediaPipe-like noise (jitter, motion blur, bad depth, swaps,
// dropped and repeated frames). Lets the reader be measured without anyone recording themselves.
//
// Conditions cover how people actually play: standing or sitting at a laptop, the camera low, high, close or
// off to the side, 15 to 60 fps with dropped frames, different bodies and stances, and fast combos with no
// pause between punches. Noise is calibrated against real recordings (research/reader-robustness.md):
// MediaPipe jitters about 1–4% of a shoulder width while still, and its world z barely sees a fist
// coming at the camera.
import type { Landmark, PoseFrame } from '../../src/types';

export type Label = {
  kind: 'strike' | 'jump' | 'duck' | 'dodge' | 'negative';
  name: string;
  limb?: 'armL' | 'armR' | 'legL' | 'legR';
  style?: string;
  start: number;
  end: number;
  /** Part of a fast combo (no pause back to guard). */
  combo?: boolean;
};
export type SynthOptions = {
  seconds?: number;
  seed?: number;
  fps?: number;
  /** Camera angle around the player in degrees: 0 = straight on, 45 = off to the side (to the player's left). */
  cameraYaw?: number;
  /** Camera height (m). Default 1.2 standing, 0.95 sitting (a laptop on a desk). */
  cameraHeight?: number;
  /** Height the camera points at (m). Default level with the camera. */
  lookAt?: number;
  /** Camera distance from the player (m). Default 2.6 standing, 0.7 sitting. */
  distance?: number;
  /** Vertical field of view (degrees). */
  fov?: number;
  /** 0 = clean landmarks, 1 = typical webcam noise, 2 = bad lighting. */
  noise?: number;
  /** Seated at a desk: hips low and hidden, legs under the desk. No kicks, knees or jumps. */
  sitting?: boolean;
  /** Fraction of camera frames that never arrive (the tracker was busy). */
  dropRate?: number;
  /** Fraction of frames that repeat the previous camera frame with a new timestamp. */
  dupRate?: number;
  /** Timestamp jitter (± ms). */
  jitterMs?: number;
  /** Body proportions relative to a 1.75 m adult: overall height, arm length, shoulder width. */
  body?: { height?: number; arm?: number; shoulders?: number };
  /** Guard stance. Orthodox leads with the left hand, southpaw with the right. */
  stance?: 'square' | 'orthodox' | 'southpaw';
  /** Fraction of the script that is fast combos (punches 150–250 ms apart, no pause back to guard). */
  combos?: number;
  /** How much of a hand's real motion toward the camera MediaPipe's world z reports. Real: very little. */
  depthGain?: number;
  /** Whole-skeleton one-frame tracking glitches, per frame. */
  glitchRate?: number;
  /** Only use moves with these names (e.g. ['jab']). */
  only?: string[];
};

type V = [number, number, number];
type Pose = Record<string, V>;

// Rest pose: guard stance facing the camera (+z), meters. The person's left is +x.
const REST: Pose = {
  nose: [0, 1.62, 0.1], lEye: [0.035, 1.66, 0.08], rEye: [-0.035, 1.66, 0.08], lEar: [0.075, 1.63, 0], rEar: [-0.075, 1.63, 0],
  lMouth: [0.02, 1.58, 0.08], rMouth: [-0.02, 1.58, 0.08],
  lShoulder: [0.19, 1.42, 0], rShoulder: [-0.19, 1.42, 0], lElbow: [0.22, 1.2, 0.12], rElbow: [-0.22, 1.2, 0.12],
  lWrist: [0.1, 1.45, 0.22], rWrist: [-0.1, 1.45, 0.22],
  lHip: [0.11, 0.95, 0], rHip: [-0.11, 0.95, 0], lKnee: [0.13, 0.5, 0.03], rKnee: [-0.13, 0.5, 0.03],
  lAnkle: [0.14, 0.07, 0], rAnkle: [-0.14, 0.07, 0],
};
// MediaPipe's 33 landmarks, built from the joints above (hands and feet are offsets from wrists/ankles).
const MP: [string, V][] = [
  ['nose', [0, 0, 0]], ['lEye', [-0.015, 0, 0]], ['lEye', [0, 0, 0]], ['lEye', [0.015, 0, 0]],
  ['rEye', [0.015, 0, 0]], ['rEye', [0, 0, 0]], ['rEye', [-0.015, 0, 0]], ['lEar', [0, 0, 0]], ['rEar', [0, 0, 0]],
  ['lMouth', [0, 0, 0]], ['rMouth', [0, 0, 0]], ['lShoulder', [0, 0, 0]], ['rShoulder', [0, 0, 0]],
  ['lElbow', [0, 0, 0]], ['rElbow', [0, 0, 0]], ['lWrist', [0, 0, 0]], ['rWrist', [0, 0, 0]],
  ['lWrist', [0.02, -0.06, 0.03]], ['rWrist', [-0.02, -0.06, 0.03]], ['lWrist', [-0.01, -0.07, 0.04]], ['rWrist', [0.01, -0.07, 0.04]],
  ['lWrist', [-0.03, -0.03, 0.03]], ['rWrist', [0.03, -0.03, 0.03]],
  ['lHip', [0, 0, 0]], ['rHip', [0, 0, 0]], ['lKnee', [0, 0, 0]], ['rKnee', [0, 0, 0]], ['lAnkle', [0, 0, 0]], ['rAnkle', [0, 0, 0]],
  ['lAnkle', [0, -0.04, -0.05]], ['rAnkle', [0, -0.04, -0.05]], ['lAnkle', [0, -0.06, 0.12]], ['rAnkle', [0, -0.06, 0.12]],
];
const ARM_JOINTS = new Set(['lElbow', 'rElbow', 'lWrist', 'rWrist']);
const LEG_JOINTS = new Set(['lKnee', 'rKnee', 'lAnkle', 'rAnkle']);

/** One scripted move: joint positions as a function of progress (0..1) and size, from the rest pose R, plus its label. */
type Move = {
  name: string; kind: Label['kind']; limb?: Label['limb']; style?: string; ms: number;
  /** Not available sitting (legs, jumps, walking). */
  standingOnly?: boolean;
  pose: (p: number, amp: number, R: Pose) => Partial<Record<string, V>>;
};

const smooth = (p: number) => p * p * (3 - 2 * p);
/** Out-and-back curve: fast out (first `peak` of the time), slower return. */
const outBack = (p: number, peak = 0.4) => (p < peak ? smooth(p / peak) : 1 - smooth((p - peak) / (1 - peak)));
const lerp3 = (a: V, b: V, k: number): V => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const side = (s: string, l: boolean) => (l ? 'l' : 'r') + s;
const sx = (l: boolean) => (l ? 1 : -1);

function straight(l: boolean): Move {
  return {
    name: l ? 'jab' : 'cross', kind: 'strike', limb: l ? 'armL' : 'armR', style: 'straight', ms: 330,
    pose: (p, amp, R) => {
      const k = outBack(p) * amp;
      return {
        [side('Wrist', l)]: lerp3(R[side('Wrist', l)], [sx(l) * 0.07, 1.43, 0.66], k),
        [side('Elbow', l)]: lerp3(R[side('Elbow', l)], [sx(l) * 0.12, 1.41, 0.36], k),
        [side('Shoulder', l)]: lerp3(R[side('Shoulder', l)], [sx(l) * 0.17, 1.42, 0.09], k),
      };
    },
  };
}
function hook(l: boolean): Move {
  return {
    name: l ? 'hookL' : 'hookR', kind: 'strike', limb: l ? 'armL' : 'armR', style: 'hook', ms: 420,
    pose: (p, amp, R) => {
      const rest = R[side('Wrist', l)];
      const out: V = [sx(l) * 0.42, 1.42, 0.22];
      const across: V = [-sx(l) * 0.06, 1.44, 0.42];
      const wrist = p < 0.3 ? lerp3(rest, out, smooth(p / 0.3)) : p < 0.55 ? lerp3(out, across, smooth((p - 0.3) / 0.25)) : lerp3(across, rest, smooth((p - 0.55) / 0.45));
      const k = outBack(p, 0.5) * amp;
      return {
        [side('Wrist', l)]: lerp3(rest, wrist, amp),
        [side('Elbow', l)]: lerp3(R[side('Elbow', l)], [sx(l) * 0.3, 1.4, 0.2], k),
      };
    },
  };
}
function uppercut(l: boolean): Move {
  return {
    name: l ? 'upperL' : 'upperR', kind: 'strike', limb: l ? 'armL' : 'armR', style: 'upper', ms: 400,
    pose: (p, amp, R) => {
      const rest = R[side('Wrist', l)];
      const low: V = [sx(l) * 0.12, 1.12, 0.26];
      const high: V = [sx(l) * 0.05, 1.62, 0.36];
      const wrist = p < 0.3 ? lerp3(rest, low, smooth(p / 0.3)) : p < 0.55 ? lerp3(low, high, smooth((p - 0.3) / 0.25)) : lerp3(high, rest, smooth((p - 0.55) / 0.45));
      return { [side('Wrist', l)]: lerp3(rest, wrist, amp), [side('Elbow', l)]: lerp3(R[side('Elbow', l)], [sx(l) * 0.16, 1.18, 0.25], outBack(p, 0.5) * amp) };
    },
  };
}
function knee(l: boolean): Move {
  return {
    name: l ? 'kneeL' : 'kneeR', kind: 'strike', limb: l ? 'legL' : 'legR', style: 'knee', ms: 650, standingOnly: true,
    pose: (p, amp, R) => {
      const k = outBack(p, 0.45) * amp;
      return { [side('Knee', l)]: lerp3(R[side('Knee', l)], [sx(l) * 0.12, 0.95, 0.35], k), [side('Ankle', l)]: lerp3(R[side('Ankle', l)], [sx(l) * 0.12, 0.55, 0.15], k) };
    },
  };
}
function kick(l: boolean): Move {
  return {
    name: l ? 'kickL' : 'kickR', kind: 'strike', limb: l ? 'legL' : 'legR', style: 'kick', ms: 750, standingOnly: true,
    pose: (p, amp, R) => {
      const k = outBack(p, 0.45) * amp;
      return { [side('Knee', l)]: lerp3(R[side('Knee', l)], [sx(l) * 0.12, 0.88, 0.3], k), [side('Ankle', l)]: lerp3(R[side('Ankle', l)], [sx(l) * 0.12, 0.9, 0.68], k) };
    },
  };
}
/** Whole-body moves shift every joint. */
function shiftAll(f: (j: string, p: number, amp: number, R: Pose) => V): Move['pose'] {
  return (p, amp, R) => Object.fromEntries(Object.keys(R).map((j) => [j, f(j, p, amp, R)]));
}
/** A real hop: dip, both feet leave the floor ~15–25 cm, land. */
const jump: Move = {
  name: 'jump', kind: 'jump', ms: 550, standingOnly: true,
  pose: shiftAll((j, p, amp, R) => add(R[j], [0, (p < 0.25 ? -0.05 * smooth(p / 0.25) : -0.05 + 0.25 * Math.sin(Math.PI * Math.min(1, (p - 0.25) / 0.6))) * amp, 0])),
};
/** Boxer's bounce on the toes: a few small bobs. Not a jump. */
const bounce: Move = {
  name: 'bounce on toes', kind: 'negative', ms: 1600, standingOnly: true,
  pose: shiftAll((j, p, _a, R) => (j.endsWith('Ankle') ? R[j] : add(R[j], [0, 0.035 * Math.abs(Math.sin(p * Math.PI * 4)), 0]))),
};
const duck: Move = {
  name: 'duck', kind: 'duck', ms: 900,
  pose: shiftAll((j, p, amp, R) => {
    const k = outBack(p, 0.3) * amp;
    if (j.endsWith('Ankle')) return R[j];
    if (j.endsWith('Knee')) return add(R[j], [0, -0.12 * k, 0.12 * k]);
    return add(R[j], [0, (R[j][1] > 1.0 ? -0.38 : -0.25) * k, 0.05 * k]);
  }),
};
// Sitting: no knees to bend. The player hunches forward and down in the chair.
const seatedDuck: Move = {
  name: 'duck', kind: 'duck', ms: 900,
  pose: shiftAll((j, p, amp, R) => {
    const k = outBack(p, 0.3) * amp;
    const h = Math.max(0, Math.min(1, (R[j][1] - 0.95) / 0.67));
    return add(R[j], [0, -0.3 * h * k, 0.1 * h * k]);
  }),
};
function slip(l: boolean): Move {
  return {
    name: l ? 'slipL' : 'slipR', kind: 'dodge', ms: 650,
    pose: shiftAll((j, p, amp, R) => {
      const k = outBack(p, 0.35) * amp;
      const h = Math.max(0, R[j][1] - 0.95) / 0.67; // lean grows with height above the hips
      return add(R[j], [sx(l) * 0.2 * h * k, -0.02 * h * k, 0]);
    }),
  };
}
// Things that must NOT register as moves.
function fidget(l: boolean): Move {
  return {
    name: 'fidget', kind: 'negative', ms: 1200,
    pose: (p, _a, R) => ({ [side('Wrist', l)]: add(R[side('Wrist', l)], [sx(l) * 0.06 * Math.sin(p * Math.PI * 2), -0.1 * Math.sin(p * Math.PI), 0.05 * Math.sin(p * Math.PI)]) }),
  };
}
function slowReach(l: boolean): Move {
  return { name: 'slow reach', kind: 'negative', ms: 2400, pose: (p, _a, R) => ({ [side('Wrist', l)]: lerp3(R[side('Wrist', l)], [sx(l) * 0.1, 1.4, 0.6], Math.sin(Math.PI * p)) }) };
}
/** Hand up beside the head, waving side to side, back down. */
function wave(l: boolean): Move {
  return {
    name: 'wave', kind: 'negative', ms: 2200,
    pose: (p, _a, R) => {
      const up = p < 0.2 ? smooth(p / 0.2) : p > 0.8 ? 1 - smooth((p - 0.8) / 0.2) : 1;
      const sway = p > 0.2 && p < 0.8 ? Math.sin(((p - 0.2) / 0.6) * Math.PI * 6) * 0.1 : 0;
      const hand: V = [sx(l) * (0.3 + sway), 1.72, 0.12];
      return { [side('Wrist', l)]: lerp3(R[side('Wrist', l)], hand, up), [side('Elbow', l)]: lerp3(R[side('Elbow', l)], [sx(l) * 0.36, 1.42, 0.06], up) };
    },
  };
}
/** Hand to the top of the head, a little rub, back down. */
function scratch(l: boolean): Move {
  return {
    name: 'scratch head', kind: 'negative', ms: 2000,
    pose: (p, _a, R) => {
      const up = p < 0.25 ? smooth(p / 0.25) : p > 0.75 ? 1 - smooth((p - 0.75) / 0.25) : 1;
      const rub = p > 0.25 && p < 0.75 ? Math.sin(((p - 0.25) / 0.5) * Math.PI * 8) * 0.03 : 0;
      return {
        [side('Wrist', l)]: lerp3(R[side('Wrist', l)], [sx(l) * 0.05 + rub, 1.78, 0.02], up),
        [side('Elbow', l)]: lerp3(R[side('Elbow', l)], [sx(l) * 0.3, 1.62, 0.02], up),
      };
    },
  };
}
/** Torso twist (looking around, shifting in the seat) with the arms carried along, no punch. */
function twist(l: boolean): Move {
  return {
    name: 'twist', kind: 'negative', ms: 1400,
    pose: shiftAll((j, p, _a, R) => {
      const a = (l ? 1 : -1) * 0.4 * Math.sin(Math.PI * p);
      const h = Math.max(0, Math.min(1, (R[j][1] - 0.95) / 0.47));
      return LEG_JOINTS.has(j) ? R[j] : rotY(R[j], a * h);
    }),
  };
}
/** Both hands down to the keyboard or lap and back up to guard. */
const handsDown: Move = {
  name: 'hands down', kind: 'negative', ms: 2000,
  pose: (p, _a, R) => {
    const k = Math.sin(Math.PI * p);
    return {
      lWrist: lerp3(R.lWrist, [0.16, 1.05, 0.3], k), rWrist: lerp3(R.rWrist, [-0.16, 1.05, 0.3], k),
      lElbow: lerp3(R.lElbow, [0.22, 1.12, 0.05], k), rElbow: lerp3(R.rElbow, [-0.22, 1.12, 0.05], k),
    };
  },
};
const walk: Move = {
  name: 'walk in place', kind: 'negative', ms: 2000, standingOnly: true,
  pose: (p, _a, R) => {
    const a = Math.max(0, Math.sin(p * Math.PI * 4));
    const b = Math.max(0, -Math.sin(p * Math.PI * 4));
    return { lKnee: add(R.lKnee, [0, 0.07 * a, 0.05 * a]), lAnkle: add(R.lAnkle, [0, 0.07 * a, 0]), rKnee: add(R.rKnee, [0, 0.07 * b, 0.05 * b]), rAnkle: add(R.rAnkle, [0, 0.07 * b, 0]) };
  },
};

const MOVES: Move[] = [
  straight(true), straight(false), straight(true), straight(false), hook(true), hook(false), uppercut(true), uppercut(false),
  knee(true), knee(false), kick(true), kick(false), jump, duck, slip(true), slip(false),
  fidget(true), fidget(false), slowReach(true), walk, bounce, wave(false), scratch(true), twist(true), twist(false), handsDown,
];
const BY_NAME = new Map(MOVES.map((m) => [m.name, m]));
const COMBOS: string[][] = [
  ['jab', 'cross'], ['jab', 'jab', 'cross'], ['hookL', 'upperR'], ['cross', 'hookL'], ['upperL', 'hookR'],
  ['jab', 'cross', 'hookL'], ['hookR', 'hookL'], ['cross', 'jab'], ['jab', 'jab'],
];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotate around the vertical axis through the hip center (positive turns the left side away from the camera). */
function rotY([x, y, z]: V, a: number): V {
  return [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
}

/** The rest pose for a stance: bladed stances turn the torso ~20° and push the lead hand forward. */
function restPose(stance: SynthOptions['stance']): Pose {
  if (!stance || stance === 'square') return REST;
  const l = stance === 'orthodox'; // lead side
  const a = (l ? -1 : 1) * 0.35;
  const R: Pose = {};
  for (const [j, v] of Object.entries(REST)) {
    const h = Math.max(0, Math.min(1, (v[1] - 0.95) / 0.47));
    R[j] = LEG_JOINTS.has(j) ? v : rotY(v, a * (0.5 + 0.5 * h));
  }
  R[side('Wrist', l)] = add(R[side('Wrist', l)], [sx(l) * 0.03, -0.05, 0.12]);
  R[side('Elbow', l)] = add(R[side('Elbow', l)], [0, 0, 0.08]);
  R[side('Wrist', !l)] = add(R[side('Wrist', !l)], [sx(l) * 0.03, 0.02, -0.04]);
  return R;
}

/** Proportions and posture, applied after the moves: arm length and shoulder width around the shoulders, then height. */
function shapeBody(pose: Pose, o: { height: number; arm: number; shoulders: number; sitting: boolean }): Pose {
  const out: Pose = {};
  const drop = o.sitting ? 0.47 : 0;
  for (const [j, v] of Object.entries(pose)) out[j] = [...v] as V;
  for (const l of [true, false]) {
    const s = pose[side('Shoulder', l)];
    const s2: V = [s[0] * o.shoulders, s[1], s[2]];
    out[side('Shoulder', l)] = s2;
    for (const j of ['Elbow', 'Wrist']) out[side(j, l)] = add(s2, pose[side(j, l)].map((c, i) => (c - s[i]) * o.arm) as V);
  }
  for (const [j, v] of Object.entries(out)) {
    if (o.sitting && LEG_JOINTS.has(j)) {
      // Seated: thighs forward at seat height, shins down to the floor.
      const l = j[0] === 'l';
      out[j] = j.endsWith('Knee') ? [sx(l) * 0.13, 0.5, 0.42] : [sx(l) * 0.14, 0.08, 0.45];
    } else {
      out[j] = [v[0], v[1] - drop, v[2] - (o.sitting ? 0.05 : 0)];
    }
    out[j] = out[j].map((c) => c * o.height) as V;
  }
  return out;
}

export function synthesize(options: SynthOptions = {}): { frames: (PoseFrame | { t: number; missing: true })[]; labels: Label[] } {
  const { seconds = 120, seed = 1, fps = 30, cameraYaw = 0, noise = 1, only, sitting = false, stance = 'square' } = options;
  const dropRate = options.dropRate ?? 0.02;
  const dupRate = options.dupRate ?? 0.08;
  const jitterMs = options.jitterMs ?? 3;
  const comboShare = options.combos ?? 0;
  const glitchRate = options.glitchRate ?? 0.002 * noise;
  const body = { height: options.body?.height ?? 1, arm: options.body?.arm ?? 1, shoulders: options.body?.shoulders ?? 1, sitting };
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const R = restPose(stance);
  const depthGain = options.depthGain ?? 0.1 + rand() * 0.25;
  // How much this person turns the torso and moves the head when punching (people vary a lot).
  const twist = rand() * 0.35;
  const headShift = rand() * 0.07;

  // Camera: a pinhole at `distance`, rotated `yaw` around the player, aimed at `lookAt`. 4:3, 640x480.
  const W = 640, H = 480;
  const fov = options.fov ?? 55;
  const f = H / 2 / Math.tan((fov * Math.PI) / 360);
  const yaw = (cameraYaw * Math.PI) / 180;
  const camH = (options.cameraHeight ?? (sitting ? 0.95 : 1.2)) * (sitting ? 1 : body.height);
  const dist = options.distance ?? (sitting ? 0.7 : 2.6);
  const lookY = options.lookAt ?? camH;
  const cam: V = [Math.sin(yaw) * dist, camH, Math.cos(yaw) * dist];
  const fwd = normalize([-cam[0], lookY - cam[1], -cam[2]]);
  const right = normalize(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const project = (p: V) => {
    const d: V = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
    const depth = Math.max(0.05, dot(d, fwd));
    return { x: 0.5 + (f * dot(d, right)) / depth / W, y: 0.5 - (f * dot(d, up)) / depth / H, depth };
  };
  // Legs (and jumps) only when the feet are in the frame: close framing and sitting can't see them.
  const restShaped = shapeBody(R, body);
  const feetVisible = ['lAnkle', 'rAnkle', 'lKnee', 'rKnee'].every((j) => {
    const p = project(restShaped[j]);
    return p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1;
  });
  const pool = MOVES.filter((m) => (!only || only.includes(m.name)) && !((sitting || !feetVisible) && m.standingOnly))
    .map((m) => (sitting && m === duck ? seatedDuck : m));

  // Script: random moves with random gaps, speeds and sizes; some fast combos.
  /** `aim`: where this strike ends relative to the scripted target (people punch a little high, low, wide). */
  type Item = { move: Move; start: number; ms: number; amp: number; aim: V };
  const aimOf = (): V => [(rand() - 0.5) * 0.1, -0.04 + rand() * 0.14, 0];
  const script: Item[] = [];
  const labels: Label[] = [];
  let t = 1500;
  while (t < seconds * 1000 - 2500) {
    if (comboShare > 0 && rand() < comboShare) {
      const combo = COMBOS[Math.floor(rand() * COMBOS.length)].map((n) => BY_NAME.get(n)!);
      let start = t;
      let end = t;
      for (const move of combo) {
        const speed = 1 + rand() * 0.35; // combos are thrown fast
        const amp = 0.7 + rand() * 0.4;
        const ms = move.ms / speed;
        script.push({ move, start, ms, amp, aim: aimOf() });
        labels.push({ kind: move.kind, name: move.name, limb: move.limb, style: move.style, start, end: start + ms, combo: true });
        end = Math.max(end, start + ms);
        start += 150 + rand() * 100;
      }
      t = end + 450 + rand() * 900;
      continue;
    }
    const move = pool[Math.floor(rand() * pool.length)];
    const speed = 0.75 + rand() * 0.6; // slow and fast people
    const amp = 0.65 + rand() * 0.5; // small and big motions
    const ms = move.ms / speed;
    script.push({ move, start: t, ms, amp, aim: aimOf() });
    labels.push({ kind: move.kind, name: move.name, limb: move.limb, style: move.style, start: t, end: t + ms });
    t += ms + 350 + rand() * 900;
  }

  // A desk between a seated player and the laptop hides what's below its top.
  const deskY = 0.72 * body.height, deskEdge = 0.28;
  const hiddenByDesk = (p: V) => {
    if (!sitting || p[1] > deskY) return false;
    const k = (deskEdge - p[2]) / (cam[2] - p[2]);
    return k > 0 && k < 1 && p[1] + k * (cam[1] - p[1]) < deskY;
  };

  const frames: (PoseFrame | { t: number; missing: true })[] = [];
  let prev: Pose | null = null;
  let last: PoseFrame | null = null;
  let swap = 0;
  let zDrift = 0;
  const lostBias = MP.map(() => [gauss() * 0.03, gauss() * 0.03]);
  for (let i = 0; i < seconds * fps; i++) {
    const time = (i * 1000) / fps + (rand() - 0.5) * 2 * jitterMs;
    if (noise > 0 && rand() < dropRate) continue; // dropped frame
    if (noise > 0 && last && rand() < dupRate) {
      frames.push({ ...last, t: time }); // the same camera frame processed twice
      continue;
    }

    // Pose at this time: rest + idle sway + any active move. A move that starts while an earlier one still
    // holds the same joints blends in from wherever they are (combos don't go back to guard first).
    let pose: Pose = {};
    const sway = Math.sin(time / 1000 * 1.9) * 0.012;
    const breathe = Math.sin(time / 1000 * 1.3) * 0.006;
    for (const [j, v] of Object.entries(R)) pose[j] = [v[0] + sway, v[1] + (v[1] > 1 ? breathe : 0), v[2]];
    const owner: Record<string, number> = {};
    for (const s of script) {
      if (time < s.start || time > s.start + s.ms) continue;
      const p = (time - s.start) / s.ms;
      const w = Math.min(1, p / 0.25);
      const arm = s.move.limb?.startsWith('arm') ? s.move.limb[3].toLowerCase() : null;
      const k = arm ? outBack(p) * s.amp : 0;
      for (const [j, v] of Object.entries(s.move.pose(p, s.amp, R))) {
        if (!v) continue;
        const aim = arm && j[0] === arm ? (j.endsWith('Wrist') ? 1 : j.endsWith('Elbow') ? 0.5 : 0) * k : 0;
        const target: V = [v[0] + sway + s.aim[0] * (arm === 'l' ? 1 : -1) * aim, v[1] + s.aim[1] * aim, v[2]];
        pose[j] = owner[j] !== undefined ? lerp3(pose[j], target, w) : target;
        owner[j] = s.start;
      }
    }
    // Real punches turn the torso (the punching shoulder goes forward) and push the head toward the other side.
    // The other arm rides along in its guard. This is what makes heads look like they slip and guards look like they punch.
    for (const s of script) {
      if (time < s.start || time > s.start + s.ms || !s.move.limb?.startsWith('arm')) continue;
      const l = s.move.limb === 'armL';
      const k = outBack((time - s.start) / s.ms) * s.amp;
      const a = (l ? -1 : 1) * twist * k;
      const other = l ? 'r' : 'l';
      for (const [j, v] of Object.entries(pose)) {
        if (LEG_JOINTS.has(j) || (ARM_JOINTS.has(j) && j[0] !== other)) continue;
        const h = Math.max(0, Math.min(1, (R[j][1] - 0.95) / 0.47));
        const turned = rotY(v, a * (j.endsWith('Hip') ? 0.5 : 1));
        pose[j] = add(turned, [(l ? -1 : 1) * headShift * k * h * h, 0, 0.03 * k * h]);
      }
    }
    pose = shapeBody(pose, body);

    const dt = prev ? 1 / fps : 0;
    const speedOf = (j: string) => (prev ? Math.hypot(...pose[j].map((c, k) => (c - prev![j][k]) / (dt || 1)) as V) : 0);
    const hip: V = [(pose.lHip[0] + pose.rHip[0]) / 2, (pose.lHip[1] + pose.rHip[1]) / 2, (pose.lHip[2] + pose.rHip[2]) / 2];
    zDrift = 0.98 * zDrift + gauss() * 0.004 * noise;
    if (noise > 0 && swap === 0 && rand() < 0.003) swap = 2;
    // Apparent shoulder width (image height units): MediaPipe's jitter scales with how big the person looks.
    const sw = Math.hypot((project(pose.lShoulder).x - project(pose.rShoulder).x) * (W / H), project(pose.lShoulder).y - project(pose.rShoulder).y) || 0.1;
    const glitch = noise > 0 && rand() < glitchRate ? [gauss() * 0.15 * sw, gauss() * 0.15 * sw] : null;

    const image: Landmark[] = [];
    const world: Landmark[] = [];
    MP.forEach(([joint, off], m) => {
      const src = swap > 0 && joint.endsWith('Wrist') ? (joint[0] === 'l' ? 'r' : 'l') + joint.slice(1) : joint;
      const pos = add(pose[src], off.map((c) => c * body.height) as V);
      const pr = project(pos);
      const speed = speedOf(src);
      const jitter = noise * sw * (0.018 + 0.011 * speed);
      const outlier = noise > 0 && rand() < 0.002 ? 0.3 * sw : 0;
      // Visibility drops a little for fast hands (motion blur) and a lot for elbows hidden behind a forearm
      // pointing at the camera, points out of the frame and points behind the desk.
      let vis = 0.97 - (speed > 2 ? 0.1 + rand() * 0.2 : 0) * noise;
      if (joint.endsWith('Elbow')) {
        const w = pose[joint[0] + 'Wrist'];
        if (dot([w[0] - pos[0], w[1] - pos[1], w[2] - pos[2]], fwd) < -0.2 * body.height) vis -= 0.45 * noise;
      }
      let x = pr.x + (gauss() * jitter + outlier) * (H / W);
      let y = pr.y + gauss() * jitter;
      const lost = pr.x < -0.02 || pr.x > 1.02 || pr.y < -0.02 || pr.y > 1.02 || hiddenByDesk(pos);
      if (lost) {
        // MediaPipe still guesses a position for points it can't see, with low visibility.
        vis = 0.02 + rand() * 0.25;
        x += lostBias[m][0] * sw * 3 + gauss() * 0.15 * sw;
        y += lostBias[m][1] * sw * 3 + gauss() * 0.15 * sw;
      }
      if (glitch) (x += glitch[0] * (H / W)), (y += glitch[1]);
      image.push({ x, y, z: 0, visibility: Math.max(0, Math.min(1, vis)) });
      // World landmarks: hip-centered, camera-aligned, y down, closer to the camera = more negative z.
      // Depth is the weak spot: hands and elbows coming at the camera barely register.
      const rel: V = [pos[0] - hip[0], pos[1] - hip[1], pos[2] - hip[2]];
      const gain = noise === 0 ? 1 : ARM_JOINTS.has(src) || joint !== src ? depthGain : 0.8;
      world.push({
        x: dot(rel, right) + gauss() * 0.01 * noise,
        y: -dot(rel, up) + gauss() * 0.01 * noise,
        z: dot(rel, fwd) * gain + (gauss() * 0.015 + zDrift) * noise,
        visibility: Math.max(0, Math.min(1, vis)),
      });
    });
    if (swap > 0) swap--;
    const frame: PoseFrame = { t: time, image, world, aspect: W / H };
    frames.push(frame);
    last = frame;
    prev = pose;
  }
  return { frames, labels };
}

const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V): V => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
