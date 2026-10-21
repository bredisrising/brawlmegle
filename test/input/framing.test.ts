import { describe, expect, test } from 'vitest';
import { FramingCoach, framingOf } from '../../src/input/framing';
import type { Landmark, PoseFrame } from '../../src/types';

/** A front-facing upper body: nose at (cx, noseY), shoulders `w` apart (share of the frame width) at shoulderY. */
function frame(t: number, { cx = 0.5, noseY = 0.25, shoulderY = 0.45, w = 0.23, wrists = 0.9, nose = 0.99 } = {}): PoseFrame {
  const image: Landmark[] = Array.from({ length: 33 }, () => ({ x: cx, y: 0.6, z: 0, visibility: 0.9 }));
  image[0] = { x: cx, y: noseY, z: 0, visibility: nose };
  image[11] = { x: cx + w / 2, y: shoulderY, z: 0, visibility: 0.99 };
  image[12] = { x: cx - w / 2, y: shoulderY, z: 0, visibility: 0.99 };
  image[15] = { x: cx + 0.1, y: 0.5, z: 0, visibility: wrists };
  image[16] = { x: cx - 0.1, y: 0.5, z: 0, visibility: wrists };
  return { t, image, world: image, aspect: 4 / 3 };
}

describe('framing', () => {
  test('a well-framed player gets no hint', () => {
    expect(framingOf(frame(0))).toBeNull();
  });

  test('says the one thing to fix', () => {
    expect(framingOf(frame(0, { noseY: 0.03, shoulderY: 0.2 }))?.kind).toBe('head');
    expect(framingOf(frame(0, { w: 0.5 }))?.kind).toBe('close');
    expect(framingOf(frame(0, { w: 0.1 }))?.kind).toBe('far');
    expect(framingOf(frame(0, { cx: 0.1 }))?.kind).toBe('side');
    expect(framingOf(frame(0, { shoulderY: 0.55, noseY: 0.35, wrists: 0.1 }))?.kind).toBe('hands');
  });

  test('a hint needs most of the last few seconds, so a moment out of shape (a duck, a lunge) says nothing', () => {
    const coach = new FramingCoach();
    let hint = null;
    for (let i = 0; i < 12; i++) hint = coach.update(frame(i, i % 4 === 0 ? { w: 0.5 } : {}));
    expect(hint).toBeNull();
    for (let i = 12; i < 24; i++) hint = coach.update(frame(i, { w: 0.5 }));
    expect(hint?.kind).toBe('close');
  });
});
