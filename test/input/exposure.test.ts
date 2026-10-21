import { afterEach, describe, expect, test, vi } from 'vitest';
import { ExposureTuner, ShortExposure, exposureCaps, medianLuma, type ExposureCaps } from '../../src/input/exposure';

/** A webcam: brightness grows with exposure time like a gamma-2.2 camera, 0–255. */
const camera = (lumaAt: number, at: number) => (time: number) => Math.min(255, lumaAt * (time / at) ** (1 / 2.2));

/** Runs a tuner against a camera until it settles. Returns the time it holds (or 'auto') and how many it tried. */
function settle(tuner: ExposureTuner, luma: (time: number) => number, quantize = (t: number) => t) {
  let tries = 0;
  while (tuner.phase === 'search' && tries < 20) {
    tries++;
    const next = tuner.measured(luma(quantize(tuner.current)));
    if (next === 'auto') return { time: 'auto' as const, tries };
  }
  return { time: tuner.phase === 'auto' ? ('auto' as const) : tuner.current, tries };
}

const CAPS: ExposureCaps = { min: 1, max: 10_000, step: 1 };

describe('exposure tuner', () => {
  test('a lit room: the shortest time that keeps the picture at the floor', () => {
    // The camera's own exposure picked 1/66 s for a median of 120: 80 is reached at about 62 (1/160 s).
    const luma = camera(120, 150);
    const tuner = new ExposureTuner(CAPS, 30, 120);
    expect(tuner.floor).toBe(80);
    const { time, tries } = settle(tuner, luma);
    expect(time).toBeGreaterThanOrEqual(62);
    expect(time).toBeLessThanOrEqual(62 * 1.25);
    expect(tries).toBeLessThanOrEqual(8);
  });

  test('a bright room goes shorter than 1/250 s, but never past 1/1000 s', () => {
    const tuner = new ExposureTuner(CAPS, 30, 130);
    const { time } = settle(tuner, camera(130, 30));
    expect(time).toBeGreaterThanOrEqual(10);
    expect(time).toBeLessThan(20);
    expect(settle(new ExposureTuner(CAPS, 30, 250), camera(250, 10)).time).toBe(10);
  });

  test('a dim room keeps a darker floor, and the frame rate (the exposure stays under a frame)', () => {
    // The camera's own exposure: a whole 30 fps frame for a median of 70 (it may well drop to 15 fps instead).
    const tuner = new ExposureTuner(CAPS, 30, 70);
    expect(tuner.floor).toBe(56);
    const { time } = settle(tuner, camera(70, 333));
    expect(time).toBeGreaterThanOrEqual(204);
    expect(time).toBeLessThanOrEqual(300);
  });

  test('too dark for any short exposure: the camera keeps its own', () => {
    expect(new ExposureTuner(CAPS, 30, 40).phase).toBe('auto');
    // Its own exposure was a 15 fps frame: at 30 fps nothing is bright enough.
    expect(settle(new ExposureTuner(CAPS, 30, 70), camera(70, 666)).time).toBe('auto');
  });

  test('cameras with only a few exposure times (powers of two on Windows) still settle', () => {
    const quantize = (t: number) => 10_000 * 2 ** Math.round(Math.log2(t / 10_000));
    const luma = camera(120, 150);
    const tuner = new ExposureTuner(CAPS, 30, 120);
    const { time } = settle(tuner, luma, quantize);
    expect(time).not.toBe('auto');
    expect(luma(quantize(time as number))).toBeGreaterThanOrEqual(80);
  });

  test('holding: a lasting change in the light searches again, a passing one does not', () => {
    const tuner = new ExposureTuner(CAPS, 30, 120);
    settle(tuner, camera(120, 150));
    const held = tuner.current;
    expect(tuner.measured(30)).toBeNull(); // someone walked in front of the lamp for a moment
    expect(tuner.measured(85)).toBeNull();
    expect(tuner.phase).toBe('hold');
    // The lamp went off: three checks in a row well under the floor.
    tuner.measured(40);
    tuner.measured(40);
    expect(tuner.measured(40)).toBeGreaterThan(held);
    expect(tuner.phase).toBe('search');
  });

  test('median luma of RGBA pixels', () => {
    const px = (...rgb: number[][]) => rgb.flatMap(([r, g, b]) => [r, g, b, 255]);
    expect(medianLuma(px([0, 0, 0], [255, 255, 255], [100, 100, 100]))).toBe(100);
    expect(medianLuma(px([255, 0, 0], [0, 255, 0], [0, 0, 255]))).toBe(76);
  });
});

/** A camera track that allows manual exposure (or refuses it), with a gamma-2.2 picture. */
function fakeTrack({ refuse = false, lux = 1 } = {}) {
  const state = { mode: 'continuous', time: 150, lux, applied: [] as object[] };
  const track = {
    getCapabilities: () => ({ exposureMode: ['continuous', 'manual'], exposureTime: { min: 1, max: 1000, step: 1 } }),
    getSettings: () => ({ frameRate: 30, exposureMode: state.mode, exposureTime: state.time }),
    applyConstraints: async (c?: MediaTrackConstraints) => {
      const set = c!.advanced![0] as { exposureMode?: string; exposureTime?: number };
      state.applied.push(set);
      if (refuse && set.exposureMode === 'manual') throw new DOMException('not supported', 'OverconstrainedError');
      if (set.exposureMode) state.mode = set.exposureMode;
      if (set.exposureTime) state.time = set.exposureTime;
    },
  };
  const luma = () => (state.mode === 'continuous' ? 120 : camera(120 * state.lux, 150)(state.time));
  return { track: track as unknown as MediaStreamTrack, state, luma };
}

describe('short exposure on a camera', () => {
  afterEach(() => vi.useRealTimers());

  test("cameras that don't allow it (the fake camera, MacBooks) are left alone", () => {
    const track = { getCapabilities: () => ({ width: { min: 1, max: 640 } }), getSettings: () => ({}), applyConstraints: async () => {} };
    expect(exposureCaps(track as unknown as MediaStreamTrack)).toBeNull();
    expect(exposureCaps({ getSettings: () => ({}) } as unknown as MediaStreamTrack)).toBeNull();
  });

  test('settles on a short exposure, and gives the camera its own back on release', async () => {
    vi.useFakeTimers();
    const { track, state, luma } = fakeTrack();
    const exposure = new ShortExposure(track, exposureCaps(track)!, luma);
    exposure.start();
    await vi.advanceTimersByTimeAsync(8000);
    expect(exposure.state).toBe('hold');
    expect(state.mode).toBe('manual');
    expect(exposure.time).toBeGreaterThanOrEqual(62);
    expect(exposure.time).toBeLessThanOrEqual(78);
    await exposure.release();
    expect(state.mode).toBe('continuous');
    expect(exposure.manual).toBe(false);
    expect(exposure.state).toBe('off');
    // Started again (the tab came back): measures and searches again.
    exposure.start();
    await vi.advanceTimersByTimeAsync(8000);
    expect(exposure.state).toBe('hold');
  });

  test('a camera that refuses gets its own exposure back, and is not asked again', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { track, state, luma } = fakeTrack({ refuse: true });
    const exposure = new ShortExposure(track, exposureCaps(track)!, luma);
    exposure.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(exposure.state).toBe('failed');
    expect(state.applied.at(-1)).toEqual({ exposureMode: 'continuous' });
    const asked = state.applied.length;
    exposure.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.applied.length).toBe(asked);
  });

  test('released mid-search: nothing more is set after the camera got its own back', async () => {
    vi.useFakeTimers();
    const { track, state, luma } = fakeTrack();
    const exposure = new ShortExposure(track, exposureCaps(track)!, luma);
    exposure.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(state.mode).toBe('manual');
    await exposure.release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.mode).toBe('continuous');
    expect(state.applied.at(-1)).toEqual({ exposureMode: 'continuous' });
  });
});
