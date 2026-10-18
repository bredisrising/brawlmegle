import { describe, expect, it } from 'vitest';
import { DEFAULT_BEATS, SIGNATURES, backOut, beatsFor, kf, signatures, splitName } from '../../src/director/walkoutTiming';

describe('walkout timing', () => {
  it('beats run in order and fit the 8-10 s budget', () => {
    const B = DEFAULT_BEATS;
    const order = [0, B.p1, B.p2, B.two, B.vs, B.end];
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    expect(B.end).toBeGreaterThanOrEqual(8);
    expect(B.end).toBeLessThanOrEqual(10.5);
    // Each fighter's shot is long enough to read their signature action.
    expect(B.p2 - B.p1).toBeGreaterThan(2.3);
    expect(B.two - B.p2).toBeGreaterThan(2.3);
  });

  it('a custom track cue moves the beats: a drop shifts them all, explicit beats win, nonsense falls back', () => {
    expect(beatsFor(null)).toEqual(DEFAULT_BEATS);
    const shifted = beatsFor({ drop: DEFAULT_BEATS.p1 + 1 });
    expect(shifted.p1).toBeCloseTo(DEFAULT_BEATS.p1 + 1);
    expect(shifted.end).toBeCloseTo(DEFAULT_BEATS.end + 1);
    expect(beatsFor({ beats: { p1: 2, p2: 5, two: 8, vs: 9.5, end: 10.5 } })).toEqual({ p1: 2, p2: 5, two: 8, vs: 9.5, end: 10.5 });
    expect(beatsFor({ beats: { p1: 5, p2: 2 } })).toEqual(DEFAULT_BEATS);
    expect(beatsFor({ drop: 'soon' })).toEqual(DEFAULT_BEATS);
  });

  it('keyframes hold their ends and ease between', () => {
    const keys = [[0, 0], [1, 10]] as const;
    expect(kf(-1, keys)).toBe(0);
    expect(kf(2, keys)).toBe(10);
    expect(kf(0.5, keys)).toBeCloseTo(5);
    expect(backOut(0)).toBeCloseTo(0);
    expect(backOut(1)).toBeCloseTo(1);
    expect(Math.max(...[0.3, 0.5, 0.7].map(backOut))).toBeGreaterThan(1);
  });

  it('names: CPU and training tags come off the name', () => {
    expect(splitName('Avi (CPU hard)')).toEqual({ name: 'Avi', tag: 'CPU hard' });
    expect(splitName('Training dummy')).toEqual({ name: 'Dummy', tag: 'Training' });
    expect(splitName('demo')).toEqual({ name: 'demo', tag: null });
  });

  it('signatures: same on both laptops, never the same for both fighters, all of them reachable', () => {
    const seen = new Set<string>();
    for (const [a, b] of [['demo', 'rival'], ['x', 'x'], ['Avi (CPU)', 'Dylan'], ...Array.from({ length: 60 }, (_, i) => [`p${i}`, `q${i}`])]) {
      const k = signatures(a, b);
      expect(k).toEqual(signatures(a, b));
      expect(k.p1).not.toBe(k.p2);
      seen.add(k.p1).add(k.p2);
    }
    expect(seen.size).toBe(SIGNATURES.length);
  });
});
