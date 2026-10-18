// Edge cases the live game hits: a player walking out of frame, bad landmark data from a peer, clock jumps.
import { describe, expect, test } from 'vitest';
import { IntentReader } from '../../src/intent/IntentReader';
import { PosePreprocessor, type Body } from '../../src/intent/preprocess';
import type { PoseFrame } from '../../src/types';
import { synthesize } from './synth';

/** A clean standing body (the script's first move starts at 1.5 s). */
function standing(): PoseFrame[] {
  return synthesize({ seconds: 4, noise: 0, seed: 3 }).frames
    .filter((f): f is PoseFrame => !('missing' in f) && f.t < 1400);
}

const finiteBody = (b: { points: { p: { x: number; y: number; z: number } }[]; scale: number }) =>
  b.points.every((pt) => Number.isFinite(pt.p.x) && Number.isFinite(pt.p.y) && Number.isFinite(pt.p.z)) && Number.isFinite(b.scale);

describe('intent edge cases', () => {
  test('a player who walks out of frame stays untracked (the hub keeps handing over their last frame)', () => {
    const frames = standing();
    const reader = new IntentReader('p1');
    for (const f of frames) reader.update(f, f.t);
    const last = frames[frames.length - 1];
    expect(reader.update(last, last.t).stance.tracked).toBe(true);
    // 2 s of 60 Hz ticks with nothing new from the camera.
    const tracked: number[] = [];
    for (let now = last.t + 400; now < last.t + 2400; now += 1000 / 60) {
      if (reader.update(last, now).stance.tracked) tracked.push(now);
    }
    expect(tracked).toEqual([]);
  });

  test('tracking comes back once new frames arrive after a loss', () => {
    const frames = standing();
    const reader = new IntentReader('p1');
    const half = frames.slice(0, 20);
    for (const f of half) reader.update(f, f.t);
    const last = half[half.length - 1];
    for (let now = last.t; now < last.t + 1000; now += 1000 / 60) reader.update(last, now);
    // The player steps back in: fresh frames (later camera time), host clock 1 s on.
    let out = reader.update(frames[25], last.t + 1000);
    for (const f of frames.slice(26)) out = reader.update(f, f.t - frames[25].t + last.t + 1000);
    expect(out.stance.tracked).toBe(true);
  });

  test('lost players hold guard (SPEC: tracking loss -> fighter holds guard)', () => {
    const reader = new IntentReader('p1');
    const out = reader.update(null, 1000);
    expect(out.stance.tracked).toBe(false);
    expect(out.stance.guard).toBe(true);
  });

  test('one NaN landmark does not poison the filters', () => {
    const frames = standing();
    const pre = new PosePreprocessor();
    frames.slice(0, 15).forEach((f) => pre.process(f));
    const bad = structuredClone(frames[15]);
    bad.image[11].x = NaN; // left shoulder
    bad.world[13].z = NaN; // left elbow
    pre.process(bad);
    let body: Body | null = null;
    for (const f of frames.slice(16, 30)) body = pre.process(f) ?? body;
    expect(body).not.toBeNull();
    expect(finiteBody(body!)).toBe(true);
    expect(Number.isFinite(body!.elbow.L)).toBe(true);
  });

  test('null or missing landmarks from a peer are ignored, not a crash', () => {
    const frames = standing();
    const reader = new IntentReader('p2');
    frames.slice(0, 10).forEach((f) => reader.update(f, f.t));
    const bad = structuredClone(frames[10]) as unknown as { image: unknown[]; world: unknown[]; t: number };
    bad.image[15] = null;
    bad.world[3] = undefined;
    expect(() => reader.update(bad as unknown as PoseFrame, bad.t)).not.toThrow();
    const notArrays = { t: frames[11].t, image: 'x', world: null } as unknown as PoseFrame;
    expect(() => reader.update(notArrays, notArrays.t)).not.toThrow();
    let out = reader.update(frames[12], frames[12].t);
    for (const f of frames.slice(13, 20)) out = reader.update(f, f.t);
    expect(out.stance.tracked).toBe(true);
    expect(finiteBody(out.body!)).toBe(true);
  });
});

describe('lost points', () => {
  test('a hand that reappears far from where it was last seen is picked up again, not held forever', () => {
    const frames = standing();
    const pre = new PosePreprocessor();
    let body: Body | null = null;
    frames.forEach((f, i) => {
      const g = structuredClone(f);
      // Blurred out for a few frames mid-swing, then seen again at the end of a big swing, and it stays there.
      if (i >= 10 && i < 14) g.image[15].visibility = 0.05;
      if (i >= 14) g.image[15].y += 0.3; // ~1.8 torso lengths
      body = pre.process(g) ?? body;
    });
    const wrist = body!.points[15];
    expect(wrist.ok).toBe(true);
  });
});

describe('clock restarts', () => {
  test('a peer that reloads (its clock restarts near 0) can still duck right away', () => {
    const { frames, labels } = synthesize({ seconds: 12, noise: 0, seed: 2, only: ['duck'] });
    const clean = frames.filter((f): f is PoseFrame => !('missing' in f));
    const reader = new IntentReader('p2');
    const offset = 600_000; // the first session ran for 10 minutes
    let ducks = 0;
    for (const f of clean) ducks += reader.update({ ...f, t: f.t + offset }, f.t + offset).intents.filter((i) => i.kind === 'duck').length;
    expect(ducks).toBeGreaterThan(0);
    // Reload + rejoin: same reader on the host, the peer's clock starts over. Host clock keeps going.
    const hostStart = clean[clean.length - 1].t + offset + 5000;
    ducks = 0;
    for (const f of clean) ducks += reader.update(f, hostStart + f.t).intents.filter((i) => i.kind === 'duck').length;
    expect(ducks).toBeGreaterThanOrEqual(labels.length - 1);
  });
});

describe('gaps in the frames', () => {
  test('a punch cut off by a tracking gap does not fire from stale state when tracking resumes', () => {
    const { frames, labels } = synthesize({ seconds: 6, noise: 1, seed: 1, only: ['cross'] });
    const clean = frames.filter((f): f is PoseFrame => !('missing' in f));
    const punch = labels[0];
    expect(labels[1].start).toBeGreaterThan(punch.end + 900); // nothing else going on after the gap
    const reader = new IntentReader('p1');
    const before: string[] = [];
    // Partway into the first punch (wound up, not confirmed yet)...
    for (const f of clean.filter((f) => f.t < punch.start + 140)) {
      for (const i of reader.update(f, f.t).intents) before.push(i.kind);
    }
    expect(before).toContain('anticipate');
    expect(before).not.toContain('strike');
    // ...then nothing for 0.4 s on the camera's clock while the host was suspended (tab hidden: its clock jumps
    // too), and the player is standing still again when frames resume.
    const after = clean.filter((f) => f.t > punch.end + 400 && f.t < punch.end + 700);
    const strikes = after.flatMap((f) => reader.update(f, f.t).intents).filter((i) => i.kind === 'strike');
    expect(strikes).toEqual([]);
  });
});
