import { describe, expect, test } from 'vitest';
import { PoseHealth } from '../../src/input/poseHealth';

const gpu = (detectFps: number, cameraFps = 30) => ({ rated: true, detectFps, cameraFps, delegate: 'GPU' as const });

describe('pose health', () => {
  test('a fast tracker says nothing; a short dip (the governor fixing it) neither', () => {
    const health = new PoseHealth();
    expect(health.update(gpu(29))).toBeNull();
    expect(health.update(gpu(12))).toBeNull();
    expect(health.update(gpu(14))).toBeNull();
    expect(health.update(gpu(27))).toBeNull();
  });

  test('a slow tracker is told after three windows, and cleared after two good ones', () => {
    const health = new PoseHealth();
    health.update(gpu(12));
    health.update(gpu(11));
    expect(health.update(gpu(12))).toMatchObject({ kind: 'slow', text: expect.stringContaining('12 poses') });
    expect(health.update(gpu(19))?.kind).toBe('slow'); // just over the line isn't good enough yet
    expect(health.update(gpu(25))?.kind).toBe('slow');
    expect(health.update(gpu(26))).toBeNull();
  });

  test('a camera that delivers few frames (dim room) is asked for light instead', () => {
    const health = new PoseHealth();
    for (let i = 0; i < 3; i++) health.update(gpu(14.6, 15));
    expect(health.warning).toMatchObject({ kind: 'camera', text: 'Camera at 15 fps: more light on you helps' });
  });

  test('tracking on the CPU is said at once', () => {
    const health = new PoseHealth();
    expect(health.update({ rated: false, detectFps: 0, cameraFps: 0, delegate: 'CPU' })).toBeNull();
    expect(health.update({ rated: true, detectFps: 9, cameraFps: 30, delegate: 'CPU' })?.kind).toBe('cpu');
  });
});
