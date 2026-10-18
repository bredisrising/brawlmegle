import type { Landmark, PoseFrame } from '../types';
import { SCAN_DEFAULTS, classify, estimateFacing, type Bucket, type Facing, type Tier } from './scanBuckets';

/**
 * The guided scan, with no DOM: what to tell the player, when to take each photo, and how full the ring is.
 * src/forge/scan.ts feeds it camera frames and sharpness scores; the tests feed it synthetic poses.
 *
 *   find       get in frame: step back / come closer / face the camera (coached from the landmarks)
 *   countdown  3-2-1 facing the camera; the best-framed, sharpest front frame in that window is the front photo
 *   snap       shutter flash, the front photo is in (that alone is enough to forge, so skipping is allowed from here)
 *   turn       a slow 360 to their left: the ring fills from the facing estimate, but never slower than a set pace,
 *              so it always finishes in a few seconds; side photos are taken whenever a side is toward the camera
 *   outro      "Scan complete", then done
 *
 * Times are ms from the start of the scan. Directions are the player's own (`left` = their left side toward the camera).
 */

export type ScanStage = 'find' | 'countdown' | 'snap' | 'turn' | 'outro' | 'done';
/** What's wrong with how they stand right now (null = nothing). */
export type Coach = 'enter' | 'hips' | 'head' | 'close' | 'far' | 'left' | 'right' | 'face' | 'arms';
/** Where a photo can go: the front photo (taken in the countdown), a spare front from any time before it, the sides. */
export type Slot = 'front' | 'spare' | 'left' | 'right';
export type Tick = 'front' | 'left' | 'back' | 'right';

export const GUIDE_DEFAULTS = {
  /** Framing has to look right this long before the countdown starts... */
  settleMs: 500,
  /** ...unless they've been in view this long (sitting, a cramped booth): then go with what we see. */
  patienceMs: 4000,
  /** Nobody in view at all this long: give up (the forge then says nobody was in view). */
  nobodyMs: 12000,
  /** No front photo after this long however it goes (someone stuck right up against the camera): give up. */
  findMaxMs: 30000,
  /** The pose model warming up doesn't count as nobody in view, for up to this long. */
  maxWarmupMs: 20000,
  /** One countdown beat (3, 2, 1). */
  beatMs: 700,
  /** No front-facing frame by the end of the countdown: wait this much longer for one, then take the best we had. */
  graceMs: 2000,
  /** The "got it" moment after the shutter, before the turn starts. */
  snapMs: 800,
  /** The ring fills in this long by time alone (the minimum pace). */
  turnMs: 7000,
  /** ...and never takes longer than this, even while waiting on a slow turner. */
  turnMaxMs: 9500,
  /** While they're visibly turning but behind the pace, the pace slows to this fraction... */
  waitPace: 0.4,
  /** ...and to this while they're in view but haven't started (it still finishes by turnMaxMs). */
  idlePace: 0.75,
  /** "Scan complete" stays up this long. */
  outroMs: 900,
  /** Torso (shoulders to hips) over image height: bigger is too close, smaller is too far. */
  closeTorso: 0.5,
  farTorso: 0.12,
  /** Shoulder midpoint must be inside this band of the image width. */
  centerBand: 0.24,
  minVisibility: 0.5,
};
export type GuideOptions = typeof GUIDE_DEFAULTS & typeof SCAN_DEFAULTS;

export type Framing = {
  /** 0 nobody, 1 head and shoulders only, 2 down to the hips, 3 the knees, 4 the whole body. */
  level: 0 | 1 | 2 | 3 | 4;
  /** The most important thing to fix, or null. */
  coach: Coach | null;
  /** Arms down (not over the body), the way the forge's character sheet wants them. */
  armsDown: boolean;
};

export type ScanView = {
  stage: ScanStage;
  /** 3, 2, 1 during the countdown. */
  count: number | null;
  /** The big line. */
  hint: string;
  /** Coaching under it (framing during find/countdown, what got captured during the turn). */
  coach: string;
  coachKind: Coach | null;
  /** 0–1 around the ring during the turn. */
  ring: number;
  /** The ring's four marks in order (front at the top, then the side they turn to first, the back, the other side). */
  ticks: { tick: Tick; at: number; hit: boolean }[];
  /** Photos so far: 0 none, 1 usable, 2 good (sides: a true profile). The front is 1 when it's a fallback. */
  shots: Record<Bucket, Tier>;
  /** Bumps on every snap (shutter flash); `flashOn` is what it was for. */
  flash: number;
  flashOn: Tick | null;
  /** The front photo is in: "Done: forge with the front photo" is allowed. */
  canSkip: boolean;
  skipped: boolean;
  tracked: boolean;
  /** Which way they're turning: 1 = to their left (as coached), -1 = to their right. */
  dir: 1 | -1;
  elapsedMs: number;
  done: boolean;
};

export type Offer = { slot: Slot; rank: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** No frame for this long means they're out of view (slow laptops detect only a few times a second). */
const LOST_MS = 900;
const NOSE = 0, SHOULDER_L = 11, SHOULDER_R = 12, ELBOW_L = 13, ELBOW_R = 14, WRIST_L = 15, WRIST_R = 16;
const HIP_L = 23, HIP_R = 24, KNEE_L = 25, KNEE_R = 26, ANKLE_L = 27, ANKLE_R = 28;
const inView = (p: Landmark | undefined, minVis: number) => !!p && p.visibility >= minVis && p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1;

/** How the player stands in the picture, and what to tell them. Pure, per frame. */
export function frameCheck(frame: PoseFrame, facing: Facing | null, opts: Partial<GuideOptions> = {}): Framing {
  const o = { ...GUIDE_DEFAULTS, ...SCAN_DEFAULTS, ...opts };
  const L = frame.image;
  const a = frame.aspect ?? 4 / 3;
  const v = (i: number) => inView(L[i], o.minVisibility);
  const both = (i: number, j: number) => v(i) && v(j);
  const wristsUp = [[WRIST_L, SHOULDER_L], [WRIST_R, SHOULDER_R]].some(([w, s]) => v(w) && v(s) && L[w].y < L[s].y);
  const elbowsUp = [[ELBOW_L, SHOULDER_L], [ELBOW_R, SHOULDER_R]].some(([e, s]) => v(e) && v(s) && L[e].y < L[s].y - 0.02);
  const armsDown = !wristsUp && !elbowsUp;
  // No shoulders, but a face or hips filling the picture: they're right up against the camera.
  if (!both(SHOULDER_L, SHOULDER_R)) return { level: 0, coach: v(NOSE) || both(HIP_L, HIP_R) ? 'close' : 'enter', armsDown };

  const midSx = (L[SHOULDER_L].x + L[SHOULDER_R].x) / 2;
  const midSy = (L[SHOULDER_L].y + L[SHOULDER_R].y) / 2;
  const hips = both(HIP_L, HIP_R);
  const level: Framing['level'] = !hips ? 1 : !both(KNEE_L, KNEE_R) ? 2 : !both(ANKLE_L, ANKLE_R) ? 3 : 4;
  // Top of the head is about a neck-length above the nose.
  const neck = v(NOSE) ? Math.abs(midSy - L[NOSE].y) : 0;
  const headCut = !v(NOSE) || L[NOSE].y - neck * 0.9 < 0;
  const torso = hips
    ? Math.hypot((midSx - (L[HIP_L].x + L[HIP_R].x) / 2) * a, midSy - (L[HIP_L].y + L[HIP_R].y) / 2)
    : (Math.abs(L[SHOULDER_L].x - L[SHOULDER_R].x) * a) / 0.7; // shoulder width stands in for the torso
  const facingOff = facing ? facing.yaw > o.frontYaw[1] || Math.abs(facing.nose) > o.frontNose[1] || facing.noseDepth > o.maxNoseDepth : false;

  let coach: Coach | null = null;
  if (headCut) coach = 'head';
  else if (torso > o.closeTorso) coach = 'close';
  else if (!hips) coach = 'hips';
  else if (torso < o.farTorso) coach = 'far';
  // The preview is a mirror: image-left shows on the screen's right, so they step to their left.
  else if (midSx < 0.5 - o.centerBand) coach = 'left';
  else if (midSx > 0.5 + o.centerBand) coach = 'right';
  else if (facingOff || (!facing && hips)) coach = 'face';
  else if (!armsDown) coach = 'arms';
  return { level, coach, armsDown };
}

export const COACH_TEXT: Record<Coach, string> = {
  enter: 'Step into view',
  hips: 'Step back so we see you down to your hips',
  head: 'Step back: keep your head in the picture',
  close: "Step back, you're too close",
  far: 'Come a bit closer',
  left: 'Step to your left, to the middle',
  right: 'Step to your right, to the middle',
  face: 'Face the camera',
  arms: 'Arms down, relaxed',
};

/**
 * How good a front photo this frame makes, higher is better (sharpness breaks ties): framed head to hips beats a
 * cut-off one, a fitting size and centered beats too close or far, knees and feet in view are a bonus, then how square
 * on they are, then arms down.
 */
export function frontRank(framing: Framing, tier: Tier): number {
  const sized = framing.level >= 2 && framing.coach !== 'close' && framing.coach !== 'far' && framing.coach !== 'head' && framing.coach !== 'left' && framing.coach !== 'right';
  const framed = (framing.level >= 2 ? 1 : 0) + (sized ? 1 : 0) + (framing.level >= 3 ? 1 : 0) + (framing.level >= 4 ? 0.5 : 0);
  return framed * 10 + tier * 3 + (framing.armsDown ? 1 : 0);
}

/** Is this upper-body-only frame at least roughly facing the camera? (estimateFacing needs the hips.) */
function roughlyFront(frame: PoseFrame, minVis: number): boolean {
  const L = frame.image;
  if (![NOSE, SHOULDER_L, SHOULDER_R].every((i) => inView(L[i], minVis))) return false;
  const dx = L[SHOULDER_L].x - L[SHOULDER_R].x; // positive when facing the camera
  const off = Math.abs(L[NOSE].x - (L[SHOULDER_L].x + L[SHOULDER_R].x) / 2);
  return dx > 0 && off < Math.abs(dx) * 0.3;
}

type Keep = { rank: number; sharpness: number; tier: Tier };

/**
 * One guided scan. Per camera frame call `offer(frame, t)`: it moves the timeline along and returns the photo slots
 * the frame is a candidate for. Measure its sharpness and `submit` each; true means it's the new keeper for that slot
 * (keep its image). Call `tick(t)` when no frames come (nobody tracked) so the countdown and the ring keep moving.
 * `skip(t)` after the front photo ends the scan early. Read `view` for the UI and `front` for which slot holds the
 * front photo.
 */
export class GuidedScan {
  readonly opts: GuideOptions;
  /** The pose model is still loading: no frames yet, but not because nobody's there. Set by the caller. */
  warming = false;
  private warmUntil = 0;
  private stage: ScanStage = 'find';
  private stageAt = 0;
  private now = 0;
  /** Last frame with someone at least partly in view (MediaPipe sends none without a person). */
  private lastSeenAt = -Infinity;
  private everTracked = false;
  private trackedMs = 0;
  private goodSince: number | null = null;
  private framing: Framing = { level: 0, coach: 'enter', armsDown: true };
  private frontWidth: number;
  private measuredFront = 0;
  private readonly keep: Partial<Record<Slot, Keep>> = {};
  /** Which slot became the front photo at the snap. */
  private frontFrom: 'front' | 'spare' | null = null;
  private flash = 0;
  private flashOn: Tick | null = null;
  private skipped = false;
  // The turn:
  private turnAt = 0;
  private paced = 0;
  private real = 0;
  private realAt = -Infinity;
  private firstSide: Bucket | null = null;
  private sideVotes: { side: Bucket; n: number } = { side: 'right', n: 0 };
  private secondSeen = false;
  private lastAngle: number | null = null;
  private passed = new Set<Tick>();
  private captured = new Set<Bucket>();

  constructor(opts: Partial<GuideOptions> = {}) {
    this.opts = { ...GUIDE_DEFAULTS, ...SCAN_DEFAULTS, ...opts };
    this.frontWidth = this.opts.frontWidth;
  }

  /** A tracked frame at `t`. Returns the slots it could fill (empty if none). */
  offer(frame: PoseFrame, t: number): Offer[] {
    this.tick(t);
    const dt = Number.isFinite(this.lastSeenAt) ? clamp(t - this.lastSeenAt, 0, 200) : 0;
    this.lastSeenAt = t;
    const facing = estimateFacing(frame, this.frontWidth, this.opts);
    if (facing?.frontal && Math.abs(facing.nose) < this.opts.frontNose[0] && facing.width > this.measuredFront && this.stage !== 'turn') {
      this.measuredFront = facing.width;
      this.frontWidth = clamp(this.measuredFront, 0.45, 1.1);
    }
    const framing = frameCheck(frame, facing, this.opts);
    this.framing = framing;
    if (framing.level > 0) {
      this.everTracked = true;
      this.trackedMs += dt;
    }
    const hit = facing ? classify(facing, this.opts) : null;
    if (this.stage === 'turn') this.followTurn(facing, hit);
    if (this.stage === 'find') {
      const good = framing.level >= 2 && framing.coach === null;
      this.goodSince = good ? (this.goodSince ?? t) : null;
    }

    const offers: Offer[] = [];
    if (framing.level === 0) return offers;
    const front: Tier = hit?.bucket === 'front' ? hit.tier : !facing && roughlyFront(frame, this.opts.minVisibility) ? 1 : 0;
    const rank = frontRank(framing, front);
    if (this.stage === 'find' || this.stage === 'countdown') offers.push({ slot: 'spare', rank });
    if (this.stage === 'countdown' && front > 0) offers.push({ slot: 'front', rank });
    if (this.stage === 'turn' && hit && hit.bucket !== 'front' && this.sideOk(hit.bucket)) offers.push({ slot: hit.bucket, rank: hit.tier });
    // Came all the way around: a better front than a fallback one can still replace it.
    if (this.stage === 'turn' && this.secondSeen && this.ring >= 0.8 && front === 2 && rank > this.frontKeep().rank) offers.push({ slot: this.frontFrom!, rank });
    return offers.filter((offer) => offer.rank >= (this.keep[offer.slot]?.rank ?? -1));
  }

  /** Record a candidate's sharpness. True if it's the new best for its slot (keep its image). */
  submit(offer: Offer, sharpness: number): boolean {
    const k = this.keep[offer.slot];
    if (k && (offer.rank < k.rank || (offer.rank === k.rank && sharpness <= k.sharpness))) return false;
    this.keep[offer.slot] = { rank: offer.rank, sharpness, tier: offer.slot === 'left' || offer.slot === 'right' ? (offer.rank as Tier) : 0 };
    if ((offer.slot === 'left' || offer.slot === 'right') && !this.captured.has(offer.slot)) {
      this.captured.add(offer.slot);
      this.snapFlash(offer.slot);
    }
    return true;
  }

  /** Advance the clock (every frame, and on a timer when no frames come). */
  tick(t: number) {
    const dt = clamp(t - this.now, 0, 250);
    this.now = Math.max(this.now, t);
    const o = this.opts;
    const since = this.now - this.stageAt;
    switch (this.stage) {
      case 'find': {
        if (this.isWarming) this.warmUntil = this.now;
        // Nobody in view for a long while (never, or they walked off): give up with what we have (nothing).
        const quiet = this.now - Math.max(this.lastSeenAt, this.stageAt, this.warmUntil);
        if (quiet >= o.nobodyMs || this.now - this.warmUntil >= o.findMaxMs) return this.go('done');
        const settled = this.goodSince !== null && this.lastSeenAt - this.goodSince >= o.settleMs && this.now - this.lastSeenAt < LOST_MS;
        if (settled || this.trackedMs >= o.patienceMs) this.go('countdown');
        break;
      }
      case 'countdown': {
        const end = 3 * o.beatMs;
        if (since < end) break;
        // The front photo: the countdown's best front-facing frame, or after a short wait for one, the best we saw.
        if (this.keep.front) this.frontFrom = 'front';
        else if (since >= end + o.graceMs && this.keep.spare) this.frontFrom = 'spare';
        else if (since >= end + o.graceMs) {
          // They left before the shutter: start over, or give up if they're gone for good.
          this.goodSince = null;
          this.trackedMs = 0;
          return this.go('find');
        }
        if (this.frontFrom) {
          this.snapFlash('front');
          this.go('snap');
        }
        break;
      }
      case 'snap':
        if (since >= o.snapMs) {
          this.turnAt = this.now;
          this.go('turn');
        }
        break;
      case 'turn': {
        // The minimum pace, slowed while they're in view and behind it (more so while visibly turning); never behind
        // what we've seen them do. Out of view, it just keeps going.
        const behind = this.paced > this.real + 0.12 && this.now - this.lastSeenAt < LOST_MS;
        const pace = !behind ? 1 : this.now - this.realAt < 1200 ? o.waitPace : o.idlePace;
        this.paced = Math.min(1, this.paced + (dt / o.turnMs) * pace);
        this.paced = Math.max(this.paced, this.real);
        if (this.now - this.turnAt >= o.turnMaxMs) this.paced = 1;
        if (this.paced >= 0.5) this.passed.add('back');
        if (this.paced >= 1) this.go('outro');
        break;
      }
      case 'outro':
        if (since >= o.outroMs) this.go('done');
        break;
      case 'done':
        break;
    }
  }

  /** "Done: forge with the front photo". Ignored until the front photo is in. */
  skip(t: number) {
    this.tick(t);
    if (!this.canSkip || this.stage === 'outro' || this.stage === 'done') return;
    this.skipped = true;
    this.go('outro');
  }

  /** The slot holding the front photo (null if the scan never got one). */
  get front(): 'front' | 'spare' | null {
    return this.frontFrom;
  }

  get done() {
    return this.stage === 'done';
  }

  private get isWarming() {
    return this.warming && this.now < this.opts.maxWarmupMs && !Number.isFinite(this.lastSeenAt);
  }

  get canSkip() {
    return this.frontFrom !== null && this.stage !== 'find' && this.stage !== 'countdown';
  }

  get view(): ScanView {
    const o = this.opts;
    const since = this.now - this.stageAt;
    const tracked = this.now - this.lastSeenAt < LOST_MS;
    const order: Tick[] = this.firstSide === 'left' ? ['front', 'left', 'back', 'right'] : ['front', 'right', 'back', 'left'];
    const ring = this.stage === 'outro' || this.stage === 'done' ? (this.skipped ? this.ring : 1) : this.ring;
    const frontTier: Tier = !this.frontFrom ? 0 : this.frontKeep().rank >= frontRank({ level: 2, coach: null, armsDown: false }, 2) ? 2 : 1;
    const shots: Record<Bucket, Tier> = { front: frontTier, left: this.keep.left?.tier ?? 0, right: this.keep.right?.tier ?? 0 };
    const hit = (tick: Tick) => (tick === 'back' ? this.passed.has('back') : tick === 'front' ? this.frontFrom !== null : shots[tick] > 0);
    const coachKind: Coach | null = tracked ? this.framing.coach : 'enter';
    let hint = '';
    let coach = '';
    switch (this.stage) {
      case 'find':
        if (this.isWarming) {
          hint = 'Warming up the scanner…';
          coach = 'Stand 1.5 to 2 m back, facing the camera';
          break;
        }
        hint = !tracked || coachKind === 'enter' ? 'Step into view' : coachKind && coachKind !== 'face' && coachKind !== 'arms' ? 'Get in position' : 'Face the camera, arms relaxed';
        coach = !tracked ? (this.everTracked ? 'Lost you: stand in front of the camera' : 'Stand 1.5 to 2 m from the camera') : coachKind ? COACH_TEXT[coachKind] : 'Hold still…';
        break;
      case 'countdown':
        hint = since < 3 * o.beatMs ? 'Face the camera, arms relaxed' : 'Face the camera…';
        coach = coachKind && coachKind !== 'arms' ? COACH_TEXT[coachKind] : 'Hold still';
        break;
      case 'snap':
        hint = frontTier === 2 ? 'Front: got it!' : 'Front: got it';
        coach = 'Now a slow spin…';
        break;
      case 'turn': {
        // Coach from what they're actually doing while we can see it, else from the ring.
        const way = `to your ${this.firstSide === 'left' ? 'right' : 'left'}`;
        const following = tracked && this.now - this.realAt < 1500;
        const cue = following ? this.real : ring;
        const stalled = tracked && this.now - this.realAt > 2000 && ring - this.real > 0.2;
        hint =
          ring >= 0.82 ? 'Face the camera again'
          : cue < 0.12 || (tracked && this.real === 0) ? `Turn slowly ${way}…`
          : stalled ? 'Keep turning, slowly…'
          : cue >= 0.42 && cue < 0.6 ? 'Halfway…'
          : cue >= 0.6 ? 'Almost around…'
          : 'Keep going…';
        coach = !tracked ? 'Lost you for a sec: keep turning' : (['left', 'right'] as const).filter((b) => shots[b]).map((b) => `${b} side ✓`).join('  ') || 'Side photos snap on their own';
        break;
      }
      case 'outro':
      case 'done':
        hint = !this.frontFrom ? 'Nobody in view' : this.skipped ? 'Front photo locked in' : 'Scan complete!';
        coach = !this.frontFrom ? 'Step in front of the camera and try again' : `${1 + (shots.left ? 1 : 0) + (shots.right ? 1 : 0)} of 3 photos`;
        break;
    }
    return {
      stage: this.stage,
      count: this.stage === 'countdown' && since < 3 * o.beatMs ? 3 - Math.floor(since / o.beatMs) : null,
      hint,
      coach,
      coachKind: (this.stage === 'find' && !this.isWarming) || this.stage === 'countdown' ? coachKind : null,
      ring: Math.round(ring * 200) / 200,
      ticks: order.map((tick, i) => ({ tick, at: i / 4, hit: hit(tick) })),
      shots,
      flash: this.flash,
      flashOn: this.flashOn,
      canSkip: this.canSkip && this.stage !== 'outro' && this.stage !== 'done',
      skipped: this.skipped,
      tracked,
      dir: this.firstSide === 'left' ? -1 : 1,
      elapsedMs: this.now,
      done: this.stage === 'done',
    };
  }

  private get ring() {
    return this.stage === 'turn' || this.stage === 'outro' || this.stage === 'done' ? this.paced : 0;
  }

  private frontKeep(): Keep {
    return (this.frontFrom && this.keep[this.frontFrom]) || { rank: -1, sharpness: 0, tier: 0 };
  }

  private go(stage: ScanStage) {
    this.stage = stage;
    this.stageAt = this.now;
  }

  private snapFlash(on: Tick) {
    this.flash++;
    this.flashOn = on;
  }

  /** A side photo only once the turn has plausibly reached that side (not a lean in the first instant). */
  private sideOk(side: Bucket) {
    return this.firstSide === side || this.secondSeen;
  }

  /**
   * Real turn progress from the facing estimate. The first side toward the camera sets the direction (90°), a
   * front-looking view after it is the back (MediaPipe often reads a back as a front), the other side is 270°, and
   * front again after that is all the way around. Progress only moves forward, by plausible steps, confirmed by two
   * frames in a row.
   */
  private followTurn(facing: Facing | null, hit: ReturnType<typeof classify>) {
    if (!facing) return void (this.lastAngle = null);
    let angle: number | null = null;
    const sideOn = facing.side !== 0 && facing.turn >= this.opts.threeQuarterYaw && facing.turn <= 150 && facing.noseDepth <= this.opts.maxNoseDepth;
    if (sideOn) {
      const side: Bucket = facing.side > 0 ? 'left' : 'right';
      if (!this.firstSide) {
        this.sideVotes = side === this.sideVotes.side ? { side, n: this.sideVotes.n + 1 } : { side, n: 1 };
        if (this.sideVotes.n >= 2) this.firstSide = side;
      }
      if (this.firstSide === side && !this.secondSeen) angle = facing.turn;
      else if (this.firstSide && this.firstSide !== side && this.real >= 0.3) {
        angle = 360 - facing.turn;
        if (hit && hit.bucket === side) this.secondSeen = true;
      }
    } else if (facing.yaw < 30 && this.firstSide) {
      angle = this.secondSeen ? 360 : 180; // front-looking: the back until they've shown the other side
    }
    const prev = this.lastAngle;
    this.lastAngle = angle;
    if (angle === null || prev === null || Math.abs(angle - prev) > 45) return;
    const step = Math.min(angle, prev) / 360;
    if (step > this.real && step - this.real <= 0.4) {
      this.real = step;
      this.realAt = this.now;
    }
  }
}
