import type { PoseFrame } from '../types';
import {
  BUCKETS, ScanBuckets, fitLongSide, laplacianVariance, personBox, toGray,
  type Bucket, type ScanOptions, type ScanProgress,
} from './scanBuckets';

/**
 * Live 360° scan: the player turns slowly in front of the camera while pose frames come in. Each tracked
 * frame is bucketed by facing (front / left / right, see scanBuckets.ts); candidates get a sharpness score
 * from a small grayscale crop of the person, and the sharpest crop per bucket is kept at full resolution.
 * JPEG encoding happens once, at the end.
 */

/**
 * Anything that emits pose frames for the video, e.g. CameraSource. `image`, read inside the listener, is the exact
 * picture the frame was detected on (CameraSource detects in a worker, so the video may have moved on by then).
 */
export type PoseStream = { onFrame(cb: (frame: PoseFrame) => void): () => void; readonly image?: CanvasImageSource };

export type ScanUpdate = ScanProgress & {
  /** The bucket whose keeper just changed, if any. */
  changed: Bucket | null;
  /** Current keeper crop per bucket (live canvases, don't hold on to them past the scan). */
  crops: Record<Bucket, HTMLCanvasElement | null>;
};

export type ScanResult = {
  /** JPEG data URLs, only for buckets that got a frame. */
  frames: Partial<Record<Bucket, string>>;
  progress: ScanProgress;
};

export type ScanCaptureOptions = Partial<ScanOptions> & {
  /** Long side of the saved crops. */
  maxSide?: number;
  jpegQuality?: number;
  /** Long side of the grayscale crop the sharpness score runs on. */
  sharpSide?: number;
  signal?: AbortSignal;
};

/** Runs one scan. Resolves when every bucket has a good frame, or at the timeout with whatever it has. */
export function scanPoses(
  video: HTMLVideoElement,
  poses: PoseStream,
  onUpdate?: (update: ScanUpdate) => void,
  options: ScanCaptureOptions = {},
): Promise<ScanResult> {
  const { maxSide = 1024, jpegQuality = 0.9, sharpSide = 256, signal, ...scanOpts } = options;
  const buckets = new ScanBuckets(scanOpts);
  const crops: Record<Bucket, HTMLCanvasElement | null> = { front: null, left: null, right: null };
  const probe = document.createElement('canvas');
  const probeCtx = probe.getContext('2d', { willReadFrequently: true })!;
  const start = performance.now();
  let lastFrameAt = start;

  return new Promise((resolve, reject) => {
    let finished = false;
    const emit = (changed: Bucket | null) => {
      const progress = buckets.progress;
      onUpdate?.({ ...progress, changed, crops });
      if (progress.done) finish();
    };

    const onFrame = (frame: PoseFrame) => {
      if (finished) return;
      const now = performance.now();
      lastFrameAt = now;
      const vw = video.videoWidth, vh = video.videoHeight;
      const picture = poses.image ?? video;
      const offer = vw && vh ? buckets.offer(frame, now - start) : null;
      const box = offer && personBox(frame, vw, vh);
      let changed: Bucket | null = null;
      if (offer && box) {
        const s = fitLongSide(box.w, box.h, sharpSide);
        probe.width = s.w;
        probe.height = s.h;
        probeCtx.drawImage(picture, box.x, box.y, box.w, box.h, 0, 0, s.w, s.h);
        const sharp = laplacianVariance(toGray(probeCtx.getImageData(0, 0, s.w, s.h).data, s.w, s.h), s.w, s.h);
        if (buckets.submit(offer, sharp)) {
          const size = fitLongSide(box.w, box.h, maxSide);
          const keep = (crops[offer.bucket] ??= document.createElement('canvas'));
          keep.width = size.w;
          keep.height = size.h;
          keep.getContext('2d')!.drawImage(picture, box.x, box.y, box.w, box.h, 0, 0, size.w, size.h);
          changed = offer.bucket;
        }
      }
      emit(changed);
    };

    if (signal?.aborted) return reject(signal.reason);
    const unsubscribe = poses.onFrame(onFrame);
    // Frames stop entirely when nobody is tracked, so a timer keeps the clock (and the hint) moving.
    const timer = setInterval(() => {
      const now = performance.now();
      if (now - lastFrameAt > 400) {
        buckets.idle(now - start);
        emit(null);
      }
    }, 250);
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException('Scan aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });

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
      for (const b of BUCKETS) {
        const c = crops[b];
        if (c) frames[b] = c.toDataURL('image/jpeg', jpegQuality);
      }
      resolve({ frames, progress: buckets.progress });
    }
  });
}
