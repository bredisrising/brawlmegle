import { describe, expect, it } from 'vitest';
import { WALKOUT, backOut, entranceKinds, kf, splitName } from '../../src/director/walkoutTiming';

describe('walkout timing', () => {
  it('beats run in order and fit the 5-7 s budget', () => {
    const order = [WALKOUT.p1, WALKOUT.p1Slam, WALKOUT.wipe1, WALKOUT.p2Spawn, WALKOUT.p2, WALKOUT.p2Slam, WALKOUT.wipe2, WALKOUT.vs, WALKOUT.ready, WALKOUT.flash, WALKOUT.end];
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    expect(WALKOUT.end).toBeLessThanOrEqual(6);
  });

  it('each cut happens under its flame wipe (covered by then, not yet burned away)', () => {
    const hold = 0.1;
    expect(WALKOUT.wipe1 + WALKOUT.wipeIn).toBeLessThanOrEqual(WALKOUT.p2);
    expect(WALKOUT.wipe1 + WALKOUT.wipeIn + hold).toBeGreaterThanOrEqual(WALKOUT.p2 - 0.1);
    expect(WALKOUT.wipe2 + WALKOUT.wipeIn).toBeLessThanOrEqual(WALKOUT.vs + 1e-9);
  });

  it('keyframes hold their ends and ease between', () => {
    const keys = [[0, 0], [1, 10]] as const;
    expect(kf(-1, keys)).toBe(0);
    expect(kf(2, keys)).toBe(10);
    expect(kf(0.5, keys)).toBeCloseTo(5);
    expect(backOut(0)).toBeCloseTo(0);
    expect(backOut(1)).toBeCloseTo(1);
    expect(Math.max(...[0.3, 0.5, 0.7].map(backOut))).toBeGreaterThan(1); // the slam overshoots
  });

  it('names: CPU and training tags come off the big name', () => {
    expect(splitName('Avi (CPU hard)')).toEqual({ name: 'Avi', tag: 'CPU hard' });
    expect(splitName('Training dummy')).toEqual({ name: 'Dummy', tag: 'Training' });
    expect(splitName('demo')).toEqual({ name: 'demo', tag: null });
  });

  it('entrance poses: same on both laptops, never the same for both fighters', () => {
    for (const [a, b] of [['demo', 'rival'], ['x', 'x'], ['Avi (CPU)', 'Dylan']]) {
      const k = entranceKinds(a, b);
      expect(k).toEqual(entranceKinds(a, b));
      expect(k.p1).not.toBe(k.p2);
    }
  });
});
