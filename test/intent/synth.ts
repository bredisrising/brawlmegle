// Synthetic pose clips with ground-truth labels: a procedural body throws scripted moves in front of a
// virtual webcam, and the landmarks get MediaPipe-like noise (jitter, motion blur, bad depth, swaps,
// dropped and repeated frames). Lets the reader be measured without anyone recording themselves.
import type { Landmark, PoseFrame } from '../../src/types';

export type Label = {
  kind: 'strike' | 'jump' | 'duck' | 'dodge' | 'negative';
  name: string;
  limb?: 'armL' | 'armR' | 'legL' | 'legR';
  style?: string;
  start: number;
  end: number;
};
export type SynthOptions = {
  seconds?: number;
  seed?: number;
  fps?: number;
  /** Camera angle around the player in degrees: 0 = straight on, 45 = off to the side. */
  cameraYaw?: number;
  /** 0 = clean landmarks, 1 = typical webcam noise, 2 = bad lighting. */
  noise?: number;
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

/** One scripted move: joint offsets as a function of progress (0..1), plus its label. */
type Move = { name: string; kind: Label['kind']; limb?: Label['limb']; style?: string; ms: number; pose: (p: number, s: number) => Partial<Record<string, V>> };

const smooth = (p: number) => p * p * (3 - 2 * p);
/** Out-and-back curve: fast out (first `peak` of the time), slower return. */
const outBack = (p: number, peak = 0.4) => (p < peak ? smooth(p / peak) : 1 - smooth((p - peak) / (1 - peak)));
const lerp3 = (a: V, b: V, k: number): V => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const side = (s: string, l: boolean) => (l ? 'l' : 'r') + s;
const sx = (l: boolean) => (l ? 1 : -1);

function straight(l: boolean): Move {
  return {
    name: l ? 'jab' : 'cross', kind: 'strike', limb: l ? 'armL' : 'armR', style: 'straight', ms: 330,
    pose: (p, amp) => {
      const k = outBack(p) * amp;
      return {
        [side('Wrist', l)]: lerp3(REST[side('Wrist', l)], [sx(l) * 0.07, 1.43, 0.66], k),
        [side('Elbow', l)]: lerp3(REST[side('Elbow', l)], [sx(l) * 0.12, 1.41, 0.36], k),
        [side('Shoulder', l)]: lerp3(REST[side('Shoulder', l)], [sx(l) * 0.17, 1.42, 0.09], k),
      };
    },
  };
}
function hook(l: boolean): Move {
  return {
    name: l ? 'hookL' : 'hookR', kind: 'strike', limb: l ? 'armL' : 'armR', style: 'hook', ms: 420,
    pose: (p, amp) => {
      const out: V = [sx(l) * 0.42, 1.42, 0.22];
      const across: V = [-sx(l) * 0.06, 1.44, 0.42];
      const wrist = p < 0.3 ? lerp3(REST[side('Wrist', l)], out, smooth(p / 0.3)) : p < 0.55 ? lerp3(out, across, smooth((p - 0.3) / 0.25)) : lerp3(across, REST[side('Wrist', l)], smooth((p - 0.55) / 0.45));
      const k = outBack(p, 0.5) * amp;
      return {
        [side('Wrist', l)]: lerp3(REST[side('Wrist', l)], wrist, amp),
        [side('Elbow', l)]: lerp3(REST[side('Elbow', l)], [sx(l) * 0.3, 1.4, 0.2], k),
      };
    },
  };
}
function uppercut(l: boolean): Move {
  return {
    name: l ? 'upperL' : 'upperR', kind: 'strike', limb: l ? 'armL' : 'armR', style: 'upper', ms: 400,
    pose: (p, amp) => {
      const low: V = [sx(l) * 0.12, 1.12, 0.26];
      const high: V = [sx(l) * 0.05, 1.62, 0.36];
      const wrist = p < 0.3 ? lerp3(REST[side('Wrist', l)], low, smooth(p / 0.3)) : p < 0.55 ? lerp3(low, high, smooth((p - 0.3) / 0.25)) : lerp3(high, REST[side('Wrist', l)], smooth((p - 0.55) / 0.45));
      return { [side('Wrist', l)]: lerp3(REST[side('Wrist', l)], wrist, amp), [side('Elbow', l)]: lerp3(REST[side('Elbow', l)], [sx(l) * 0.16, 1.18, 0.25], outBack(p, 0.5) * amp) };
    },
  };
}
function knee(l: boolean): Move {
  return {
    name: l ? 'kneeL' : 'kneeR', kind: 'strike', limb: l ? 'legL' : 'legR', style: 'knee', ms: 650,
    pose: (p, amp) => {
      const k = outBack(p, 0.45) * amp;
      return { [side('Knee', l)]: lerp3(REST[side('Knee', l)], [sx(l) * 0.12, 0.95, 0.35], k), [side('Ankle', l)]: lerp3(REST[side('Ankle', l)], [sx(l) * 0.12, 0.55, 0.15], k) };
    },
  };
}
function kick(l: boolean): Move {
  return {
    name: l ? 'kickL' : 'kickR', kind: 'strike', limb: l ? 'legL' : 'legR', style: 'kick', ms: 750,
    pose: (p, amp) => {
      const k = outBack(p, 0.45) * amp;
      return { [side('Knee', l)]: lerp3(REST[side('Knee', l)], [sx(l) * 0.12, 0.88, 0.3], k), [side('Ankle', l)]: lerp3(REST[side('Ankle', l)], [sx(l) * 0.12, 0.9, 0.68], k) };
    },
  };
}
/** Whole-body moves shift every joint. */
function shiftAll(f: (j: string, p: number, amp: number) => V): (p: number, amp: number) => Partial<Record<string, V>> {
  return (p, amp) => Object.fromEntries(Object.keys(REST).map((j) => [j, f(j, p, amp)]));
}
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const bounce: Move = {
  name: 'bounce', kind: 'jump', ms: 450,
  pose: shiftAll((j, p, amp) => add(REST[j], [0, (p < 0.25 ? -0.03 * smooth(p / 0.25) : -0.03 + 0.11 * Math.sin(Math.PI * Math.min(1, (p - 0.25) / 0.6))) * amp, 0])),
};
const duck: Move = {
  name: 'duck', kind: 'duck', ms: 900,
  pose: shiftAll((j, p, amp) => {
    const k = outBack(p, 0.3) * amp;
    if (j.endsWith('Ankle')) return REST[j];
    if (j.endsWith('Knee')) return add(REST[j], [0, -0.12 * k, 0.12 * k]);
    return add(REST[j], [0, (REST[j][1] > 1.0 ? -0.38 : -0.25) * k, 0.05 * k]);
  }),
};
function slip(l: boolean): Move {
  return {
    name: l ? 'slipL' : 'slipR', kind: 'dodge', ms: 650,
    pose: shiftAll((j, p, amp) => {
      const k = outBack(p, 0.35) * amp;
      const h = Math.max(0, REST[j][1] - 0.95) / 0.67; // lean grows with height above the hips
      return add(REST[j], [sx(l) * 0.2 * h * k, -0.02 * h * k, 0]);
    }),
  };
}
// Things that must NOT register as moves.
function fidget(l: boolean): Move {
  return {
    name: 'fidget', kind: 'negative', ms: 1200,
    pose: (p) => ({ [side('Wrist', l)]: add(REST[side('Wrist', l)], [sx(l) * 0.06 * Math.sin(p * Math.PI * 2), -0.1 * Math.sin(p * Math.PI), 0.05 * Math.sin(p * Math.PI)]) }),
  };
}
function slowReach(l: boolean): Move {
  return { name: 'slow reach', kind: 'negative', ms: 2400, pose: (p) => ({ [side('Wrist', l)]: lerp3(REST[side('Wrist', l)], [sx(l) * 0.1, 1.4, 0.6], Math.sin(Math.PI * p)) }) };
}
const walk: Move = {
  name: 'walk in place', kind: 'negative', ms: 2000,
  pose: (p) => {
    const a = Math.max(0, Math.sin(p * Math.PI * 4));
    const b = Math.max(0, -Math.sin(p * Math.PI * 4));
    return { lKnee: add(REST.lKnee, [0, 0.07 * a, 0.05 * a]), lAnkle: add(REST.lAnkle, [0, 0.07 * a, 0]), rKnee: add(REST.rKnee, [0, 0.07 * b, 0.05 * b]), rAnkle: add(REST.rAnkle, [0, 0.07 * b, 0]) };
  },
};

const MOVES: Move[] = [
  straight(true), straight(false), straight(true), straight(false), hook(true), hook(false), uppercut(true), uppercut(false),
  knee(true), knee(false), kick(true), kick(false), bounce, duck, slip(true), slip(false),
  fidget(true), fidget(false), slowReach(true), walk,
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

export function synthesize(options: SynthOptions = {}): { frames: (PoseFrame | { t: number; missing: true })[]; labels: Label[] } {
  const { seconds = 120, seed = 1, fps = 30, cameraYaw = 0, noise = 1, only } = options;
  const moves = only ? MOVES.filter((m) => only.includes(m.name)) : MOVES;
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

  // Script: random moves with random gaps, speeds and sizes.
  const script: { move: Move; start: number; ms: number; amp: number }[] = [];
  const labels: Label[] = [];
  let t = 1500;
  while (t < seconds * 1000 - 2500) {
    const move = moves[Math.floor(rand() * moves.length)];
    const speed = 0.75 + rand() * 0.6; // slow and fast people
    const amp = 0.65 + rand() * 0.5; // small and big motions
    const ms = move.ms / speed;
    script.push({ move, start: t, ms, amp });
    labels.push({ kind: move.kind, name: move.name, limb: move.limb, style: move.style, start: t, end: t + ms });
    t += ms + 350 + rand() * 900;
  }

  // Camera: 2.6 m away at chest height, 4:3, ~55° vertical field of view, rotated around the player.
  const W = 640, H = 480, f = H / 2 / Math.tan((55 * Math.PI) / 360);
  const yaw = (cameraYaw * Math.PI) / 180;
  const cam = { x: Math.sin(yaw) * 2.6, y: 1.2, z: Math.cos(yaw) * 2.6 };
  const project = ([x, y, z]: V) => {
    const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
    const right = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
    const depth = -(Math.sin(yaw) * dx + Math.cos(yaw) * dz);
    return { x: 0.5 + (f * right) / depth / W, y: 0.5 - (f * dy) / depth / H, depth };
  };

  const frames: (PoseFrame | { t: number; missing: true })[] = [];
  let prev: Pose | null = null;
  let last: PoseFrame | null = null;
  let swap = 0;
  const zGain = 0.55 + rand() * 0.2; // MediaPipe underestimates depth
  let zDrift = 0;
  for (let i = 0; i < seconds * fps; i++) {
    const time = (i * 1000) / fps + (rand() - 0.5) * 6;
    if (noise > 0 && rand() < 0.02) continue; // dropped frame
    if (noise > 0 && last && rand() < 0.08) {
      frames.push({ ...last, t: time }); // the same camera frame processed twice
      continue;
    }

    // Pose at this time: rest + idle sway + any active move.
    const pose: Pose = {};
    const sway = Math.sin(time / 1000 * 1.9) * 0.012;
    const breathe = Math.sin(time / 1000 * 1.3) * 0.006;
    for (const [j, v] of Object.entries(REST)) pose[j] = [v[0] + sway, v[1] + (v[1] > 1 ? breathe : 0), v[2]];
    for (const s of script) {
      if (time < s.start || time > s.start + s.ms) continue;
      const p = (time - s.start) / s.ms;
      for (const [j, v] of Object.entries(s.move.pose(p, s.amp))) if (v) pose[j] = [v[0] + sway, v[1], v[2]];
    }

    const dt = prev ? 1 / fps : 0;
    const speedOf = (j: string) => (prev ? Math.hypot(...pose[j].map((c, k) => (c - prev![j][k]) / (dt || 1)) as V) : 0);
    const hip: V = [(pose.lHip[0] + pose.rHip[0]) / 2, (pose.lHip[1] + pose.rHip[1]) / 2, (pose.lHip[2] + pose.rHip[2]) / 2];
    zDrift += gauss() * 0.004 * noise;
    if (noise > 0 && swap === 0 && rand() < 0.003) swap = 2;

    const image: Landmark[] = [];
    const world: Landmark[] = [];
    for (const [joint, off] of MP) {
      const src = swap > 0 && joint.endsWith('Wrist') ? (joint[0] === 'l' ? 'r' : 'l') + joint.slice(1) : joint;
      const pos = add(pose[src], [off[0], off[1], off[2]]);
      const pr = project(pos);
      const speed = speedOf(src);
      const blur = noise * (0.0025 + 0.0015 * speed);
      const outlier = noise > 0 && rand() < 0.002 ? 0.05 : 0;
      // Visibility drops for fast hands (motion blur) and for elbows hidden behind a forearm pointing at the camera.
      let vis = 0.97 - (speed > 2 ? 0.3 + rand() * 0.3 : 0) * noise;
      if (joint.endsWith('Elbow')) {
        const w = pose[joint[0] + 'Wrist'];
        if (w[2] - pos[2] > 0.2) vis -= 0.45 * noise;
      }
      image.push({ x: pr.x + gauss() * blur + outlier, y: pr.y + gauss() * blur, z: 0, visibility: Math.max(0, Math.min(1, vis)) });
      // World landmarks: hip-centered, y down, closer to the camera = more negative z. Depth is the weak spot.
      const rel = [pos[0] - hip[0], pos[1] - hip[1], pos[2] - hip[2]];
      const camRight = Math.cos(yaw) * rel[0] - Math.sin(yaw) * rel[2];
      const camFwd = Math.sin(yaw) * rel[0] + Math.cos(yaw) * rel[2];
      world.push({
        x: camRight + gauss() * 0.01 * noise,
        y: -rel[1] + gauss() * 0.01 * noise,
        z: -camFwd * (noise > 0 ? zGain : 1) + (gauss() * 0.05 + zDrift) * noise,
        visibility: Math.max(0, Math.min(1, vis)),
      });
    }
    if (swap > 0) swap--;
    const frame: PoseFrame = { t: time, image, world, aspect: W / H };
    frames.push(frame);
    last = frame;
    prev = pose;
  }
  return { frames, labels };
}
