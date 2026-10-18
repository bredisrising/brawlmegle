import { describe, expect, it } from 'vitest';
import { classify, estimateFacing, fitLongSide, laplacianVariance, personBox, toGray } from '../../src/forge/scanBuckets';
import { poseAt } from './pose';

describe('estimateFacing', () => {
  it('reads square-on as front', () => {
    const f = estimateFacing(poseAt(0))!;
    expect(f.yaw).toBeLessThan(5);
    expect(f.frontal).toBe(true);
    expect(classify(f)).toEqual({ bucket: 'front', tier: 2 });
  });

  it('reads profiles by side: +90 is the left side toward the camera', () => {
    expect(classify(estimateFacing(poseAt(90))!)).toEqual({ bucket: 'left', tier: 2 });
    expect(classify(estimateFacing(poseAt(-90))!)).toEqual({ bucket: 'right', tier: 2 });
    expect(estimateFacing(poseAt(90))!.nose).toBeLessThan(0); // nose points image-left
  });

  it('counts 3/4 views as a lower tier', () => {
    expect(classify(estimateFacing(poseAt(50), 0.72)!)).toEqual({ bucket: 'left', tier: 1 });
    expect(classify(estimateFacing(poseAt(-50), 0.72)!)).toEqual({ bucket: 'right', tier: 1 });
  });

  it('turns more as the shoulders narrow', () => {
    const yaws = [0, 20, 40, 60, 80].map((y) => estimateFacing(poseAt(y), 0.72)!.yaw);
    for (let i = 1; i < yaws.length; i++) expect(yaws[i]).toBeGreaterThan(yaws[i - 1]);
    expect(yaws[2]).toBeCloseTo(40, -1);
  });

  it('is the same at any video aspect', () => {
    const a = estimateFacing(poseAt(60, { aspect: 16 / 9 }), 0.72)!;
    const b = estimateFacing(poseAt(60, { aspect: 4 / 3 }), 0.72)!;
    expect(a.yaw).toBeCloseTo(b.yaw, 3);
    expect(a.nose).toBeCloseTo(b.nose, 3);
  });

  it('does not call a correctly labeled back view the front', () => {
    const f = estimateFacing(poseAt(180))!;
    expect(f.frontal).toBe(false);
    expect(classify(f)).toBeNull();
  });

  it('skips 3/4 back views but keeps a profile from just behind', () => {
    expect(classify(estimateFacing(poseAt(130), 0.72)!)).toBeNull();
    expect(classify(estimateFacing(poseAt(-130), 0.72)!)).toBeNull();
    expect(classify(estimateFacing(poseAt(-105), 0.72)!)).toEqual({ bucket: 'right', tier: 2 });
  });

  it('skips frames where the head faces away, even if the shoulders look like a profile', () => {
    const frame = poseAt(90);
    frame.world[0] = { ...frame.world[0], z: 0.08 }; // nose behind the ears
    expect(classify(estimateFacing(frame)!)).toBeNull();
  });

  it('needs the torso in frame', () => {
    const frame = poseAt(0);
    frame.image[23] = { ...frame.image[23], visibility: 0.1 };
    expect(estimateFacing(frame)).toBeNull();
    expect(estimateFacing(poseAt(0, { scale: 0.05 }))).toBeNull(); // too far away
  });
});

describe('crop and sharpness', () => {
  it('boxes the whole person with head room, inside the frame', () => {
    const frame = poseAt(0);
    const box = personBox(frame, 640, 480)!;
    const ys = frame.image.map((p) => p.y * 480);
    const xs = frame.image.map((p) => p.x * 640);
    expect(box.y).toBeLessThan(Math.min(...ys) - 10); // above the eyes: room for the head
    expect(box.y + box.h).toBeGreaterThanOrEqual(Math.max(...ys));
    expect(box.x).toBeLessThanOrEqual(Math.min(...xs));
    expect(box.x + box.w).toBeGreaterThanOrEqual(Math.max(...xs));
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.w).toBeLessThanOrEqual(640);
    expect(box.y + box.h).toBeLessThanOrEqual(480);
  });

  it('keeps a profile crop from being a sliver', () => {
    const box = personBox(poseAt(90, { scale: 0.3 }), 640, 480)!;
    expect(box.w / box.h).toBeGreaterThanOrEqual(0.59);
  });

  it('fits the long side without upscaling', () => {
    expect(fitLongSide(2000, 1000, 1024)).toEqual({ w: 1024, h: 512 });
    expect(fitLongSide(300, 400, 1024)).toEqual({ w: 300, h: 400 });
  });

  it('scores a sharp image above a blurred one, and flat as zero', () => {
    const w = 64, h = 64;
    const sharp = new Float32Array(w * h).map((_, i) => (((i % w) >> 2) + ((i / w) >> 2)) % 2 ? 255 : 0);
    const blurred = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let sum = 0, n = 0;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy));
            sum += sharp[yy * w + xx];
            n++;
          }
        blurred[y * w + x] = sum / n;
      }
    expect(laplacianVariance(sharp, w, h)).toBeGreaterThan(5 * laplacianVariance(blurred, w, h));
    expect(laplacianVariance(new Float32Array(w * h).fill(128), w, h)).toBe(0);
  });

  it('converts RGBA to luma', () => {
    const gray = toGray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255], 3, 1);
    expect(gray[0]).toBeCloseTo(255, 3);
    expect(gray[1]).toBe(0);
    expect(gray[2]).toBeCloseTo(76.245, 3);
  });
});
