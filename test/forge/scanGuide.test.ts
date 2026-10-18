import { describe, expect, it } from 'vitest';
import { GUIDE_DEFAULTS, GuidedScan, frameCheck, type ScanStage, type ScanView, type Slot } from '../../src/forge/scanGuide';
import { estimateFacing } from '../../src/forge/scanBuckets';
import type { PoseFrame } from '../../src/types';
import { poseAt, swapSides } from './pose';

const FPS = 30;
const DT = 1000 / FPS;

/** Sitting at a desk: everything from the hips down hidden. */
const sitting = (frame: PoseFrame) => hide(frame, [23, 24, 25, 26, 27, 28]);
function hide(frame: PoseFrame, idx: number[]): PoseFrame {
  const image = frame.image.map((p, i) => (idx.includes(i) ? { ...p, visibility: 0.05 } : p));
  return { ...frame, image };
}

type Script = (t: number) => PoseFrame | null;

/**
 * Plays a script through a GuidedScan at 30 fps. Sharpness defaults to a little wobble. Returns what each slot kept
 * (the script time of its keeper), when each stage started, and the views seen.
 */
function run(script: Script, opts: { sharp?: (t: number) => number; limit?: number; skipAt?: number } = {}) {
  const scan = new GuidedScan();
  const kept: Partial<Record<Slot, number>> = {};
  const stages: Partial<Record<ScanStage, number>> = { find: 0 };
  const views: ScanView[] = [];
  let doneAt = -1;
  for (let t = 0; t < (opts.limit ?? 60_000); t += DT) {
    if (opts.skipAt !== undefined && t >= opts.skipAt) scan.skip(t);
    const frame = script(t);
    if (frame) {
      for (const offer of scan.offer({ ...frame, t }, t)) if (scan.submit(offer, opts.sharp?.(t) ?? 100 + (Math.round(t / DT) % 7))) kept[offer.slot] = t;
    } else scan.tick(t);
    const view = scan.view;
    stages[view.stage] ??= t;
    views.push(view);
    if (scan.done) {
      doneAt = t;
      break;
    }
  }
  return { scan, kept, stages, views, doneAt, view: scan.view };
}

/** Facing the camera until `turnAt`, then a turn to their left (yaw going negative) over `seconds`, then facing again. */
const turner = (turnAt: number, seconds: number, opts: { dir?: 1 | -1; tweak?: (f: PoseFrame, yaw: number) => PoseFrame | null } = {}): Script => (t) => {
  const p = clamp01((t - turnAt) / (seconds * 1000));
  const yaw = -(opts.dir ?? 1) * 360 * p;
  const frame = poseAt(yaw, { t, noise: 0.002, seed: Math.round(t) + 1 });
  return opts.tweak ? opts.tweak(frame, yaw) : frame;
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** When the turn starts for a player who's framed from the start (settle, countdown, snap). */
const TURN_AT = GUIDE_DEFAULTS.settleMs + 3 * GUIDE_DEFAULTS.beatMs + GUIDE_DEFAULTS.snapMs;

describe('frameCheck', () => {
  const check = (f: PoseFrame) => frameCheck(f, estimateFacing(f));
  it('is happy with a framed player facing the camera', () => {
    expect(check(poseAt(0))).toMatchObject({ level: 4, coach: null, armsDown: true });
  });
  it('says step back when too close, come closer when far', () => {
    expect(check(poseAt(0, { scale: 1.2 })).coach).toMatch(/close|head|hips/);
    expect(check(poseAt(0, { scale: 0.2 })).coach).toBe('far');
  });
  it('asks for the hips when only the upper body shows', () => {
    expect(check(sitting(poseAt(0)))).toMatchObject({ level: 1, coach: 'hips' });
  });
  it('steers them to the middle, in mirror terms', () => {
    const shift = (f: PoseFrame, dx: number) => ({ ...f, image: f.image.map((p) => ({ ...p, x: p.x + dx })) });
    expect(check(shift(poseAt(0), -0.3)).coach).toBe('left'); // image-left = screen-right in the mirror: step to your left
    expect(check(shift(poseAt(0), 0.3)).coach).toBe('right');
  });
  it('asks them to face the camera when turned', () => {
    expect(check(poseAt(40)).coach).toBe('face');
  });
  it('asks for arms down when they are up', () => {
    const f = poseAt(0);
    f.image[15] = { ...f.image[15], y: 0.1 };
    expect(check(f)).toMatchObject({ coach: 'arms', armsDown: false });
  });
  it('says step into view with nobody there', () => {
    expect(check(hide(poseAt(0), [0, 11, 12, 23, 24])).coach).toBe('enter');
  });
});

describe('GuidedScan', () => {
  it('a player who never turns: front photo, then the ring fills by time and it finishes', () => {
    const { kept, stages, doneAt, view, views, scan } = run(() => poseAt(0, { noise: 0.002 }));
    expect(stages.countdown).toBeLessThanOrEqual(GUIDE_DEFAULTS.settleMs + 100);
    expect(views.some((v) => v.count === 3) && views.some((v) => v.count === 2) && views.some((v) => v.count === 1)).toBe(true);
    expect(scan.front).toBe('front');
    expect(kept.front).toBeGreaterThanOrEqual(stages.countdown!);
    expect(kept.front).toBeLessThan(stages.snap!);
    expect(view.shots).toEqual({ front: 2, left: 0, right: 0 });
    // The ring waits a little for a turn that never comes, then finishes by the cap.
    expect(stages.outro! - stages.turn!).toBeGreaterThan(GUIDE_DEFAULTS.turnMs);
    expect(stages.outro! - stages.turn!).toBeLessThanOrEqual(GUIDE_DEFAULTS.turnMaxMs + DT);
    expect(views.filter((v) => v.stage === 'turn' && v.ring < 0.82).every((v) => /turn slowly to your left/i.test(v.hint))).toBe(true);
    expect(doneAt).toBeLessThan(15_000);
    // The ring only ever moves forward.
    const rings = views.map((v) => v.ring);
    for (let i = 1; i < rings.length; i++) expect(rings[i]).toBeGreaterThanOrEqual(rings[i - 1]);
  });

  it('a moderate 360: both sides snap, the ticks light in order, the coaching follows the turn', () => {
    const { kept, stages, views, view } = run(turner(TURN_AT, 7));
    expect(view.shots.left).toBe(2);
    expect(view.shots.right).toBe(2);
    expect(kept.right! - TURN_AT).toBeLessThan(kept.left! - TURN_AT); // turning left shows the right side first
    expect(view.ticks.map((t) => t.tick)).toEqual(['front', 'right', 'back', 'left']);
    expect(view.ticks.every((t) => t.hit)).toBe(true);
    expect(stages.outro! - stages.turn!).toBeLessThan(GUIDE_DEFAULTS.turnMs + 1000);
    const hints = [...new Set(views.filter((v) => v.stage === 'turn').map((v) => v.hint))];
    expect(hints[0]).toMatch(/turn slowly to your left/i);
    expect(hints).toContain('Halfway…');
    expect(hints.at(-1)).toMatch(/face the camera again/i);
    expect(view.flash).toBe(3); // front, right, left
  });

  it('the ring follows a real turn: ahead of the pace when they turn quickly', () => {
    const { views, stages } = run(turner(TURN_AT, 3.5));
    const at = (t: number) => views[Math.round(t / DT)];
    expect(at(TURN_AT + 2000).ring).toBeGreaterThan(0.45); // the pace alone would be at 2/7
    expect(stages.outro! - stages.turn!).toBeLessThan(4500);
  });

  it('a fast spin still finishes, with whatever sides it caught', () => {
    const { view, doneAt } = run(turner(TURN_AT, 1.5));
    expect(view.done).toBe(true);
    expect(doneAt).toBeLessThan(TURN_AT + 4000);
    expect(view.shots.front).toBe(2);
  });

  it('a slow turner gets a little longer, never past the cap, and both sides', () => {
    const { stages, view } = run(turner(TURN_AT, 11));
    const turnMs = stages.outro! - stages.turn!;
    expect(turnMs).toBeGreaterThan(GUIDE_DEFAULTS.turnMs);
    expect(turnMs).toBeLessThanOrEqual(GUIDE_DEFAULTS.turnMaxMs + DT);
    expect(view.shots.right).toBe(2);
    expect(view.shots.left).toBeGreaterThan(0);
  });

  it('turning the other way works too: the ring marks follow them', () => {
    const { view } = run(turner(TURN_AT, 7, { dir: -1 }));
    expect(view.ticks.map((t) => t.tick)).toEqual(['front', 'left', 'back', 'right']);
    expect(view.dir).toBe(-1);
    expect(view.shots.left).toBe(2);
    expect(view.shots.right).toBe(2);
  });

  it('tracking lost mid-turn: the ring keeps going and it finishes with what it has', () => {
    const script = turner(TURN_AT, 7, { tweak: (f, yaw) => (yaw < -100 ? null : f) }); // gone once they pass the right side
    const { view, stages, views } = run(script);
    expect(view.done).toBe(true);
    expect(stages.outro! - stages.turn!).toBeLessThan(GUIDE_DEFAULTS.turnMaxMs + 100);
    expect(view.shots.right).toBe(2);
    expect(view.shots.left).toBe(0);
    expect(views.some((v) => v.stage === 'turn' && /lost you/i.test(v.coach))).toBe(true);
  });

  it('never keeps a back view as a photo, even a mislabeled, very sharp one', () => {
    const back = (yaw: number) => Math.abs((((yaw % 360) + 360) % 360) - 180) < 50;
    const script = turner(TURN_AT, 7, {
      tweak: (f, yaw) => {
        if (!back(yaw)) return f;
        const g = swapSides(f); // MediaPipe reads the back as the front
        g.world[0] = { ...g.world[0], z: -0.1 };
        return g;
      },
    });
    const yawAt = (t: number) => -360 * clamp01((t - TURN_AT) / 7000);
    const { kept } = run(script, { sharp: (t) => (back(yawAt(t)) ? 10_000 : 50) });
    expect(kept.front).toBeLessThan(TURN_AT);
    for (const s of ['left', 'right'] as const) expect(back(yawAt(kept[s]!))).toBe(false);
  });

  it('a true profile beats a sharper 3/4 view; within a tier the sharpest frame wins', () => {
    // Turn to a 3/4 view (very sharp), on to a profile (blurry), and hold it; the sharpest profile frame is at 3 s in.
    const yawAt = (t: number) => (t < TURN_AT ? 0 : -Math.min(90, ((t - TURN_AT) / 2000) * 90));
    const sharpAt = TURN_AT + 3000;
    const { kept, view } = run((t) => poseAt(yawAt(t), { noise: 0.002, seed: Math.round(t) + 1 }), {
      sharp: (t) => (Math.abs(t - sharpAt) < DT / 2 ? 500 : -yawAt(t) < 60 ? 1000 : 10),
    });
    expect(view.shots.right).toBe(2);
    expect(Math.abs(kept.right! - sharpAt)).toBeLessThan(DT);
  });

  it('sitting (upper body only): coaches the hips, then goes anyway with a front photo', () => {
    const { view, stages, views, scan } = run(() => sitting(poseAt(0, { noise: 0.002 })));
    expect(views[10].coachKind).toBe('hips');
    expect(stages.countdown).toBeGreaterThanOrEqual(GUIDE_DEFAULTS.patienceMs - 100);
    expect(stages.countdown).toBeLessThan(GUIDE_DEFAULTS.patienceMs + 300);
    expect(scan.front).toBe('front');
    expect(view.shots.front).toBe(1); // a fallback-quality front
    expect(view.done).toBe(true);
  });

  it('prefers the well-framed frame over a sharper cut-off one in the countdown', () => {
    const countdownAt = GUIDE_DEFAULTS.settleMs;
    // Half the countdown they lean in too close (and those frames are sharper).
    const close = (t: number) => t > countdownAt + 300 && t < countdownAt + 1200;
    const { kept } = run((t) => poseAt(0, { scale: close(t) ? 1.2 : 0.45 }), { sharp: (t) => (close(t) ? 1000 : 10) });
    expect(close(kept.front!)).toBe(false);
  });

  it('too close at first: coaches them back, counts down once they are', () => {
    const { views, stages } = run((t) => poseAt(0, { scale: t < 3000 ? 1.2 : 0.45 }));
    expect(views[5].hint).toMatch(/position/i);
    expect(views[5].coach).toMatch(/step back/i);
    expect(stages.countdown).toBeGreaterThan(3000);
    expect(stages.countdown).toBeLessThan(3000 + GUIDE_DEFAULTS.settleMs + 200);
  });

  it('turned away during the countdown: waits a moment, then takes the best front-ish frame', () => {
    const countdownAt = GUIDE_DEFAULTS.settleMs;
    const { scan, stages } = run((t) => poseAt(t > countdownAt ? 60 : 0)); // spun to a 3/4 view as the count started
    expect(scan.front).toBe('spare');
    expect(stages.snap! - countdownAt).toBeGreaterThanOrEqual(3 * GUIDE_DEFAULTS.beatMs + GUIDE_DEFAULTS.graceMs - DT);
  });

  it('nobody in view: gives up with no photos', () => {
    const { view, doneAt, scan } = run(() => null);
    expect(view.done).toBe(true);
    expect(scan.front).toBeNull();
    expect(doneAt).toBeGreaterThanOrEqual(GUIDE_DEFAULTS.nobodyMs - DT);
    expect(doneAt).toBeLessThan(GUIDE_DEFAULTS.nobodyMs + 500);
    expect(view.hint).toMatch(/nobody/i);
  });

  it('someone who walks off mid-countdown: the frames before they left make the photo, and it finishes', () => {
    const { scan, view } = run((t) => (t < 1000 ? poseAt(0) : null));
    expect(scan.front).toBe('front');
    expect(view.done).toBe(true);
  });

  it('someone who walks off before the countdown: gives up once they stay gone', () => {
    const { scan, view, doneAt } = run((t) => (t < 300 ? poseAt(0) : null));
    expect(scan.front).toBeNull();
    expect(doneAt).toBeLessThan(300 + GUIDE_DEFAULTS.nobodyMs + 500);
    expect(view.done).toBe(true);
  });

  it('stuck right up against the camera: keeps coaching, then gives up instead of hanging', () => {
    const { scan, views, doneAt } = run(() => poseAt(0, { scale: 1.3 }));
    expect(views[30].coach).toMatch(/step back/i);
    expect(scan.front).toBeNull();
    expect(doneAt).toBeLessThan(GUIDE_DEFAULTS.findMaxMs + 500);
  });

  it('skip after the front photo ends it early; before, it is ignored', () => {
    const early = run(() => poseAt(0), { skipAt: 200, limit: 1000 });
    expect(early.view.stage).toBe('countdown');
    const { view, doneAt, stages } = run(() => poseAt(0), { skipAt: TURN_AT + 1000 });
    expect(view.skipped).toBe(true);
    expect(view.hint).toMatch(/front photo/i);
    expect(doneAt).toBeLessThan(stages.turn! + 1000 + GUIDE_DEFAULTS.outroMs + 100);
  });

  it('shaky detection (random facing every frame, dropouts) always finishes in bounded time', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const { view, doneAt } = run(() => (rand() < 0.3 ? null : poseAt(rand() * 360 - 180, { noise: 0.01, seed: Math.floor(rand() * 1e6) + 1 })));
    expect(view.done).toBe(true);
    expect(doneAt).toBeLessThan(GUIDE_DEFAULTS.patienceMs + 3 * GUIDE_DEFAULTS.beatMs + GUIDE_DEFAULTS.graceMs + GUIDE_DEFAULTS.snapMs + GUIDE_DEFAULTS.turnMaxMs + GUIDE_DEFAULTS.outroMs + 1000);
  });
});
