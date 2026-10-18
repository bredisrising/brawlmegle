// The super gesture (both fists held up over the head) is read as 'special', standing or sitting, at any camera.
import { expect, test } from 'vitest';
import { IntentReader } from '../../src/intent/IntentReader';
import type { PoseFrame } from '../../src/types';
import { synthesize } from './synth';

const CONDITIONS = [
  { name: 'standing', opts: {} },
  { name: 'sitting', opts: { sitting: true } },
  { name: 'sitting, camera 30° off', opts: { sitting: true, cameraYaw: 30 } },
  { name: 'standing, 15 fps', opts: { fps: 15 } },
];

test('the super pose reads as special', () => {
  let total = 0;
  let seen = 0;
  for (const c of CONDITIONS) {
    for (const seed of [1, 2]) {
      const { frames, labels } = synthesize({ seconds: 40, seed, only: ['super'], ...c.opts });
      const r = new IntentReader('p1');
      const intents = frames.filter((f): f is PoseFrame => !('missing' in f)).flatMap((f) => r.update(f, f.t).intents);
      const specials = intents.filter((i) => i.kind === 'special');
      const hits = labels.filter((l) => specials.some((s) => s.t >= l.start && s.t <= l.end + 300)).length;
      total += labels.length;
      seen += hits;
      if (seed === 1) console.log(`${c.name}: ${hits}/${labels.length} supers read, ${specials.length} special intents`);
    }
  }
  console.log(`all: ${seen}/${total}`);
  expect(seen / total).toBeGreaterThan(0.75);
});
