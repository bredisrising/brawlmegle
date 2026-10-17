import { describe, expect, it } from 'vitest';
import {
  ScanBuckets, classify, estimateFacing, fitLongSide, laplacianVariance, personBox, toGray,
  type Bucket,
} from '../../src/forge/scanBuckets';
import { poseAt, swapSides } from './pose';

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

  it('needs the torso in frame', () => {
    const frame = poseAt(0);
    frame.image[23] = { ...frame.image[23], visibility: 0.1 };
    expect(estimateFacing(frame)).toBeNull();
    expect(estimateFacing(poseAt(0, { scale: 0.05 }))).toBeNull(); // too far away
  });
});

/** Feeds a yaw track (deg per frame, 30 fps) through ScanBuckets. Sharpness comes from `sharp(yaw)`. */
function run(yaws: number[], opts: { sharp?: (yaw: number, i: number) => number; flipBack?: boolean; duration?: number } = {}) {
  const scan = new ScanBuckets({ durationMs: opts.duration ?? 15000 });
  const kept: Partial<Record<Bucket, number>> = {};
  let doneAt = -1;
  yaws.forEach((yaw, i) => {
    if (doneAt >= 0) return;
    const t = (i * 1000) / 30;
    let frame = poseAt(yaw, { t, noise: 0.002, seed: i + 1 });
    // MediaPipe often reads a back view as a (left/right swapped) front view.
    const back = Math.abs((((yaw % 360) + 360) % 360) - 180) < 50;
    if (opts.flipBack && back) frame = swapSides(frame);
    const offer = scan.offer(frame, t);
    if (offer && scan.submit(offer, opts.sharp?.(yaw, i) ?? 100 + (i % 7))) kept[offer.bucket] = yaw;
    if (scan.progress.done) doneAt = t;
  });
  return { scan, kept, progress: scan.progress, doneAt };
}

/** Linear turn from `from` to `to` degrees over `seconds`, then hold `hold` seconds. */
const turn = (from: number, to: number, seconds: number, hold = 0) => {
  const n = Math.round(seconds * 30);
  return [...Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n), ...Array(Math.round(hold * 30)).fill(to)];
};

describe('ScanBuckets', () => {
  it('fills all three buckets in a slow 360° turn and finishes early', () => {
    const yaws = [...Array(30).fill(0), ...turn(0, -360, 10, 3)]; // 1 s facing the camera, turn to their left
    const { progress, kept, doneAt } = run(yaws);
    expect(progress.buckets.front.tier).toBe(2);
    expect(progress.buckets.left.tier).toBe(2);
    expect(progress.buckets.right.tier).toBe(2);
    expect(progress.done).toBe(true);
    expect(doneAt).toBeLessThan(15000);
    expect(Math.abs(kept.right! + 90)).toBeLessThan(30); // right side toward camera at -90
    expect(Math.abs(kept.left! + 270)).toBeLessThan(30); // ...and left at -270
  });

  it('never keeps a back view as the front, even a mislabeled and very sharp one', () => {
    const yaws = [...Array(20).fill(0), ...turn(0, -360, 10, 1)];
    const { kept } = run(yaws, { flipBack: true, sharp: (yaw) => (Math.abs(Math.abs(yaw) - 180) < 40 ? 10000 : 50) });
    const front = ((kept.front! % 360) + 360) % 360;
    expect(Math.min(front, 360 - front)).toBeLessThan(25);
  });

  it('keeps the sharpest frame in a bucket', () => {
    const yaws = Array(60).fill(0);
    const { kept, progress } = run(yaws.map((_, i) => (i === 37 ? 1 : 0)), { sharp: (yaw) => (yaw === 1 ? 500 : 100) });
    expect(kept.front).toBe(1);
    expect(progress.buckets.front.sharpness).toBe(500);
  });

  it('a true profile beats a sharper 3/4 view', () => {
    const yaws = [...Array(20).fill(0), ...turn(0, -50, 1, 1), ...turn(-50, -90, 1, 0.5)];
    const { kept, progress } = run(yaws, { sharp: (yaw) => (yaw > -60 ? 1000 : 10) });
    expect(progress.buckets.right.tier).toBe(2);
    expect(kept.right!).toBeLessThan(-60);
  });

  it('falls back to 3/4 views when a profile never comes', () => {
    const yaws = [...Array(20).fill(0), ...turn(0, -50, 2, 1), ...turn(-50, 50, 4, 1)];
    const { progress } = run(yaws);
    expect(progress.buckets.left.tier).toBe(1);
    expect(progress.buckets.right.tier).toBe(1);
  });

  it('times out with what it has', () => {
    const yaws = [...Array(20).fill(0), ...turn(0, -90, 2, 20)]; // never shows the left side
    const { progress, doneAt } = run(yaws, { duration: 8000 });
    expect(progress.done).toBe(true);
    expect(doneAt).toBeGreaterThanOrEqual(8000);
    expect(progress.buckets.front.tier).toBe(2);
    expect(progress.buckets.right.tier).toBe(2);
    expect(progress.buckets.left.tier).toBe(0);
    expect(progress.hint).toMatch(/time/i);
  });

  it('guides the player: face the camera, then turn left, then keep going', () => {
    const scan = new ScanBuckets();
    scan.offer(poseAt(0, { t: 0 }), 0);
    expect(scan.progress.hint).toMatch(/face the camera/i);
    for (let i = 0; i < 10; i++) {
      const offer = scan.offer(poseAt(0, { t: i * 33 }), i * 33);
      if (offer) scan.submit(offer, 100);
    }
    expect(scan.progress.hint).toMatch(/turn slowly to your left/i);
    for (let i = 0; i < 10; i++) {
      const offer = scan.offer(poseAt(-90, { t: 400 + i * 33 }), 400 + i * 33);
      if (offer) scan.submit(offer, 100);
    }
    expect(scan.progress.hint).toMatch(/keep going/i);
    expect(scan.progress.fraction).toBeCloseTo(2 / 3, 5);
    scan.idle(2000);
    expect(scan.progress.hint).toMatch(/step back/i);
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
