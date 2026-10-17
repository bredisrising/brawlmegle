import type { AttackMove, Command, PlayerId, PoseFrame, Stance } from '../types';
import { LM, PosePreprocessor, type Body, type BodyPoint, type Vec3 } from './preprocess';
import { DEFAULT_INTENT, type Intent, type IntentConfig, type LimbConfig, type LimbName, type StrikeStyle } from './intents';

/**
 * PoseFrames -> what the player meant. One per player, runs on the host.
 * The camera reports intent; it never decides a hit.
 *
 * Every limb is watched the same way: a fast burst away from its resting position is a strike, whatever
 * the technique. The direction only adds detail (straight, hook, upper, knee, kick); the resolver
 * decides what it becomes in the fight. Depth from one camera is noisy, so it counts for less than
 * image-plane motion.
 */

/**
 * Each limb is tracked by two points relative to its root: the tip (wrist/ankle) and the middle joint
 * (elbow/knee). Facing the camera, a straight punch barely moves the wrist in the image, but the elbow
 * rises and swings in by ~20 cm, so watching both catches it.
 */
type LimbDef = { root: number; tip: number; mid: number; side: 1 | -1; kind: 'arm' | 'leg' };
const LIMBS: Record<LimbName, LimbDef> = {
  // The person's left appears on the image right (+x), so "outward" for the left side is +x.
  armL: { root: LM.lShoulder, tip: LM.lWrist, mid: LM.lElbow, side: 1, kind: 'arm' },
  armR: { root: LM.rShoulder, tip: LM.rWrist, mid: LM.rElbow, side: -1, kind: 'arm' },
  legL: { root: LM.lHip, tip: LM.lAnkle, mid: LM.lKnee, side: 1, kind: 'leg' },
  legR: { root: LM.rHip, tip: LM.rAnkle, mid: LM.rKnee, side: -1, kind: 'leg' },
};
/** How much the middle joint counts next to the tip. */
const MID_WEIGHT = 0.8;
/** How much elbow straightening counts (per 90° opened), next to tip travel in body units. */
const EXT_WEIGHT = 0.6;
/** Elbow angles from one camera wobble; ignore the first ~15° of opening. */
const EXT_DEADBAND = 0.1;
const LIMB_NAMES = Object.keys(LIMBS) as LimbName[];

/** Tip and middle joint relative to the limb root, plus (arms) how open the elbow is, scaled by EXT_WEIGHT. */
type Pair = { tip: Vec3; mid: Vec3; ext: number };
type LimbState = {
  phase: 'idle' | 'onset' | 'recover';
  /** Usual position (guard or relaxed); "back near rest" means ready to strike again. */
  rest: Pair | null;
  /** Where the limb last paused. Strikes are measured from here, so a cocked-back hook or a dropped
   * uppercut counts from where it actually started. */
  anchor: Pair | null;
  since: number;
  peakDisp: number;
  peakSpeed: number;
  /** Tip travel from the anchor at the peak. */
  peak: Vec3;
  /** Tip and middle joint (body space) at the peak. */
  peakTip: Vec3;
  peakMid: Vec3;
  /** Middle-joint (elbow/knee) rise from the anchor at the peak. */
  peakMidRise: number;
  /** Elbow-opening part of the displacement at the peak. */
  peakExt: number;
  history: { t: number; d: Vec3 }[];
  typicalSpeed: number;
  // Debug readouts
  disp: number;
  out: number;
};

export type IntentDebug = {
  limbs: Record<LimbName, { phase: LimbState['phase']; disp: number; out: number }>;
  headDrop: number;
  lean: number;
  rootY: number;
  rootVy: number;
  scale: number;
  guard: boolean;
};

export type IntentOutput = {
  commands: Command[];
  stance: Stance;
  intents: Intent[];
  /** Latest preprocessed body (null until tracking starts), for overlays and the tuner. */
  body: Body | null;
  debug: IntentDebug | null;
};

export class IntentReader {
  readonly player: PlayerId;
  private config: IntentConfig;
  private readonly pre: PosePreprocessor;
  private readonly limbs: Record<LimbName, LimbState>;
  private body: Body | null = null;
  private lastNewFrameAt = -Infinity;
  private headRest: { x: number; y: number } | null = null;
  private lastCore: Record<'jump' | 'duck' | 'dodge', number> = { jump: -Infinity, duck: -Infinity, dodge: -Infinity };
  private guardSince: number | null = null;
  private guardUp = false;
  private stance: Stance;
  private debug: IntentDebug | null = null;

  constructor(player: PlayerId, config: IntentConfig = DEFAULT_INTENT) {
    this.player = player;
    this.config = config;
    this.pre = new PosePreprocessor(config.preprocess);
    this.limbs = Object.fromEntries(LIMB_NAMES.map((n) => [n, newLimb()])) as Record<LimbName, LimbState>;
    this.stance = untracked(player);
  }

  /** Live tuning. */
  setConfig(config: IntentConfig) {
    this.config = config;
    this.pre.setConfig(config.preprocess);
  }

  reset() {
    this.pre.reset();
    for (const n of LIMB_NAMES) this.limbs[n] = newLimb();
    this.body = null;
    this.headRest = null;
    this.guardSince = null;
    this.guardUp = false;
    this.stance = untracked(this.player);
  }

  /**
   * Call every tick with the latest frame. Repeated frames return no new intents.
   * `now` is the host clock, used only to notice a lost player (remote frames carry the other laptop's clock).
   */
  update(frame: PoseFrame | null, now: number = performance.now()): IntentOutput {
    const body = frame ? this.pre.process(frame) : null;
    if (body) this.lastNewFrameAt = now;
    if (now - this.lastNewFrameAt > this.config.staleMs) {
      if (this.body) this.reset();
      return { commands: [], stance: this.stance, intents: [], body: null, debug: null };
    }
    if (!body) return { commands: [], stance: this.stance, intents: [], body: this.body, debug: this.debug };
    this.body = body;

    const intents: Intent[] = [];
    for (const name of LIMB_NAMES) this.updateLimb(name, body, intents);
    this.updateCore(body, intents);
    return { commands: toCommands(this.player, intents), stance: this.stance, intents, body, debug: this.debug };
  }

  private updateLimb(name: LimbName, body: Body, out: Intent[]) {
    const def = LIMBS[name];
    const cfg: LimbConfig = def.kind === 'arm' ? this.config.arm : this.config.leg;
    const s = this.limbs[name];
    const wz = this.config.depthWeight;
    const t = body.t;

    const root = body.points[def.root];
    const tipPt = body.points[def.tip];
    const midPt = body.points[def.mid];
    // Legs off-screen (upper-body framing) or a limb MediaPipe can't see: don't guess.
    const visible = def.kind === 'arm'
      ? tipPt.visibility > 0.3 && root.visibility > 0.5
      : body.fullBody && tipPt.visibility > 0.5 && midPt.visibility > 0.5;
    // Arms: relative to the shoulder, so leaning and ducking don't look like punches.
    // Legs: height is measured from the usual hip height, so when the hips drop in a duck the knees
    // don't seem to rise.
    const legs = def.kind === 'leg';
    const relOf = (p: BodyPoint): Vec3 => ({
      x: p.p.x - root.p.x,
      y: legs ? p.p.y + body.root.y : p.p.y - root.p.y,
      z: (p.p.z - root.p.z) * wz,
    });
    // Velocities come from the lightly filtered channel so onsets register a frame or two sooner.
    const velOf = (p: BodyPoint): Vec3 => ({
      x: p.vf.x - root.vf.x,
      y: legs ? p.vf.y + body.root.vy : p.vf.y - root.vf.y,
      z: (p.vf.z - root.vf.z) * wz,
    });
    const side = name === 'armL' ? 'L' : 'R';
    const ext = legs ? 0 : (body.elbow[side] / 90) * EXT_WEIGHT;
    const extV = legs ? 0 : (body.elbow[side === 'L' ? 'vL' : 'vR'] / 90) * EXT_WEIGHT;
    const now: Pair = { tip: relOf(tipPt), mid: relOf(midPt), ext };
    const vel = { tip: velOf(tipPt), mid: velOf(midPt) };
    if (!s.rest) s.rest = clonePair(now);
    if (!s.anchor) s.anchor = clonePair(now);

    // Travel since the last pause, tip and middle joint together.
    const tTip = sub(now.tip, s.anchor.tip);
    const tMid = sub(now.mid, s.anchor.mid);
    // Only opening the elbow counts (bending it back is a retraction).
    const tExt = Math.max(0, now.ext - s.anchor.ext - EXT_DEADBAND);
    const disp = Math.hypot(len(tTip), MID_WEIGHT * len(tMid), tExt);
    const outward = disp > 1e-3 ? (dot(vel.tip, tTip) + MID_WEIGHT * MID_WEIGHT * dot(vel.mid, tMid) + tExt * extV) / disp : 0;
    // Resting is judged on the smooth channel: the fast one is too jittery to ever look still.
    const smoothV = (p: BodyPoint) => Math.hypot(p.v.x - root.v.x, p.v.y - root.v.y);
    const speed = Math.hypot(smoothV(tipPt), MID_WEIGHT * smoothV(midPt));
    const restDisp = Math.hypot(len(sub(now.tip, s.rest.tip)), MID_WEIGHT * len(sub(now.mid, s.rest.mid)), Math.abs(now.ext - s.rest.ext));
    s.disp = disp;
    s.out = outward;
    s.history.push({ t, d: sub(now.tip, s.rest.tip) });
    while (s.history.length && t - s.history[0].t > 500) s.history.shift();

    if (s.phase === 'idle') {
      if (speed < cfg.quietSpeed) {
        // Paused: strikes start from here. Rest recalibrates slowly toward wherever the limb usually sits.
        s.anchor = clonePair(now);
        const k = 1 - Math.exp(-body.dt / this.config.restSeconds);
        s.rest = lerpPair(s.rest, now, k);
      } else if (def.kind === 'arm' && windingUp(def, tTip)) {
        // Loading up (dropping for an uppercut, cocking out for a hook): the strike will start from here.
        s.anchor = clonePair(now);
      }
      if (visible && outward > cfg.onsetSpeed && disp > cfg.onsetDist && (strikeLike(def, tTip, tMid, disp) || extensionStrike(def, tTip, tExt, disp))) {
        Object.assign(s, { phase: 'onset', since: t, peakDisp: disp, peakSpeed: outward, peak: { ...tTip }, peakTip: { ...tipPt.p }, peakMid: { ...midPt.p }, peakMidRise: tMid.y, peakExt: tExt });
        out.push({ kind: 'anticipate', limb: name, t });
      }
      return;
    }

    if (s.phase === 'onset') {
      if (disp > s.peakDisp) Object.assign(s, { peakDisp: disp, peak: { ...tTip }, peakTip: { ...tipPt.p }, peakMid: { ...midPt.p }, peakMidRise: tMid.y, peakExt: tExt });
      s.peakSpeed = Math.max(s.peakSpeed, outward);
      const slowing = outward < s.peakSpeed * 0.35 && t - s.since > 40;
      if (!slowing && t - s.since < cfg.maxWindupMs) return;

      // Legs must also lift (knee or foot) above where they usually sit, so stepping isn't kicking.
      const lift = Math.max(s.peak.y, s.peakMidRise);
      const isStrike = s.peakDisp >= cfg.strikeDist && (def.kind === 'arm' || lift >= this.config.legRise);
      if (!isStrike) {
        s.phase = 'idle';
        out.push({ kind: 'cancel', limb: name, t });
        return;
      }
      const dir = normalize(s.peak);
      const strikeOut = dir.x * def.side;
      const speedRatio = s.peakSpeed / s.typicalSpeed;
      s.typicalSpeed += 0.2 * (s.peakSpeed - s.typicalSpeed);
      out.push({
        kind: 'strike',
        limb: name,
        t,
        onsetT: s.since,
        // Mostly elbow straightening with little visible hand travel: a straight punch at the camera.
        style: s.peakExt > len(s.peak) ? 'straight' : classify(def.kind, dir, strikeOut, s.peakTip, s.peakMid),
        height: heightOf(def.kind, s.peakTip, body),
        dir: { out: strikeOut, up: dir.y, fwd: dir.z },
        speed: clamp(0.8 + 0.5 * (speedRatio - 0.6), 0.8, 1.3),
        windup: windupOf(s, dir),
        reach: s.peakDisp,
      });
      s.phase = 'recover';
      s.since = t;
      return;
    }

    // Recover: ready again once the limb comes back near rest (or after a timeout).
    if (restDisp < cfg.returnDist || t - s.since > cfg.recoverMs) {
      s.phase = 'idle';
      s.anchor = clonePair(now);
    }
  }

  private updateCore(body: Body, out: Intent[]) {
    const cfg = this.config;
    const t = body.t;
    const nose = body.points[LM.nose];
    const quiet = Math.hypot(nose.v.x, nose.v.y) < 0.6 && Math.abs(body.root.vy) < 0.4;
    if (!this.headRest) this.headRest = { x: nose.p.x, y: nose.p.y };
    if (quiet) {
      const k = 1 - Math.exp(-body.dt / cfg.restSeconds);
      this.headRest.x += k * (nose.p.x - this.headRest.x);
      this.headRest.y += k * (nose.p.y - this.headRest.y);
    }

    // Duck: the head drops, by bending the knees (hips drop) or the waist (head drops toward the hips).
    const headDrop = this.headRest.y - nose.p.y - body.root.y;
    const dropSpeed = -(nose.v.y + body.root.vy);
    if (headDrop > cfg.duck.drop && dropSpeed > cfg.duck.speed && t - this.lastCore.duck > cfg.coreCooldownMs) {
      this.lastCore.duck = t;
      out.push({ kind: 'duck', t });
    }

    // Jump: the hips rise above their usual height. A little bounce counts; nobody has to leave the floor.
    if (body.root.y > cfg.jump.rise && body.root.vy > cfg.jump.speed && t - this.lastCore.jump > cfg.coreCooldownMs) {
      this.lastCore.jump = t;
      out.push({ kind: 'jump', t, power: clamp(body.root.y / (cfg.jump.rise * 3), 0.3, 1) });
    }

    // Dodge: the head leans sideways relative to the hips.
    const lean = nose.p.x - this.headRest.x;
    if (Math.abs(lean) > cfg.dodge.shift && Math.sign(nose.v.x) === Math.sign(lean) && Math.abs(nose.v.x) > cfg.dodge.speed
      && t - this.lastCore.dodge > cfg.coreCooldownMs) {
      this.lastCore.dodge = t;
      out.push({ kind: 'dodge', t, dir: lean > 0 ? 'L' : 'R' });
    }

    // Guard: both wrists up near the face.
    const lw = body.points[LM.lWrist].p;
    const rw = body.points[LM.rWrist].p;
    // Hysteresis: up inside the radius, down only once a hand is clearly away, so it doesn't flicker.
    const radius = this.guardUp ? cfg.guard.radius * 1.35 : cfg.guard.radius;
    const near = (w: Vec3) => Math.hypot(w.x - nose.p.x, w.y - nose.p.y) < radius;
    const striking = this.limbs.armL.phase === 'onset' || this.limbs.armR.phase === 'onset';
    const inGuard = near(lw) && near(rw) && !striking;
    if (inGuard === this.guardUp) this.guardSince = null;
    else {
      this.guardSince ??= t;
      if (t - this.guardSince >= cfg.guard.holdMs) {
        this.guardUp = inGuard;
        this.guardSince = null;
        out.push({ kind: 'guard', t, up: inGuard });
      }
    }

    const advance = body.scale > 1 + cfg.advance.in ? clamp((body.scale - 1 - cfg.advance.in) * 6, 0, 1)
      : body.scale < 1 - cfg.advance.out ? -clamp((1 - cfg.advance.out - body.scale) * 6, 0, 1) : 0;
    this.stance = {
      player: this.player,
      guard: this.guardUp,
      advance,
      lean: { x: clamp(lean / 0.5, -1, 1), y: clamp(-headDrop / 0.5, -1, 1) },
      tracked: true,
    };
    this.debug = {
      limbs: Object.fromEntries(LIMB_NAMES.map((n) => [n, { phase: this.limbs[n].phase, disp: this.limbs[n].disp, out: this.limbs[n].out }])) as IntentDebug['limbs'],
      headDrop,
      lean,
      rootY: body.root.y,
      rootVy: body.root.vy,
      scale: body.scale,
      guard: this.guardUp,
    };
  }
}

/** Temporary bridge to the current FightEngine commands, until the resolver picks moves from context. */
function toCommands(player: PlayerId, intents: Intent[]): Command[] {
  const commands: Command[] = [];
  for (const intent of intents) {
    if (intent.kind === 'anticipate' && (intent.limb === 'armL' || intent.limb === 'armR')) {
      commands.push({ kind: 'anticipate', player, t: intent.t, hand: intent.limb === 'armL' ? 'L' : 'R' });
    } else if (intent.kind === 'strike' && (intent.limb === 'armL' || intent.limb === 'armR')) {
      const hand = intent.limb === 'armL' ? 'L' : 'R';
      const move: AttackMove = intent.style === 'hook' ? 'hook' : intent.style === 'upper' ? 'uppercut' : hand === 'L' ? 'jab' : 'cross';
      commands.push({
        kind: 'attack', player, t: intent.t, move, hand,
        height: intent.height === 'high' ? 'head' : 'body',
        speed: intent.speed,
        windup: intent.windup,
      });
    } else if (intent.kind === 'duck') {
      commands.push({ kind: 'defend', player, t: intent.t, move: 'duck' });
    } else if (intent.kind === 'dodge') {
      commands.push({ kind: 'defend', player, t: intent.t, move: 'slip', dir: intent.dir });
    } else if (intent.kind === 'guard' && intent.up) {
      commands.push({ kind: 'defend', player, t: intent.t, move: 'block' });
    }
  }
  return commands;
}

/** Strikes go forward, up, or across the body. Drops, pull-backs and outward wind-ups aren't strikes. */
function strikeLike(def: LimbDef, tip: Vec3, mid: Vec3, disp: number) {
  const fwd = tip.z + mid.z;
  const up = tip.y + 0.5 * mid.y;
  const inward = -(tip.x + 0.5 * mid.x) * def.side;
  return Math.max(fwd, up, inward) > 0.35 * disp;
}

/**
 * The elbow straightening also counts as a strike (a punch at the camera), unless the hand is mostly
 * dropping or swinging outward: that's the dip before an uppercut or the wind-up before a hook.
 */
function extensionStrike(def: LimbDef, tip: Vec3, ext: number, disp: number) {
  return ext > 0.35 * disp && !windingUp(def, tip);
}

/** The hand has clearly traveled down or outward: loading up an uppercut or a hook, not striking yet. */
function windingUp(def: LimbDef, tip: Vec3) {
  const travel = len(tip);
  return travel > 0.12 && (tip.y < -0.6 * travel || tip.x * def.side > 0.6 * travel);
}

function classify(kind: 'arm' | 'leg', dir: Vec3, out: number, tip: Vec3, mid: Vec3): StrikeStyle {
  // Kick: the foot comes up near knee height. Knee strike: the knee rises with the foot tucked under it.
  if (kind === 'leg') return tip.y > mid.y - 0.3 ? 'kick' : 'knee';
  if (dir.y > 0.6) return 'upper';
  if (Math.abs(out) > 0.6) return 'hook';
  return 'straight';
}

function heightOf(kind: 'arm' | 'leg', end: Vec3, body: Body): 'high' | 'mid' | 'low' {
  if (kind === 'arm') {
    const shoulderY = (body.points[LM.lShoulder].p.y + body.points[LM.rShoulder].p.y) / 2;
    return end.y > shoulderY - 0.1 ? 'high' : 'mid';
  }
  return end.y > -0.35 ? 'high' : end.y > -0.75 ? 'mid' : 'low';
}

/** How far the limb pulled back (against the strike direction) just before it started. */
function windupOf(s: LimbState, dir: Vec3) {
  let back = 0;
  for (const h of s.history) if (h.t <= s.since) back = Math.max(back, -dot(h.d, dir));
  return clamp(0.8 + back * 1.25, 0.8, 1.3);
}

function newLimb(): LimbState {
  return {
    phase: 'idle', rest: null, anchor: null, since: 0, peakDisp: 0, peakSpeed: 0,
    peak: { x: 0, y: 0, z: 0 }, peakTip: { x: 0, y: 0, z: 0 }, peakMid: { x: 0, y: 0, z: 0 }, peakMidRise: 0, peakExt: 0, history: [], typicalSpeed: 4, disp: 0, out: 0,
  };
}

const clonePair = (p: Pair): Pair => ({ tip: { ...p.tip }, mid: { ...p.mid }, ext: p.ext });
const lerpPair = (a: Pair, b: Pair, k: number): Pair => ({
  ext: a.ext + k * (b.ext - a.ext),
  tip: { x: a.tip.x + k * (b.tip.x - a.tip.x), y: a.tip.y + k * (b.tip.y - a.tip.y), z: a.tip.z + k * (b.tip.z - a.tip.z) },
  mid: { x: a.mid.x + k * (b.mid.x - a.mid.x), y: a.mid.y + k * (b.mid.y - a.mid.y), z: a.mid.z + k * (b.mid.z - a.mid.z) },
});

function untracked(player: PlayerId): Stance {
  return { player, guard: false, advance: 0, lean: { x: 0, y: 0 }, tracked: false };
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const normalize = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
