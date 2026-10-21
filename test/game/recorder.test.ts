// Match recording: frames deduped per player, intents and events kept, a CPU skipped, one upload per real player.
import { afterEach, expect, test, vi } from 'vitest';
import type { PoseFrame } from '../../src/types';

// The recorder reads the page URL (for ?video=) and the config; give it a minimal browser-ish world.
vi.stubGlobal('window', { location: { search: '' } });
vi.mock('../../src/config', () => ({ config: { forgeApi: 'https://example.test' } }));

const frame = (t: number): PoseFrame => {
  const lm = Array.from({ length: 33 }, (_, i) => ({ x: 0.5 + i / 1000, y: 0.5, z: 0, visibility: 0.9 }));
  return { t, image: lm, world: lm, aspect: 4 / 3 };
};

afterEach(() => vi.unstubAllGlobals());

test('records frames, intents and events for real players and uploads one file each', async () => {
  vi.stubGlobal('window', { location: { search: '' } });
  const bodies: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    return { ok: true, status: 201 };
  });
  const { MatchRecorder } = await import('../../src/game/MatchRecorder');
  const r = new MatchRecorder();
  r.start({ p1: { name: 'ankit', cpu: false }, p2: { name: 'rico', cpu: true } }, null);
  const tracker = {
    model: 'full', delegate: 'GPU', runner: 'worker', onePose: false, detectMs: 29.5, posesPerSec: 29.9, cameraFps: 30,
    width: 640, height: 480, frameRate: 30, exposure: 'hold', exposureTime: 62, userAgent: 'Edg/141',
  } as const;
  r.tracker('p1', tracker);
  for (let i = 0; i < 60; i++) {
    const f = frame(1000 + i * 33);
    r.frame('p1', f);
    r.frame('p1', f); // the same frame handed over again next tick: kept once
    r.frame('p2', f); // a CPU has no camera
  }
  r.intents('p1', [{ kind: 'guard', t: 1100, up: true }]);
  r.event({ t: 50, type: 'hit', attacker: 'p1', move: 'jab', damage: 5 });
  await r.stop({ winner: 'p1', ending: 'ko' });

  expect(bodies).toHaveLength(1);
  const lines = bodies[0].trim().split('\n').map((l) => JSON.parse(l));
  expect(lines[0]).toMatchObject({ clip: 'match', player: 'p1', name: 'ankit', opponent: 'rico', frames: 60, labels: [] });
  // What the laptop ran, and how long the poses cover (frames / seconds = poses a second).
  expect(lines[0]).toMatchObject({ tracker, seconds: 1.947 });
  expect(lines.filter((l) => l.image)).toHaveLength(60);
  expect(lines.some((l) => l.intent?.kind === 'guard')).toBe(true);
  expect(lines.some((l) => l.event?.type === 'hit' && l.t > 0)).toBe(true);
});
