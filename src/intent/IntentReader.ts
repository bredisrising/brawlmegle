import type { AttackMove, Command, Hand, PlayerId, PoseFrame, Stance } from '../types';

const VISIBILITY = 0.35;
const STALE_AFTER_MS = 300;
const ATTACK_COOLDOWN_MS = 350;

type Point = { x: number; y: number; z: number };
type HandState = { extension: number; elbowAngle: number; wrist: Point; t: number };

/** Turns camera landmarks into the lightweight attack and defense commands used by FightEngine. */
export class IntentReader {
  readonly player: PlayerId;
  private lastFrameTime = -1;
  private readonly hands: Record<Hand, HandState | null> = { L: null, R: null };
  private readonly lastAttack: Record<Hand, number> = { L: -Infinity, R: -Infinity };
  private guardSince: number | null = null;
  private blocking = false;
  private headHistory: { point: Point; t: number }[] = [];
  private torsoWidth: number | null = null;
  private stance: Stance;

  constructor(player: PlayerId) {
    this.player = player;
    this.stance = { player, guard: true, advance: 0, lean: { x: 0, y: 0 }, tracked: false };
  }

  update(frame: PoseFrame): { commands: Command[]; stance: Stance } {
    const age = performance.now() - frame.t;
    if (age > STALE_AFTER_MS || !hasVisibleBody(frame)) {
      this.stance = { player: this.player, guard: true, advance: 0, lean: { x: 0, y: 0 }, tracked: false };
      this.blocking = false;
      this.guardSince = null;
      return { commands: [], stance: this.stance };
    }

    // Game ticks at 60 Hz while cameras usually produce ~30 frames per second.
    // Reuse the last stance between camera frames, but never emit duplicate attacks.
    if (frame.t <= this.lastFrameTime) return { commands: [], stance: this.stance };
    this.lastFrameTime = frame.t;

    const points = frame.image.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const visible = (i: number) => frame.image[i]?.visibility >= VISIBILITY;
    const nose = points[0];
    const leftShoulder = points[11];
    const rightShoulder = points[12];
    const leftHip = points[23];
    const rightHip = points[24];
    const shoulderWidth = distance2(leftShoulder, rightShoulder);
    const armLength = mean([
      distance2(points[11], points[13]) + distance2(points[13], points[15]),
      distance2(points[12], points[14]) + distance2(points[14], points[16]),
    ]) / 2;
    const scale = Math.max(armLength, 0.001);
    const commands: Command[] = [];

    const nowHead = { ...nose };
    this.headHistory.push({ point: nowHead, t: frame.t });
    this.headHistory = this.headHistory.filter((sample) => frame.t - sample.t <= 300);
    const oldHead = this.headHistory[0];
    const headDx = oldHead ? (nose.x - oldHead.point.x) / scale : 0;
    const headDrop = oldHead ? (nose.y - oldHead.point.y) / scale : 0;
    if (oldHead && frame.t - oldHead.t <= 250 && Math.abs(headDx) > 0.35) {
      commands.push({ kind: 'defend', player: this.player, t: frame.t, move: 'slip', dir: headDx < 0 ? 'L' : 'R' });
      this.headHistory = [{ point: nowHead, t: frame.t }];
    } else if (oldHead && frame.t - oldHead.t <= 250 && headDrop > 0.35) {
      commands.push({ kind: 'defend', player: this.player, t: frame.t, move: 'duck' });
      this.headHistory = [{ point: nowHead, t: frame.t }];
    }

    const bothNearFace = visible(15) && visible(16)
      && distance2(points[15], nose) < scale * 0.55
      && distance2(points[16], nose) < scale * 0.55;
    if (bothNearFace) {
      this.guardSince ??= frame.t;
      if (!this.blocking && frame.t - this.guardSince >= 120) {
        commands.push({ kind: 'defend', player: this.player, t: frame.t, move: 'block' });
        this.blocking = true;
      }
    } else {
      this.guardSince = null;
      this.blocking = false;
    }

    for (const hand of ['L', 'R'] as const) {
      const shoulderIndex = hand === 'L' ? 11 : 12;
      const elbowIndex = hand === 'L' ? 13 : 14;
      const wristIndex = hand === 'L' ? 15 : 16;
      if (![shoulderIndex, elbowIndex, wristIndex].every(visible)) continue;
      const shoulder = points[shoulderIndex];
      const elbow = points[elbowIndex];
      const wrist = points[wristIndex];
      const extension = distance2(shoulder, wrist) / scale;
      const angle = elbowAngle(shoulder, elbow, wrist);
      const previous = this.hands[hand];

      const rise = previous ? (previous.wrist.y - wrist.y) / scale : 0;
      const sweep = previous ? Math.abs(wrist.x - previous.wrist.x) / scale : 0;
      const hook = angle >= 70 && angle <= 125 && sweep > 0.35;
      const uppercut = rise > 0.3 && wrist.y < midpoint(leftShoulder, rightShoulder).y;
      if (previous && frame.t - previous.t <= 250 && previous.extension < 0.62 && extension > 0.82
        && (angle > 145 || hook || uppercut) && frame.t - this.lastAttack[hand] >= ATTACK_COOLDOWN_MS) {
        let move: AttackMove = hand === 'L' ? 'jab' : 'cross';
        if (hook) move = 'hook';
        else if (uppercut) move = 'uppercut';

        const dt = Math.max(0.001, (frame.t - previous.t) / 1000);
        const wristSpeed = distance2(previous.wrist, wrist) / scale / dt;
        commands.push({
          kind: 'attack', player: this.player, t: frame.t, move, hand,
          height: wrist.y < nose.y + scale * 0.1 ? 'head' : 'body',
          speed: clamp(0.8 + wristSpeed / 12, 0.8, 1.3),
          windup: clamp(0.8 + Math.max(0, 0.62 - previous.extension), 0.8, 1.3),
        });
        this.lastAttack[hand] = frame.t;
      }
      this.hands[hand] = { extension, elbowAngle: angle, wrist: { ...wrist }, t: frame.t };
    }

    const hipCenter = midpoint(leftHip, rightHip);
    const shoulderCenter = midpoint(leftShoulder, rightShoulder);
    this.torsoWidth ??= shoulderWidth;
    const relativeWidth = shoulderWidth / Math.max(this.torsoWidth, 0.001);
    const advance = relativeWidth > 1.12 ? clamp((relativeWidth - 1.12) * 5, 0, 1)
      : relativeWidth < 0.9 ? clamp((relativeWidth - 0.9) * 5, -1, 0) : 0;
    this.stance = {
      player: this.player,
      guard: bothNearFace || this.blocking,
      advance,
      lean: { x: clamp((nose.x - hipCenter.x) / scale, -1, 1), y: clamp((nose.y - shoulderCenter.y) / scale, -1, 1) },
      tracked: true,
    };
    return { commands, stance: this.stance };
  }
}

function hasVisibleBody(frame: PoseFrame) {
  return [0, 11, 12, 13, 14, 15, 16, 23, 24].every((i) => (frame.image[i]?.visibility ?? 0) >= VISIBILITY);
}

function distance2(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function elbowAngle(shoulder: Point, elbow: Point, wrist: Point) {
  const ax = shoulder.x - elbow.x;
  const ay = shoulder.y - elbow.y;
  const bx = wrist.x - elbow.x;
  const by = wrist.y - elbow.y;
  const denom = Math.max(0.000001, Math.hypot(ax, ay) * Math.hypot(bx, by));
  return Math.acos(clamp((ax * bx + ay * by) / denom, -1, 1)) * 180 / Math.PI;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
