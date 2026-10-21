import { describe, expect, test } from 'vitest';
import { DRILL_STEP_MS, Drill, scoreDrill, type DrillLabel } from '../../src/game/drill';
import type { Intent } from '../../src/intent/intents';

const strike = (limb: 'armL' | 'armR', style: 'straight' | 'hook' | 'upper', t: number): Intent => ({
  kind: 'strike', limb, t, onsetT: t - 60, style, height: 'high', dir: { out: 0, up: 0, fwd: 1 }, speed: 1, windup: 1, reach: 0.5, rawSpeed: 5,
});

describe('punch drill', () => {
  test('calls each move in turn after a countdown, labels it on the pose clock, then ends', () => {
    const d = new Drill(0, [
      { say: 'Left jab', hint: '', expect: { kind: 'strike', limb: 'armL', style: 'straight' } },
      { say: 'Block', hint: '', expect: { kind: 'guard' } },
    ]);
    expect(d.at(500, 1000).ready).toBe(3);
    expect(d.at(3100, 5000).step?.say).toBe('Left jab');
    expect(d.at(3100 + DRILL_STEP_MS, 9000).step?.say).toBe('Block');
    expect(d.labels.map((l) => [l.say, l.start])).toEqual([['Left jab', 5000], ['Block', 9000]]);
    expect(d.at(3100 + 2 * DRILL_STEP_MS, 12000).done).toBe(true);
  });

  test('scores caught, the right type (after a peak restyle), quiet moves and a guard already up', () => {
    const labels: DrillLabel[] = [
      { say: 'Left jab', hint: '', expect: { kind: 'strike', limb: 'armL', style: 'straight' }, start: 0, end: 3000 },
      { say: 'Right hook', hint: '', expect: { kind: 'strike', limb: 'armR', style: 'hook' }, start: 3000, end: 6000 },
      { say: 'Stay still', hint: '', expect: { kind: 'none' }, start: 6000, end: 9000 },
      { say: 'Block', hint: '', expect: { kind: 'guard' }, start: 9000, end: 12000 },
      { say: 'Left uppercut', hint: '', expect: { kind: 'strike', limb: 'armL', style: 'upper' }, start: 12000, end: 15000 },
    ];
    const hook = strike('armR', 'straight', 3500);
    const intents: Intent[] = [
      strike('armL', 'straight', 500),
      hook, { kind: 'restyle', limb: 'armR', t: 3600, onsetT: hook.kind === 'strike' ? hook.onsetT : 0, style: 'hook', height: 'high' },
      { kind: 'guard', t: 8000, up: true },
      strike('armL', 'hook', 12500),
    ];
    const r = scoreDrill(labels, intents);
    expect(r.rows.map((x) => x.verdict)).toEqual(['hit', 'hit', 'clean', 'hit', 'wrong type']);
    expect([r.caught, r.typed, r.scored, r.quietOk, r.quiet]).toEqual([4, 3, 4, 1, 1]);
  });
});
