import type { Intent, LimbName, StrikeStyle } from '../intent/intents';
import type { PoseFrame } from '../types';

/**
 * Training's punch drill: the game calls moves ("LEFT HOOK!"), the player throws them, and gets a score. It is also how
 * the move reader learns about more people: with the player's OK, the drill's poses (points only, never video) and
 * what was asked go to the server's /samples, labeled, like the tuner's guided test. Overhands and uppercuts read worst
 * because only about fifteen people's punches have ever been labeled.
 */
export type DrillExpect = { kind: 'strike'; limb: LimbName; style: StrikeStyle } | { kind: 'guard' | 'duck' } | { kind: 'none' };
export type DrillStep = { say: string; hint: string; expect: DrillExpect };
export type DrillLabel = DrillStep & { start: number; end: number };
export type DrillVerdict = 'hit' | 'wrong type' | 'missed' | 'clean' | 'false move';
export type DrillResult = { caught: number; typed: number; scored: number; quiet: number; quietOk: number; rows: { say: string; verdict: DrillVerdict }[] };

export const DRILL_STEPS: DrillStep[] = [
  { say: 'Left jab', hint: 'snap your left fist at the screen', expect: { kind: 'strike', limb: 'armL', style: 'straight' } },
  { say: 'Right cross', hint: 'snap your right fist at the screen', expect: { kind: 'strike', limb: 'armR', style: 'straight' } },
  { say: 'Block', hint: 'both fists up, hold them there', expect: { kind: 'guard' } },
  { say: 'Left hook', hint: 'swing your left fist round from the side', expect: { kind: 'strike', limb: 'armL', style: 'hook' } },
  { say: 'Right hook', hint: 'swing your right fist round from the side', expect: { kind: 'strike', limb: 'armR', style: 'hook' } },
  { say: 'Stay still', hint: 'just hold your guard', expect: { kind: 'none' } },
  { say: 'Right uppercut', hint: 'dip, then drive your right fist up', expect: { kind: 'strike', limb: 'armR', style: 'upper' } },
  { say: 'Left uppercut', hint: 'dip, then drive your left fist up', expect: { kind: 'strike', limb: 'armL', style: 'upper' } },
  { say: 'Duck', hint: 'hands still, drop your head and shoulders', expect: { kind: 'duck' } },
  { say: 'Right overhand', hint: 'swing your right fist up and over the top', expect: { kind: 'strike', limb: 'armR', style: 'hook' } },
  { say: 'Wave hello', hint: 'a normal wave', expect: { kind: 'none' } },
  { say: 'Left jab', hint: 'again, quick', expect: { kind: 'strike', limb: 'armL', style: 'straight' } },
  { say: 'Right cross', hint: 'as hard as you can', expect: { kind: 'strike', limb: 'armR', style: 'straight' } },
  { say: 'Left overhand', hint: 'swing your left fist up and over the top', expect: { kind: 'strike', limb: 'armL', style: 'hook' } },
  { say: 'Right uppercut', hint: 'again', expect: { kind: 'strike', limb: 'armR', style: 'upper' } },
  { say: 'Left hook', hint: 'again', expect: { kind: 'strike', limb: 'armL', style: 'hook' } },
];
/** Each move's window (ms): shown for SHOW_MS, then a breather. A few seconds of "get ready" first. */
export const DRILL_STEP_MS = 3000;
const SHOW_MS = 2300;
const READY_MS = 3000;

export class Drill {
  readonly frames: PoseFrame[] = [];
  readonly intents: Intent[] = [];
  readonly labels: DrillLabel[] = [];
  private readonly startedAt: number;

  constructor(now: number, readonly steps: DrillStep[] = DRILL_STEPS) {
    this.startedAt = now;
  }

  /** Every new pose and what the reader made of it, as the round goes (pose time: the camera's clock). */
  feed(frames: PoseFrame[], intents: Intent[]) {
    this.frames.push(...frames);
    this.intents.push(...intents);
  }

  /** What to show now (`now` on the same clock as the constructor's), and whether the drill is over. */
  at(now: number, poseT: number | null): { step: DrillStep | null; index: number; ready: number | null; done: boolean } {
    const t = now - this.startedAt;
    if (t < READY_MS) return { step: null, index: -1, ready: Math.ceil((READY_MS - t) / 1000), done: false };
    const index = Math.floor((t - READY_MS) / DRILL_STEP_MS);
    if (index >= this.steps.length) return { step: null, index, ready: null, done: true };
    // Label each move's window on the pose clock, from its first frame (the reader's intents carry pose times).
    if (this.labels.length === index && poseT !== null) this.labels.push({ ...this.steps[index], start: poseT, end: poseT + DRILL_STEP_MS });
    const showing = (t - READY_MS) % DRILL_STEP_MS < SHOW_MS;
    return { step: showing ? this.steps[index] : null, index, ready: null, done: false };
  }

  result(): DrillResult {
    return scoreDrill(this.labels, this.intents);
  }

  /** The labeled session for /samples: a header with the moves asked, then the poses (points only). */
  sample(extra: Record<string, unknown> = {}): string {
    const header = { clip: 'drill', frames: this.frames.length, labels: this.labels, ...extra };
    return [header, ...this.frames].map((x) => JSON.stringify(x)).join('\n') + '\n';
  }
}

export function scoreDrill(labels: DrillLabel[], intents: Intent[]): DrillResult {
  const r: DrillResult = { caught: 0, typed: 0, scored: 0, quiet: 0, quietOk: 0, rows: [] };
  const restyled = (s: Extract<Intent, { kind: 'strike' }>) =>
    intents.filter((i): i is Extract<Intent, { kind: 'restyle' }> => i.kind === 'restyle' && i.limb === s.limb && i.onsetT === s.onsetT).pop()?.style ?? s.style;
  for (const l of labels) {
    const during = intents.filter((i) => i.t >= l.start && i.t <= l.end);
    const e = l.expect;
    if (e.kind === 'none') {
      r.quiet++;
      const moved = during.some((i) => i.kind === 'strike' || i.kind === 'dodge' || i.kind === 'duck');
      if (!moved) r.quietOk++;
      r.rows.push({ say: l.say, verdict: moved ? 'false move' : 'clean' });
      continue;
    }
    r.scored++;
    let verdict: DrillVerdict = 'missed';
    if (e.kind === 'strike') {
      const hit = during.find((i): i is Extract<Intent, { kind: 'strike' }> => i.kind === 'strike' && i.limb === e.limb);
      if (hit) verdict = restyled(hit) === e.style ? 'hit' : 'wrong type';
    } else if (e.kind === 'guard') {
      // Up during the move counts, even if it went up just before (a chest guard often already is).
      const flips = intents.filter((i): i is Extract<Intent, { kind: 'guard' }> => i.kind === 'guard');
      const upAt = (t: number) => flips.filter((g) => g.t <= t).pop()?.up ?? false;
      if (upAt(l.start + DRILL_STEP_MS / 2) || during.some((i) => i.kind === 'guard' && i.up)) verdict = 'hit';
    } else if (during.some((i) => i.kind === e.kind)) verdict = 'hit';
    if (verdict !== 'missed') r.caught++;
    if (verdict === 'hit') r.typed++;
    r.rows.push({ say: l.say, verdict });
  }
  return r;
}
