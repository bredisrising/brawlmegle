// The host reads its players once per sim tick, and ticks run off animation frames: after a render hitch, several
// poses wait at once. Every one of them has to reach the reader, in order.
import { expect, test } from 'vitest';
import { InputHub } from '../../src/input/InputHub';
import type { InputSource } from '../../src/input/InputSource';
import { IntentReader } from '../../src/intent/IntentReader';
import { readPoses } from '../../src/game/readPoses';
import type { PoseFrame } from '../../src/types';
import { synthesize } from '../intent/synth';

class FakeCamera implements InputSource {
  readonly kind = 'camera';
  private readonly listeners = new Set<(frame: PoseFrame) => void>();
  async start() {}
  stop() {}
  onFrame(cb: (frame: PoseFrame) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(frame: PoseFrame) {
    this.listeners.forEach((cb) => cb(frame));
  }
}

const clip = synthesize({ seconds: 12, seed: 1, only: ['jab', 'cross', 'hook'] }).frames.filter((f): f is PoseFrame => !('missing' in f));
const strikes = (intents: { kind: string }[]) => intents.filter((i) => i.kind === 'strike');

/** Ticks every `tickMs` (a slow render), each handing the hub's new poses to the reader the way Game.tick does. */
function play(tickMs: number, newestOnly: boolean) {
  const hub = new InputHub();
  const camera = new FakeCamera();
  hub.assign('p1', camera);
  const reader = new IntentReader('p1');
  const intents = [];
  let next = 0;
  for (let now = clip[0].t; next < clip.length; now += tickMs) {
    while (next < clip.length && clip[next].t <= now) camera.emit(clip[next++]);
    const frames = hub.take('p1');
    const at = { update: (frame: PoseFrame) => reader.update(frame, now) };
    const out = readPoses(at, newestOnly ? [] : frames, hub.latest('p1'));
    if (out) intents.push(...out.intents);
  }
  return intents;
}

test('a render hitch drops no poses: the reader reads the same moves as with one pose per tick', () => {
  const reference = new IntentReader('p1');
  const every = clip.flatMap((f) => reference.update(f, f.t).intents);
  expect(strikes(every).length).toBeGreaterThan(5);
  // 10 fps rendering: three poses wait each tick.
  expect(play(100, false)).toEqual(every);
  // Reading only the newest pose each tick (as before) loses most of each punch.
  expect(strikes(play(100, true)).length).toBeLessThan(strikes(every).length);
});

test('the hub hands over each frame once, oldest first, and keeps reading the newest for a repeat', () => {
  const hub = new InputHub();
  const camera = new FakeCamera();
  hub.assign('p1', camera);
  for (const f of clip.slice(0, 3)) camera.emit(f);
  expect(hub.take('p1').map((f) => f.t)).toEqual(clip.slice(0, 3).map((f) => f.t));
  expect(hub.take('p1')).toEqual([]);
  expect(hub.latest('p1')).toBe(clip[2]);
  // Nobody took them for a long while (a background tab): only the last couple of seconds wait.
  for (const f of clip.slice(0, 200)) camera.emit({ ...f, t: f.t + 100_000 });
  expect(hub.take('p1').length).toBe(60);
});
