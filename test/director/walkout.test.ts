import { describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { GUARD_POSE, JOINTS, createPose } from '../../src/director/pose';
import { perform, type Body } from '../../src/director/walkoutPose';
import { DEFAULT_BEATS, backOut, beatsFor, kf, splitName } from '../../src/director/walkoutTiming';

describe('walkout timing', () => {
  it('beats run in order and fit the ~11 s budget', () => {
    const B = DEFAULT_BEATS;
    const order = [0, B.open, B.p1, B.p2, B.two, B.vs, B.end];
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    expect(B.end).toBeGreaterThanOrEqual(9);
    expect(B.end).toBeLessThanOrEqual(11.5);
    // Each fighter's shot is long enough to read their signature action.
    expect(B.p2 - B.p1).toBeGreaterThan(2.3);
    expect(B.two - B.p2).toBeGreaterThan(2.3);
  });

  it('a custom track cue moves the beats: a drop shifts them all, explicit beats win, nonsense falls back', () => {
    expect(beatsFor(null)).toEqual(DEFAULT_BEATS);
    const shifted = beatsFor({ drop: DEFAULT_BEATS.p1 + 1 });
    expect(shifted.p1).toBeCloseTo(DEFAULT_BEATS.p1 + 1);
    expect(shifted.end).toBeCloseTo(DEFAULT_BEATS.end + 1);
    expect(beatsFor({ beats: { open: 1, p1: 2, p2: 5, two: 8, vs: 9.5, end: 10.5 } })).toEqual({ open: 1, p1: 2, p2: 5, two: 8, vs: 9.5, end: 10.5 });
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

  it('the routines keep every limb whole, stay on the floor, and land the tricks', () => {
    const B = DEFAULT_BEATS;
    const p = createPose();
    const body: Body = { slide: 0, lift: 0, turn: 0, roll: 0, spot: 0 };
    const len = (a: Vector3, b: Vector3) => a.distanceTo(b);
    const rest = {
      upper: len(GUARD_POSE.lShoulder, GUARD_POSE.lElbow),
      fore: len(GUARD_POSE.lElbow, GUARD_POSE.lWrist),
      thigh: len(GUARD_POSE.lHip, GUARD_POSE.lKnee),
      shin: len(GUARD_POSE.lKnee, GUARD_POSE.lAnkle),
    };
    const q = new Quaternion();
    const v = new Vector3();
    let worst = 0;
    let lowest = Infinity;
    let spun = 0;
    let upsideDown = 0;
    for (const id of ['p1', 'p2'] as const) {
      for (let t = 0; t <= B.end; t += 1 / 60) {
        perform(p, body, id, t, B);
        for (const j of JOINTS) expect(Number.isFinite(p[j].x + p[j].y + p[j].z), `${id} ${j} at ${t.toFixed(2)}`).toBe(true);
        for (const s of ['l', 'r'] as const) {
          const P = (n: string) => p[`${s}${n}` as keyof typeof p];
          worst = Math.max(
            worst,
            Math.abs(len(P('Shoulder'), P('Elbow')) / rest.upper - 1),
            Math.abs(len(P('Elbow'), P('Wrist')) / rest.fore - 1),
            Math.abs(len(P('Hip'), P('Knee')) / rest.thigh - 1),
            Math.abs(len(P('Knee'), P('Ankle')) / rest.shin - 1),
          );
        }
        q.setFromEuler(new Euler(0, body.turn, body.roll));
        let low = Infinity;
        for (const j of JOINTS) low = Math.min(low, v.copy(p[j]).applyQuaternion(q).y + body.lift);
        lowest = Math.min(lowest, low);
        if (id === 'p2') spun = Math.max(spun, Math.abs(body.turn));
        if (id === 'p1' && Math.abs(Math.abs(body.roll) - Math.PI) < 0.1) {
          upsideDown++;
          // Hands on the floor, feet in the air.
          expect(Math.min(v.copy(p.lWrist).applyQuaternion(q).y, v.copy(p.rWrist).applyQuaternion(q).y) + body.lift).toBeLessThan(0.05);
          expect(v.copy(p.lAnkle).applyQuaternion(q).y + body.lift).toBeGreaterThan(0.6);
        }
      }
    }
    // Limbs stretch or squash by a few percent at most (blends between keyed poses).
    expect(worst).toBeLessThan(0.08);
    expect(lowest).toBeGreaterThan(-0.02);
    expect(spun).toBeGreaterThan(2 * Math.PI - 0.01);
    expect(upsideDown).toBeGreaterThan(20);
  });

  it('back on their marks, square to the fight, when the walkout ends', () => {
    const B = DEFAULT_BEATS;
    const p = createPose();
    const body: Body = { slide: 0, lift: 0, turn: 0, roll: 0, spot: 0 };
    for (const id of ['p1', 'p2'] as const) {
      perform(p, body, id, B.end, B);
      expect(Math.abs(body.spot)).toBeLessThan(1e-3);
      expect(Math.abs(body.roll)).toBeLessThan(1e-3);
      expect(Math.abs(Math.sin(body.turn))).toBeLessThan(1e-3);
    }
  });
});
