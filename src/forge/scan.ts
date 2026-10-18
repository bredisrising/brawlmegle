import type { PoseFrame } from '../types';
import { BUCKETS, fitLongSide, laplacianVariance, personBox, toGray, type Bucket } from './scanBuckets';
import { GuidedScan, type GuideOptions, type ScanView, type Slot } from './scanGuide';

/**
 * Live guided scan (see scanGuide.ts for the stages): the front photo after a 3-2-1, then a 360 turn that snaps the
 * sides when they come round. Candidate frames get a sharpness score from a small grayscale crop of the person; the
 * best crop per photo slot is kept at full resolution. JPEG encoding happens once, at the end.
 */

/**
 * Anything that emits pose frames for the video, e.g. CameraSource. `image`, read inside the listener, is the exact
 * picture the frame was detected on (CameraSource detects in a worker, so the video may have moved on by then).
 */
export type PoseStream = { onFrame(cb: (frame: PoseFrame) => void): () => void; readonly image?: CanvasImageSource };

export type ScanUpdate = {
  view: ScanView;
  /** The photo whose keeper just changed, if any. */
  changed: Bucket | null;
  /** Current keeper crop per photo (live canvases, don't hold on to them past the scan). */
  crops: Record<Bucket, HTMLCanvasElement | null>;
  /** Small JPEG data URLs of the photos taken so far (the front from its shutter on), for the UI. */
  thumbs: Partial<Record<Bucket, string>>;
};

export type ScanResult = {
  /** JPEG data URLs, only for the photos the scan got. */
  frames: Partial<Record<Bucket, string>>;
  view: ScanView;
};

export type ScanCaptureOptions = Partial<GuideOptions> & {
  /** Long side of the saved crops. */
  maxSide?: number;
  jpegQuality?: number;
  /** Long side of the grayscale crop the sharpness score runs on. */
  sharpSide?: number;
  /** Long side of the UI thumbnails. */
  thumbSide?: number;
  signal?: AbortSignal;
  /** Aborted = "Done: forge with the front photo" (takes effect once the front photo is in). */
  skip?: AbortSignal;
};

/** Runs one scan. Resolves when the guide finishes (always, within a bounded time), with whatever photos it got. */
export function scanPoses(
  video: HTMLVideoElement,
  poses: PoseStream,
  onUpdate?: (update: ScanUpdate) => void,
  options: ScanCaptureOptions = {},
): Promise<ScanResult> {
  const { maxSide = 1024, jpegQuality = 0.9, sharpSide = 256, thumbSide = 220, signal, skip, ...guideOpts } = options;
  const guide = new GuidedScan(guideOpts);
  const slots: Partial<Record<Slot, HTMLCanvasElement>> = {};
  const probe = document.createElement('canvas');
  const probeCtx = probe.getContext('2d', { willReadFrequently: true })!;
  const thumbs: Partial<Record<Bucket, string>> = {};
  const thumbDirty = new Set<Bucket>();
  let thumbAt = 0;
  const start = performance.now();
  let lastFrameAt = start;
  let lastSent = '';
  let lastFlash = 0;

  /** The canvas currently holding each photo (the front only once its shutter has gone, else the best so far). */
  const crops = (): Record<Bucket, HTMLCanvasElement | null> => ({
    front: (guide.front ? slots[guide.front] : slots.front ?? slots.spare) ?? null,
    left: slots.left ?? null,
    right: slots.right ?? null,
  });

  return new Promise((resolve, reject) => {
    let finished = false;
    const emit = (changed: Bucket | null, now: number) => {
      if (skip?.aborted && guide.canSkip) guide.skip(now - start);
      const view = guide.view;
      // Thumbnails: on a shutter right away, otherwise at most a few times a second.
      const flashed = view.flash !== lastFlash;
      lastFlash = view.flash;
      if (thumbDirty.size && (flashed || now - thumbAt > 400)) {
        const current = crops();
        for (const b of thumbDirty) {
          const c = current[b];
          if (c && (b !== 'front' || guide.front)) thumbs[b] = thumbnail(c, thumbSide);
        }
        if (guide.front) thumbDirty.clear();
        else thumbDirty.forEach((b) => b !== 'front' && thumbDirty.delete(b));
        thumbAt = now;
      }
      // Every frame brings a candidate, but the UI only needs to hear when something it shows has changed.
      const key = `${JSON.stringify({ ...view, elapsedMs: 0 })}|${Object.values(thumbs).join('').length}`;
      if (key !== lastSent) {
        lastSent = key;
        onUpdate?.({ view, changed, crops: crops(), thumbs: { ...thumbs } });
      }
      if (view.done) finish();
    };

    const onFrame = (frame: PoseFrame) => {
      if (finished) return;
      const now = performance.now();
      lastFrameAt = now;
      const vw = video.videoWidth, vh = video.videoHeight;
      const picture = poses.image ?? video;
      const offers = vw && vh ? guide.offer(frame, now - start) : (guide.tick(now - start), []);
      const box = offers.length ? personBox(frame, vw, vh) : null;
      let changed: Bucket | null = null;
      if (box) {
        const s = fitLongSide(box.w, box.h, sharpSide);
        probe.width = s.w;
        probe.height = s.h;
        probeCtx.drawImage(picture, box.x, box.y, box.w, box.h, 0, 0, s.w, s.h);
        const sharp = laplacianVariance(toGray(probeCtx.getImageData(0, 0, s.w, s.h).data, s.w, s.h), s.w, s.h);
        for (const offer of offers) {
          if (!guide.submit(offer, sharp)) continue;
          const size = fitLongSide(box.w, box.h, maxSide);
          const keep = (slots[offer.slot] ??= document.createElement('canvas'));
          keep.width = size.w;
          keep.height = size.h;
          keep.getContext('2d')!.drawImage(picture, box.x, box.y, box.w, box.h, 0, 0, size.w, size.h);
          const bucket: Bucket = offer.slot === 'spare' ? 'front' : offer.slot;
          thumbDirty.add(bucket);
          changed = bucket;
        }
      }
      emit(changed, now);
    };

    if (signal?.aborted) return reject(signal.reason);
    const unsubscribe = poses.onFrame(onFrame);
    // Frames stop entirely when nobody is tracked, so a timer keeps the countdown and the ring moving.
    const timer = setInterval(() => {
      const now = performance.now();
      if (now - lastFrameAt > 120) {
        guide.tick(now - start);
        emit(null, now);
      }
    }, 100);
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException('Scan aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    emit(null, start);

    function cleanup() {
      finished = true;
      clearInterval(timer);
      unsubscribe();
      signal?.removeEventListener('abort', abort);
    }

    function finish() {
      if (finished) return;
      cleanup();
      const frames: Partial<Record<Bucket, string>> = {};
      const current = crops();
      for (const b of BUCKETS) {
        const c = b === 'front' && !guide.front ? null : current[b];
        if (c) frames[b] = c.toDataURL('image/jpeg', jpegQuality);
      }
      resolve({ frames, view: guide.view });
    }
  });
}

function thumbnail(source: HTMLCanvasElement, side: number): string {
  const size = fitLongSide(source.width, source.height, side);
  const c = document.createElement('canvas');
  c.width = size.w;
  c.height = size.h;
  c.getContext('2d')!.drawImage(source, 0, 0, size.w, size.h);
  return c.toDataURL('image/jpeg', 0.8);
}
