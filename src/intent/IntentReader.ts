import type { AttackMove, Command, PlayerId, PoseFrame, Stance } from '../types';
import { LM, PosePreprocessor, type Body, type BodyPoint, type Vec3 } from './preprocess';
import { DEFAULT_INTENT, type Intent, type IntentConfig, type LimbConfig, type LimbName, type StrikeStyle } from './intents';
import { StyleMatcher, type Template } from './StyleMatcher';
import styleModel from './styleModel.json';

/** The shared style model, trained from everyone's guided-test sessions (test/intent/train.test.ts). */
const SHARED_MODEL = (styleModel as Template[]).length ? StyleMatcher.fromJSON(styleModel as Template[]) : null;

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
const MID_WEIGHT = 1.0;
/** How much elbow straightening counts (per 90° opened), next to tip travel in body units. */
const EXT_WEIGHT = 0.6;
/** Elbow angles from one camera wobble; ignore the first ~15° of opening. */
const EXT_DEADBAND = 0.1;
const LIMB_NAMES = Object.keys(LIMBS) as LimbName[];
const PARTNER: Record<LimbName, LimbName> = { armL: 'armR', armR: 'armL', legL: 'legR', legR: 'legL' };

/**
 * Tip and middle joint relative to the limb root, plus (arms) how open the elbow is, scaled by EXT_WEIGHT, and
 * (arms) where the head is relative to the same shoulder.
 */
type Pair = { tip: Vec3; mid: Vec3; ext: number; head: Vec3 };
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
  /** When the reach last grew (ms). */
  grewAt: number;
  /** Middle-joint (elbow/knee) rise from the anchor at the peak. */
  peakMidRise: number;
  /** Elbow-opening part of the displacement at the peak. */
  peakExt: number;
  /** How far the middle joint (elbow/knee) traveled at the peak. */
  peakMidTravel: number;
  /** How far the elbow flared outward at the peak (hooks flare, straights stay tucked). */
  peakMidOut: number;
  /** Where the hand was (body space) when the motion started. */
  anchorTip: Vec3;
  /** Elbow angle (degrees) at the peak. */
  peakElbow: number;
  history: { t: number; d: Vec3 }[];
  typicalSpeed: number;
  /** Where the limb was at its furthest after the last strike (recover phase), to see it retract. */
  extended: Pair | null;
  /** Distance from rest last frame: falling = the limb is coming back. */
  lastRestDisp: number;
  /** When the limb re-armed by pulling back from a strike before reaching rest (a combo in progress). */
  rearmedAt: number;
  /** Last time this hand was up by the face (in guard), and that time as of the current strike's onset. */
  nearFaceAt: number;
  faceBeforeOnset: number;
  /** Last time this hand was rising fast. */
  risingAt: number;
  /** Current tip travel from the anchor (to compare the two hands). */
  travel: Vec3;
  /** Both hands' positions (relative to their shoulders) when this strike began, to see what the other did meanwhile. */
  tipAtOnset: Vec3;
  otherAtOnset: Vec3;
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
  /** Timestamp of the last frame handed in, and of the one that was current when the player was lost. */
  private lastInputT = NaN;
  private lostFrameT = NaN;
  /** Usual head and shoulder-center positions, relative to the slow-moving home (so a whole-torso lean shows). */
  private headRest: { x: number; y: number } | null = null;
  private shoulderRest: { x: number; y: number } | null = null;
  /** Usual position of the feet (full-body framing): a moving camera moves them too, a duck or a slip doesn't. */
  private feetRest: { x: number; y: number } | null = null;
  private lastCore: Record<'jump' | 'duck' | 'dodge', number> = { jump: -Infinity, duck: -Infinity, dodge: -Infinity };
  /** A head move must hold for two frames in a row: one-frame tracking glitches throw the whole skeleton around. */
  private pendingCore: Record<'jump' | 'duck' | 'dodge', number> = { jump: -Infinity, duck: -Infinity, dodge: -Infinity };
  /** Last time each arm was throwing a strike. Punching moves the head; that isn't a dodge or a duck. */
  private lastArmStrike: Record<'armL' | 'armR', number> = { armL: -Infinity, armR: -Infinity };
  private guardSince: number | null = null;
  private guardUp = false;
  private stance: Stance;
  private debug: IntentDebug | null = null;
  /** The player's calibration examples, if any. Decides straight/hook/upper instead of the built-in rules. */
  private matcher: StyleMatcher | null = SHARED_MODEL;

  constructor(player: PlayerId, config: IntentConfig = DEFAULT_INTENT) {
    this.player = player;
    this.config = config;
    this.pre = new PosePreprocessor(config.preprocess);
    this.limbs = Object.fromEntries(LIMB_NAMES.map((n) => [n, newLimb()])) as Record<LimbName, LimbState>;
    this.stance = untracked(player);
  }

  /** Use (or stop using, with null) a player's calibration examples for telling strikes apart. */
  setMatcher(matcher: StyleMatcher | null) {
    this.matcher = matcher;
  }

  /** Live tuning. */
  setConfig(config: IntentConfig) {
    this.config = config;
    this.pre.setConfig(config.preprocess);
  }

  reset() {
    this.pre.reset();
    this.resetLimbs();
    this.body = null;
    this.lostFrameT = NaN;
    this.stance = untracked(this.player);
  }

  private resetLimbs() {
    for (const n of LIMB_NAMES) this.limbs[n] = newLimb();
    // Cooldowns are on the frame clock, which restarts when a peer reloads: stale ones would block for minutes.
    this.lastCore = { jump: -Infinity, duck: -Infinity, dodge: -Infinity };
    this.pendingCore = { jump: -Infinity, duck: -Infinity, dodge: -Infinity };
    this.lastArmStrike = { armL: -Infinity, armR: -Infinity };
    this.headRest = null;
    this.shoulderRest = null;
    this.feetRest = null;
    this.guardSince = null;
    this.guardUp = false;
  }

  /**
   * Call every tick with the latest frame. Repeated frames return no new intents.
   * `now` is the host clock, used only to notice a lost player (remote frames carry the other laptop's clock).
   */
  update(frame: PoseFrame | null, now: number = performance.now()): IntentOutput {
    // The hub keeps handing over a lost player's last frame. Once they've gone stale, that frame isn't
    // tracking again (the reset below would otherwise accept it as new and flip back to tracked).
    if (frame && frame.t === this.lostFrameT) frame = null;
    if (frame) this.lastInputT = frame.t;
    const body = frame ? this.pre.process(frame) : null;
    if (body) this.lastNewFrameAt = now;
    if (now - this.lastNewFrameAt > this.config.staleMs) {
      if (this.body) {
        this.reset();
        this.lostFrameT = this.lastInputT;
      }
      return { commands: [], stance: this.stance, intents: [], body: null, debug: null };
    }
    if (!body) return { commands: [], stance: this.stance, intents: [], body: this.body, debug: this.debug };
    // The preprocessor restarted after a gap in the frames (dt = 0): limb states from before the gap are stale.
    if (body.dt === 0 && this.body) this.resetLimbs();
    this.body = body;

    const intents: Intent[] = [];
    for (const name of LIMB_NAMES) this.updateLimb(name, body, intents);
    this.bothArmsTogether(body.t, intents);
    this.updateCore(body, intents);
    return { commands: toCommands(this.player, intents), stance: this.stance, intents, body, debug: this.debug };
  }

  /**
   * A strike this frame while the other hand (or leg) made the same move at the same time (both just struck, or
   * the other is mid wind-up going the same way) is the body or the camera moving, not two punches: twisting or
   * ducking with the guard up, a camera jolt, both knees coming up in a jump. Checked after all limbs are up to
   * date, so the comparison isn't a frame stale.
   */
  private bothArmsTogether(t: number, out: Intent[]) {
    for (const name of LIMB_NAMES) {
      const i = out.findIndex((x) => x.kind === 'strike' && x.limb === name);
      if (i < 0) continue;
      const other = PARTNER[name];
      const otherNow = out.some((x) => x.kind === 'strike' && x.limb === other);
      // Both striking on the same frame with mirror-image motion (both elbows coming up as the shoulders drop
      // into a duck, both hands lifting into a block) is the body moving too.
      const mirrored = otherNow && mirrorImage(this.limbs[name], LIMBS[name].side, this.limbs[other], LIMBS[other].side);
      if (!mirrored && !movedTogether(this.limbs[name].peak, this.limbs[other], t, otherNow)) continue;
      out.splice(i, 1, { kind: 'cancel', limb: name, t, reason: 'both hands moved' });
      this.limbs[name].phase = 'idle';
      if (otherNow) {
        const j = out.findIndex((x) => x.kind === 'strike' && x.limb === other);
        out.splice(j, 1, { kind: 'cancel', limb: other, t, reason: 'both hands moved' });
        this.limbs[other].phase = 'idle';
        return;
      }
    }
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
      : body.fullBodyFor > 1000 && tipPt.visibility > 0.5 && midPt.visibility > 0.5;
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
    const nosePt = body.points[LM.nose];
    const head = legs ? ZERO : { x: nosePt.p.x - root.p.x, y: nosePt.p.y - root.p.y, z: 0 };
    const now: Pair = { tip: relOf(tipPt), mid: relOf(midPt), ext, head };
    if (!s.rest) s.rest = clonePair(now);
    if (!s.anchor) s.anchor = clonePair(now);
    // A hand held up in guard rides along with the head: when the torso twists or leans (throwing the other hand,
    // slipping, ducking), that isn't this hand punching. So a guard hand's travel is measured against the head.
    const restFace = Math.hypot(s.rest.tip.x - s.rest.head.x, s.rest.tip.y - s.rest.head.y);
    const guardHand = legs ? 0 : clamp((1.6 * this.config.guard.radius - restFace) / (0.6 * this.config.guard.radius), 0, 1);
    const tipTravel = (a: Pair, b: Pair): Vec3 => ({ x: a.tip.x - b.tip.x - guardHand * (a.head.x - b.head.x), y: a.tip.y - b.tip.y - guardHand * (a.head.y - b.head.y), z: a.tip.z - b.tip.z });
    const headVel = legs ? ZERO : { x: nosePt.vf.x - root.vf.x, y: nosePt.vf.y - root.vf.y, z: 0 };
    const tipVel = velOf(tipPt);
    const vel = { tip: { x: tipVel.x - guardHand * headVel.x, y: tipVel.y - guardHand * headVel.y, z: tipVel.z }, mid: velOf(midPt) };

    // Travel since the last pause, tip and middle joint together.
    const tTip = tipTravel(now, s.anchor);
    const tMid = sub(now.mid, s.anchor.mid);
    // Only opening the elbow counts (bending it back is a retraction).
    const tExt = Math.max(0, now.ext - s.anchor.ext - EXT_DEADBAND);
    const disp = Math.hypot(len(tTip), MID_WEIGHT * len(tMid), tExt);
    const outward = disp > 1e-3 ? (dot(vel.tip, tTip) + MID_WEIGHT * MID_WEIGHT * dot(vel.mid, tMid) + tExt * extV) / disp : 0;
    // Resting is judged on the smooth channel: the fast one is too jittery to ever look still.
    const smoothV = (p: BodyPoint) => Math.hypot(p.v.x - root.v.x, p.v.y - root.v.y);
    const speed = Math.hypot(smoothV(tipPt), MID_WEIGHT * smoothV(midPt));
    const restDisp = Math.hypot(len(tipTravel(now, s.rest)), MID_WEIGHT * len(sub(now.mid, s.rest.mid)), Math.abs(now.ext - s.rest.ext));
    if (!legs && Math.hypot(tipPt.p.x - nosePt.p.x, tipPt.p.y - nosePt.p.y) < this.config.guard.radius) s.nearFaceAt = t;
    if (!legs && vel.tip.y > 1.0) s.risingAt = t;
    const retracting = restDisp < s.lastRestDisp - 0.004;
    s.lastRestDisp = restDisp;
    s.disp = disp;
    s.out = outward;
    s.travel = tTip;
    s.history.push({ t, d: tipTravel(now, s.rest) });
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
      } else if (retracting && t - s.rearmedAt < 400) {
        // Coming back from the last strike: the next one starts from wherever the retraction turns around
        // (fast combos never get back to guard).
        s.anchor = clonePair(now);
      }
      // A hand dropping fast (back to the lap, or lowering the guard) can't be starting a punch.
      const dropping = def.kind === 'arm' && vel.tip.y < -1.2;
      // An arm already up in the air (elbow at shoulder height, hand above it: waving, a hand on the head) isn't
      // throwing a punch, whatever it does next. Punches start from a guard, elbow down.
      const raised = def.kind === 'arm' && s.anchor.mid.y > -0.15 && s.anchor.tip.y - s.anchor.mid.y > 0.25;
      if (visible && !dropping && !raised && outward > cfg.onsetSpeed && disp > cfg.onsetDist && (strikeLike(def, tTip, tMid, disp) || extensionStrike(def, tTip, tExt, disp))) {
        if (!legs) {
          const o = body.points[def.side === 1 ? LM.rWrist : LM.lWrist].p, os = body.points[def.side === 1 ? LM.rShoulder : LM.lShoulder].p;
          s.otherAtOnset = { x: o.x - os.x, y: o.y - os.y, z: 0 };
          s.tipAtOnset = { x: tipPt.p.x - root.p.x, y: tipPt.p.y - root.p.y, z: 0 };
        }
        Object.assign(s, { phase: 'onset', since: t, grewAt: t, faceBeforeOnset: s.nearFaceAt, peakDisp: disp, peakSpeed: outward, peak: { ...tTip }, peakTip: { ...tipPt.p }, peakMid: { ...midPt.p }, peakMidRise: tMid.y, peakExt: tExt, peakMidTravel: len(tMid), peakMidOut: tMid.x * def.side, peakElbow: legs ? 0 : body.elbow[side], anchorTip: { x: tipPt.p.x - tTip.x, y: tipPt.p.y - tTip.y, z: tipPt.p.z } });
        out.push({ kind: 'anticipate', limb: name, t });
      }
      return;
    }

    if (s.phase === 'onset') {
      if (disp > s.peakDisp) Object.assign(s, { grewAt: t, peakDisp: disp, peak: { ...tTip }, peakTip: { ...tipPt.p }, peakMid: { ...midPt.p }, peakMidRise: tMid.y, peakExt: tExt, peakMidTravel: len(tMid), peakMidOut: tMid.x * def.side, peakElbow: legs ? 0 : body.elbow[side] });
      s.peakSpeed = Math.max(s.peakSpeed, outward);
      // Confirm as soon as it has traveled far enough (don't wait for the arm to slow down: that costs most
      // of the punch). Give up if it slows down short of that.
      // Arms only: a leg needs its full rise to tell a knee from a kick. A hand starting low waits too, to see
      // whether it's an uppercut or just the guard coming up.
      const shoulderY = (body.points[LM.lShoulder].p.y + body.points[LM.rShoulder].p.y) / 2;
      const fromLow = s.anchorTip.y < shoulderY - 0.8;
      // Same bar with the guard up: people fight from their guard, and a punch out of it is still a punch.
      const needed = cfg.strikeDist;
      // A hand going up with the elbow coming up to the shoulder may be heading over the head (a scratch, a wave):
      // wait for it to peak to see where it ends. Uppercuts keep the elbow down and don't wait.
      const raising = def.kind === 'arm' && tTip.y > 0.6 * len(tTip) && midPt.p.y > root.p.y - 0.15;
      const farEnough = def.kind === 'arm' && !fromLow && !raising && s.peakDisp >= needed && t - s.since >= (cfg.confirmMs ?? 60);
      // Peaked: the reach hasn't grown for 60 ms. (Not "the speed dropped": the fast signal wobbles mid-punch,
      // and judging then cuts the punch short.)
      const slowing = t - s.grewAt >= 60;
      if (!farEnough && !slowing && t - s.since < cfg.maxWindupMs) return;

      // Legs must also lift (knee or foot) above where they usually sit, so stepping isn't kicking.
      const lift = Math.max(s.peak.y, s.peakMidRise);
      // Punches don't travel down: an arm straightening as the hand drops (back to the lap) isn't a strike.
      const goingDown = def.kind === 'arm' && s.peak.y < -0.15 && s.peak.y < -0.5 * len(s.peak);
      const reason = s.peakDisp < needed || (def.kind === 'leg' && lift < this.config.legRise) ? 'too small'
        : goingDown ? 'going down'
        : def.kind === 'arm' && raisingGuard(body, name, s.anchorTip, tipPt.p, this.config.guard.radius, t - this.limbs[name === 'armL' ? 'armR' : 'armL'].risingAt < 400) ? 'raising guard'
        : def.kind === 'arm' && bothHandsUp(body, name, s.peak, s.since - s.faceBeforeOnset > 600 && t - this.limbs[name === 'armL' ? 'armR' : 'armL'].risingAt < 250) ? 'both hands up'
        : def.kind === 'arm' && raisedOverHead(body, s.peakTip, s.peak, midPt.p, root.p) ? 'not a punch'
        : def.kind === 'arm' && otherHandAlong(body, def, s, tipPt.p, root.p) ? 'both hands moved'
        // A hand pulled in across the body with the elbow tucking in and staying down is the guard closing up (the
        // other hand's usual move while one hand punches), not a hook: a hook brings the elbow up.
        : def.kind === 'arm' && s.peakMidRise < 0.08 && s.peakMidOut < -0.05 && sweepsIn(def, s.peak) ? 'not a punch'
        : null;
      if (reason) {
        s.phase = 'idle';
        out.push({ kind: 'cancel', limb: name, t, reason });
        return;
      }
      const dir = normalize(s.peak);
      const strikeOut = dir.x * def.side;
      const speedRatio = s.peakSpeed / s.typicalSpeed;
      s.typicalSpeed += 0.2 * (s.peakSpeed - s.typicalSpeed);
      const features = def.kind === 'arm' ? strikeFeatures(def, s, root.p) : undefined;
      const ruleStyle: StrikeStyle = def.kind === 'arm' && Math.abs(s.peak.x) <= 0.45 && (s.peakExt > len(s.peak) || s.peakExt > 0.15 || len(s.peak) < 0.6 * s.peakMidTravel)
        ? 'straight'
        : classify(def.kind, dir, strikeOut, s.peakTip, s.peakMid, s.peakMidOut, s.peak, s.peakMidRise, s.peakExt, s.peakElbow);
      const style = features && this.matcher ? this.matcher.decide(features, ruleStyle) : ruleStyle;
      out.push({
        kind: 'strike',
        limb: name,
        t,
        onsetT: s.since,
        // The player's own examples win when calibrated. Otherwise: straight if the elbow straightened a lot, or
        // if the elbow moved but the hand barely moved in the image (a fist coming at the camera); hooks and
        // uppercuts move the hand a lot with the elbow bent.
        style,
        height: heightOf(def.kind, s.peakTip, body),
        dir: { out: strikeOut, up: dir.y, fwd: dir.z },
        speed: clamp(0.8 + 0.5 * (speedRatio - 0.6), 0.8, 1.3),
        windup: windupOf(s, dir),
        reach: s.peakDisp,
        rawSpeed: s.peakSpeed,
        features,
      });
      s.phase = 'recover';
      s.since = t;
      s.extended = clonePair(now);
      return;
    }

    // Recover: ready again once the limb comes back near rest, or has clearly pulled back from its furthest
    // point (a combo: the next punch starts before the hand gets home), or after a timeout.
    const ext0 = s.extended ?? now;
    const fromAnchor = (q: Pair) => Math.hypot(len(tipTravel(q, s.anchor!)), MID_WEIGHT * len(sub(q.mid, s.anchor!.mid)), Math.max(0, q.ext - s.anchor!.ext - EXT_DEADBAND));
    if (fromAnchor(now) > fromAnchor(ext0)) s.extended = clonePair(now);
    const pulledBack = Math.hypot(len(tipTravel(now, s.extended!)), MID_WEIGHT * len(sub(now.mid, s.extended!.mid)), Math.abs(now.ext - s.extended!.ext));
    const home = restDisp < cfg.returnDist;
    if (home || pulledBack > Math.max(cfg.onsetDist, 0.35 * s.peakDisp) || t - s.since > cfg.recoverMs) {
      s.phase = 'idle';
      s.anchor = clonePair(now);
      if (!home) s.rearmedAt = t;
    }
  }

  private updateCore(body: Body, out: Intent[]) {
    const cfg = this.config;
    const t = body.t;
    const nose = body.points[LM.nose];
    const ls = body.points[LM.lShoulder];
    const rs = body.points[LM.rShoulder];
    // Head and shoulders relative to the slow-moving home, not to the hips: sitting, the "hips" are estimated from
    // the shoulders, and a seated lean moves the shoulders along with the head.
    const head = { x: nose.p.x + body.root.x, y: nose.p.y + body.root.y };
    const headV = { x: nose.v.x + body.root.vx, y: nose.v.y + body.root.vy };
    const shoulders = { x: (ls.p.x + rs.p.x) / 2 + body.root.x, y: (ls.p.y + rs.p.y) / 2 + body.root.y };
    const quiet = Math.hypot(headV.x, headV.y) < 0.6 && Math.abs(body.root.vy) < 0.4;
    if (!this.headRest) this.headRest = { ...head };
    if (!this.shoulderRest) this.shoulderRest = { ...shoulders };
    // Feet, when the whole body is in view: a handheld or bumped camera shifts them along with everything else.
    const la = body.points[LM.lAnkle];
    const ra = body.points[LM.rAnkle];
    const feetSeen = body.fullBodyFor > 1000 && la.visibility > 0.5 && ra.visibility > 0.5;
    const feet = feetSeen ? { x: (la.p.x + ra.p.x) / 2 + body.root.x, y: (la.p.y + ra.p.y) / 2 + body.root.y } : null;
    if (!feet) this.feetRest = null;
    else if (!this.feetRest) this.feetRest = { ...feet };
    if (quiet) {
      const k = 1 - Math.exp(-body.dt / cfg.restSeconds);
      this.headRest.x += k * (head.x - this.headRest.x);
      this.headRest.y += k * (head.y - this.headRest.y);
      this.shoulderRest.x += k * (shoulders.x - this.shoulderRest.x);
      this.shoulderRest.y += k * (shoulders.y - this.shoulderRest.y);
      if (feet && this.feetRest) (this.feetRest.x += k * (feet.x - this.feetRest.x)), (this.feetRest.y += k * (feet.y - this.feetRest.y));
    }
    const feetShift = feet && this.feetRest ? { x: feet.x - this.feetRest.x, y: feet.y - this.feetRest.y } : { x: 0, y: 0 };
    // Throwing a punch twists the torso and dips the head: a right punch swings the head to the player's left,
    // a left punch to the right. Around a punch, a head move has to be much bigger to count.
    for (const n of ['armL', 'armR'] as const) if (this.limbs[n].phase === 'onset') this.lastArmStrike[n] = t;
    const since = (n: 'armL' | 'armR') => t - this.lastArmStrike[n];
    const punching = Math.min(since('armL'), since('armR')) < 500;
    /** A head move starts on a frame that passes `start` and counts if the next frame still passes `hold`. */
    const held = (kind: 'jump' | 'duck' | 'dodge', start: boolean, hold: boolean) => {
      if (t - this.pendingCore[kind] <= 150 && hold) return true;
      this.pendingCore[kind] = start ? t : -Infinity;
      return false;
    };

    // Duck: the head drops, by bending the knees (hips drop) or the waist (head drops toward the hips).
    const headDrop = this.headRest.y - head.y + feetShift.y;
    const dropSpeed = -headV.y;
    const duckK = punching ? 1.6 : 1;
    const dropping = headDrop > cfg.duck.drop * duckK;
    if (held('duck', dropping && dropSpeed > cfg.duck.speed, dropping && dropSpeed > -cfg.duck.speed) && t - this.lastCore.duck > cfg.coreCooldownMs) {
      this.lastCore.duck = t;
      out.push({ kind: 'duck', t });
    }

    // Jump: the hips rise above their usual height, and the head with them (a real hop, not a bounce on the toes).
    // Needs visible hips: when sitting, "hips" are estimated from the shoulders and every bob would count.
    // (Judged against the room, not the feet: in a jump the feet leave the floor too.)
    const up = body.fullBodyFor > 1000 && body.root.y > cfg.jump.rise && head.y - this.headRest.y > cfg.jump.rise * 0.7;
    if (held('jump', up && body.root.vy > cfg.jump.speed, up) && t - this.lastCore.jump > cfg.coreCooldownMs) {
      this.lastCore.jump = t;
      out.push({ kind: 'jump', t, power: clamp(body.root.y / (cfg.jump.rise * 3), 0.3, 1) });
    }

    // Dodge: the head leans sideways, and the shoulders go with it (turning or tilting just the head isn't a slip).
    const lean = head.x - this.headRest.x - feetShift.x;
    const shoulderLean = shoulders.x - this.shoulderRest.x - feetShift.x;
    // The side a punch throws the head to needs the most, as long as that arm is still out.
    const thrower = lean > 0 ? 'armR' : 'armL';
    const dodgeK = this.limbs[thrower].phase !== 'idle' ? 3 : since(thrower) < 500 ? 2.5 : punching ? 1.6 : 1;
    // Not while ducking: a duck usually tilts the head too.
    // The head leads: in a slip or a seated lean the head travels further than the shoulders. When everything
    // shifts the same amount, it's the camera moving (or a step), not a slip.
    const leaning = Math.abs(lean) > cfg.dodge.shift * dodgeK && shoulderLean * Math.sign(lean) > 0.2 * Math.abs(lean)
      && (lean - shoulderLean) * Math.sign(lean) > 0.15 * Math.abs(lean) && headDrop < cfg.duck.drop * 0.6;
    const leaningFast = leaning && Math.sign(headV.x) === Math.sign(lean) && Math.abs(headV.x) > cfg.dodge.speed;
    if (held('dodge', leaningFast, leaning && headV.x * Math.sign(lean) > -cfg.dodge.speed) && t - this.lastCore.dodge > cfg.coreCooldownMs) {
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

/**
 * The shape of an arm strike, mirrored so left and right arms compare: hand and elbow travel, how much the
 * elbow opened, and where the hand started and ended relative to the shoulder.
 */
function strikeFeatures(def: LimbDef, s: LimbState, shoulder: Vec3): number[] {
  const m = def.side;
  return [
    // Which arm, softly: same-arm examples count more (left and right look different at an angle).
    m * 0.3,
    s.peak.x * m, s.peak.y, s.peak.z,
    s.peakMidOut, s.peakMidRise,
    s.peakExt / EXT_WEIGHT,
    s.peakElbow / 180,
    (s.anchorTip.x - shoulder.x) * m, s.anchorTip.y - shoulder.y,
    (s.peakTip.x - shoulder.x) * m, s.peakTip.y - shoulder.y,
  ];
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

/**
 * Both hands rising at the same time is putting a guard up, or throwing your hands up, not two uppercuts. Real
 * uppercuts are one hand at a time. `bothCameUp`: this hand came up from low (not from guard) right as the
 * other one rose too.
 */
function bothHandsUp(body: Body, limb: LimbName, travel: Vec3, bothCameUp: boolean) {
  if (travel.y < 0.15 || travel.y < 0.5 * len(travel)) return false;
  const other = body.points[limb === 'armL' ? LM.rWrist : LM.lWrist];
  const otherShoulder = body.points[limb === 'armL' ? LM.rShoulder : LM.lShoulder];
  return bothCameUp || other.vf.y - otherShoulder.vf.y > 1.0;
}

/**
 * A hand going up over the head with the elbow raised (scratching it, waving, fixing hair, hands in the air)
 * isn't a punch: punches end at the opponent's head or body.
 */
function raisedOverHead(body: Body, end: Vec3, travel: Vec3, elbow: Vec3, shoulder: Vec3) {
  const nose = body.points[LM.nose].p;
  // The elbow comes up to shoulder height too: an uppercut can finish high, but its elbow stays down.
  return end.y > nose.y + 0.2 && travel.y > 0.5 * len(travel) && elbow.y > shoulder.y - 0.1;
}

/** The hand swept in toward the body's center more than it went anywhere else (a hook's path, or a guard tuck). */
function sweepsIn(def: LimbDef, travel: Vec3) {
  return -travel.x * def.side > 0.6 * len(travel);
}

/** The two limbs' peak motions (hand and middle joint) are mirror images of each other, side for side. */
function mirrorImage(a: LimbState, sideA: number, b: LimbState, sideB: number) {
  // In each limb's own frame: x outward from its side, y up.
  const va = { x: a.peak.x * sideA + a.peakMidOut, y: a.peak.y + a.peakMidRise };
  const vb = { x: b.peak.x * sideB + b.peakMidOut, y: b.peak.y + b.peakMidRise };
  const la = Math.hypot(va.x, va.y), lb = Math.hypot(vb.x, vb.y);
  if (la < 0.05 || lb < 0.5 * la || lb > 2 * la) return false;
  return (va.x * vb.x + va.y * vb.y) / (la * lb) > 0.8;
}

/**
 * Over this strike's own wind-up, the other hand moved the same way by a comparable amount: both hands going up
 * into a block, or both carried by the body. Real follow-up punches come while the other hand pulls back.
 */
function otherHandAlong(body: Body, def: LimbDef, s: LimbState, tip: Vec3, shoulder: Vec3) {
  const o = body.points[def.side === 1 ? LM.rWrist : LM.lWrist].p, os = body.points[def.side === 1 ? LM.rShoulder : LM.lShoulder].p;
  const ox = o.x - os.x - s.otherAtOnset.x, oy = o.y - os.y - s.otherAtOnset.y;
  const mx = tip.x - shoulder.x - s.tipAtOnset.x, my = tip.y - shoulder.y - s.tipAtOnset.y;
  const a = Math.hypot(mx, my), b = Math.hypot(ox, oy);
  if (a < 0.05 || b < 0.5 * a) return false;
  return (mx * ox + my * oy) / (a * b) > 0.8;
}

/**
 * Both hands moving the same way at the same time is the body (or the tracking) moving, not two punches:
 * ducking or twisting with the guard up, or MediaPipe jumping the whole skeleton for a frame.
 */

function movedTogether(travel: Vec3, other: LimbState, t: number, otherStruckNow = false) {
  const busy = otherStruckNow || other.phase === 'onset' || (other.phase === 'recover' && t - other.since < 100);
  if (!busy) return false;
  const o = other.phase === 'onset' ? other.travel : other.peak;
  const a = Math.hypot(travel.x, travel.y);
  const b = Math.hypot(o.x, o.y);
  if (a < 1e-3 || b < 1e-3 || b < 0.5 * a || b > 2 * a) return false;
  return (travel.x * o.x + travel.y * o.y) / (a * b) > 0.7;
}

/**
 * Bringing a hand up from the lap or a relaxed low position into the guard zone (by the face) is putting
 * your guard up, not an uppercut. Real uppercuts start from guard height.
 */

function raisingGuard(body: Body, limb: LimbName, start: Vec3, end: Vec3, radius: number, otherRose: boolean) {
  const nose = body.points[LM.nose].p;
  const shoulderY = (body.points[LM.lShoulder].p.y + body.points[LM.rShoulder].p.y) / 2;
  // Lap level, not just a low guard: plenty of people punch (and uppercut) from below the shoulders.
  const startedLow = start.y < shoulderY - 0.8;
  // Ends by the face, or anywhere around shoulder height (some people hold their hands lower).
  const endsUp = Math.hypot(end.x - nose.x, end.y - nose.y) < radius * 1.2 || end.y > shoulderY - 0.25;
  // A guard is two hands: this one joins the other by the face, or both came up together. One hand shooting up
  // from the lap on its own is a punch (seated players rest their hands in their lap between punches).
  const other = body.points[limb === 'armL' ? LM.rWrist : LM.lWrist].p;
  const otherUp = Math.hypot(other.x - nose.x, other.y - nose.y) < radius * 1.2;
  return startedLow && endsUp && (otherUp || otherRose);
}

/** An uppercut's forearm stands within this of vertical (radians); laid over further, a rising fist is a hook. */
const UPPER_MAX_TILT = (30 * Math.PI) / 180;

function classify(kind: 'arm' | 'leg', dir: Vec3, out: number, tip: Vec3, mid: Vec3, midOut: number, travel: Vec3, midRise: number, ext = 0, elbow = 180): StrikeStyle {
  // Kick: the foot comes up near knee height. Knee strike: the knee rises with the foot tucked under it.
  if (kind === 'leg') return tip.y > mid.y - 0.3 ? 'kick' : 'knee';
  // A big sideways sweep is a hook (or a haymaker), however straight the arm.
  if (Math.abs(travel.x) > 0.45 && Math.abs(out) > 0.6) return 'hook';
  // Uppercut: the fist drives up much more than the elbow (a punch at the camera lifts the elbow more), with the forearm
  // standing up: fist over the elbow. A rising fist with the forearm laid over (swinging across the chest) is a hook,
  // the punch most real players throw (vision-labeled 1v1 rounds: 135 of 151 rising reads were hooks). The forearm's
  // tilt holds up when the camera is off to the side, where sideways travel doesn't.
  if (dir.y > 0.6 && travel.y > 0.3 && travel.y > 1.5 * midRise) {
    const tilt = Math.atan2(Math.abs(tip.x - mid.x), tip.y - mid.y);
    return tilt > UPPER_MAX_TILT ? 'hook' : 'upper';
  }
  // Smaller sideways swing with the elbow flared: a tight hook. A cross drifts inward but stays tucked.
  if (Math.abs(out) > 0.6 && midOut > 0.05) return 'hook';
  // Fist sweeping across the body with the elbow staying bent (a cross straightens the elbow as it drifts in).
  const inward = -out * len(travel);
  if (inward > 0.2 && inward >= 0.8 * travel.y && ext < 0.1 && elbow < 100) return 'hook';
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
    phase: 'idle', rest: null, anchor: null, since: 0, grewAt: 0, peakDisp: 0, peakSpeed: 0,
    peak: { x: 0, y: 0, z: 0 }, peakTip: { x: 0, y: 0, z: 0 }, peakMid: { x: 0, y: 0, z: 0 }, peakMidRise: 0, peakExt: 0, peakMidTravel: 0, peakMidOut: 0, anchorTip: { x: 0, y: 0, z: 0 }, peakElbow: 0, history: [], typicalSpeed: 4, extended: null, lastRestDisp: 0, rearmedAt: -Infinity, nearFaceAt: -Infinity, faceBeforeOnset: -Infinity, risingAt: -Infinity, travel: { x: 0, y: 0, z: 0 }, tipAtOnset: { x: 0, y: 0, z: 0 }, otherAtOnset: { x: 0, y: 0, z: 0 }, disp: 0, out: 0,
  };
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const clonePair = (p: Pair): Pair => ({ tip: { ...p.tip }, mid: { ...p.mid }, ext: p.ext, head: { ...p.head } });
const lerpPair = (a: Pair, b: Pair, k: number): Pair => ({
  ext: a.ext + k * (b.ext - a.ext),
  head: { x: a.head.x + k * (b.head.x - a.head.x), y: a.head.y + k * (b.head.y - a.head.y), z: 0 },
  tip: { x: a.tip.x + k * (b.tip.x - a.tip.x), y: a.tip.y + k * (b.tip.y - a.tip.y), z: a.tip.z + k * (b.tip.z - a.tip.z) },
  mid: { x: a.mid.x + k * (b.mid.x - a.mid.x), y: a.mid.y + k * (b.mid.y - a.mid.y), z: a.mid.z + k * (b.mid.z - a.mid.z) },
});

/** Lost players hold guard (SPEC "Tracking loss"), like Game's stance for a player with no frames at all. */
function untracked(player: PlayerId): Stance {
  return { player, guard: true, advance: 0, lean: { x: 0, y: 0 }, tracked: false };
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const normalize = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
