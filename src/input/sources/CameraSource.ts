import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame } from '../../types';
import type { InputSource } from '../InputSource';

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm';
/** `full` is more accurate at a modest cost; phones get `lite` to keep the frame rate up. `?pose=lite|full` overrides. */
const POSE_PARAM = new URLSearchParams(window.location.search).get('pose');
const PHONE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse) and (max-width: 900px)').matches;
const POSE_VARIANT = POSE_PARAM === 'lite' || POSE_PARAM === 'full' ? POSE_PARAM : PHONE ? 'lite' : 'full';
const modelUrl = (variant: 'lite' | 'full') =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${variant}/float16/1/pose_landmarker_${variant}.task`;
const POSE_MODEL = modelUrl(POSE_VARIANT);
/** Over this many ms per detection the full model can't keep up with a 30 fps camera: drop to lite (unless ?pose=). */
const SLOW_DETECT_MS = 38;

/** Webcam -> MediaPipe PoseLandmarker -> timestamped image and world landmarks. */
export class CameraSource implements InputSource {
  readonly kind = 'camera';
  readonly video = document.createElement('video');
  private readonly listeners = new Set<(frame: PoseFrame) => void>();
  private stream: MediaStream | null = null;
  private landmarker: PoseLandmarker | null = null;
  /** For swapping to the lite model when this machine is too slow for full (see SLOW_DETECT_MS). */
  private files: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private delegate: 'GPU' | 'CPU' = 'GPU';
  private variant: 'lite' | 'full' = POSE_VARIANT;
  private timedFrames = 0;
  private swapping = false;
  private frameRequest = 0;
  private running = false;
  private _latestFrame: PoseFrame | null = null;
  private _tracking = false;

  get latestFrame() {
    return this._latestFrame;
  }

  /** Diagnostics for the tuner: what the camera actually delivers and how long MediaPipe takes. */
  readonly stats = { width: 0, height: 0, fps: 0, detectMs: 0, timestamps: 'none' as 'capture' | 'callback' | 'none' };

  /** The camera's real settings (it may not grant the 60 fps we ask for). */
  get settings(): MediaTrackSettings | null {
    return this.stream?.getVideoTracks()[0]?.getSettings() ?? null;
  }

  /**
   * Short exposure (~1/250 s) cuts motion blur on fast punches, if the camera allows manual exposure
   * (many Windows/Linux webcams do; MacBook cameras usually don't). Needs a bright room.
   * Returns false if unsupported.
   */
  async setShortExposure(on: boolean): Promise<boolean> {
    const track = this.stream?.getVideoTracks()[0];
    const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { exposureMode?: string[]; exposureTime?: { min: number; max: number } };
    if (!track || !caps.exposureMode?.includes('manual') || !caps.exposureTime) return false;
    try {
      if (!on) {
        await track.applyConstraints({ advanced: [{ exposureMode: 'continuous' } as MediaTrackConstraintSet] });
        return true;
      }
      // Two steps: exposureTime is ignored until manual mode is on. Units are 100 µs, so 40 = 1/250 s.
      await track.applyConstraints({ advanced: [{ exposureMode: 'manual' } as MediaTrackConstraintSet] });
      const time = Math.min(Math.max(40, caps.exposureTime.min), caps.exposureTime.max);
      await track.applyConstraints({ advanced: [{ exposureTime: time } as MediaTrackConstraintSet] });
      return true;
    } catch {
      return false;
    }
  }

  get tracking() {
    return this._tracking;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable. Use localhost or HTTPS.');

    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
    try {
      this.stream = await navigator.mediaDevices
        .getUserMedia({
          audio: false,
          // 60 fps if the camera can: a punch lasts only ~4–6 frames at 30.
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 }, facingMode: 'user' },
        })
        .catch((err: unknown) => {
          throw new Error(cameraErrorText(err));
        });
      this.video.srcObject = this.stream;
      await this.video.play();

      const files = await FilesetResolver.forVisionTasks(WASM_ROOT);
      const options = {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' as const },
        runningMode: 'VIDEO' as const,
        // 2 on purpose: with numPoses 1, MediaPipe adds its own hidden smoothing (more lag on top of ours).
        // With 2 it re-runs person detection each frame (a few ms) but stays unsmoothed. `?poses=1` to compare.
        numPoses: new URLSearchParams(window.location.search).get('poses') === '1' ? 1 : 2,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      };
      this.files = files;
      try {
        this.landmarker = await PoseLandmarker.createFromOptions(files, options);
      } catch {
        this.delegate = 'CPU';
        // Some browsers expose WebGL but cannot initialize MediaPipe's GPU delegate.
        this.landmarker = await PoseLandmarker.createFromOptions(files, {
          ...options,
          baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'CPU' },
        });
      }
      this.running = true;
      this.schedule();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    this.running = false;
    if (this.frameRequest && 'cancelVideoFrameCallback' in this.video) this.video.cancelVideoFrameCallback(this.frameRequest);
    else cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this._latestFrame = null;
    this._tracking = false;
  }

  onFrame(cb: (frame: PoseFrame) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Run once per new camera frame. requestVideoFrameCallback fires exactly once per frame, so the same
   * image is never processed twice (requestAnimationFrame runs at the display rate, usually faster than
   * the camera, which duplicates frames and makes speeds jumpy).
   */
  private schedule() {
    if (!this.running) return;
    if ('requestVideoFrameCallback' in this.video) {
      this.frameRequest = this.video.requestVideoFrameCallback((now, meta) => {
        this.stats.timestamps = meta.captureTime === undefined ? 'callback' : 'capture';
        this.detectFrame(meta.captureTime ?? now);
      });
    } else {
      this.frameRequest = requestAnimationFrame(this.detectFrame);
    }
  }

  private lastTimestamp = 0;
  private lastErrorAt = -Infinity;

  private detectFrame = (time: number) => {
    if (!this.running || !this.landmarker) return;
    // MediaPipe needs strictly increasing timestamps.
    const now = Math.max(time, this.lastTimestamp + 1);
    this.lastTimestamp = now;
    // Always reschedule: one throw here (a GPU hiccup, a listener failing mid-send) must not stop tracking for good.
    try {
      if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) this.detect(now);
    } catch (error) {
      this.reportError(error);
    }
    this.schedule();
  };

  private detect(now: number) {
    const started = performance.now();
    const result = this.landmarker!.detectForVideo(this.video, now);
    const took = performance.now() - started;
    this.stats.detectMs += 0.1 * (took - this.stats.detectMs);
    // After a warm-up, a laptop that can't run the full model at camera rate gets the lite one: a punch is only a
    // few frames long, and frames matter more than the full model's extra accuracy.
    if (++this.timedFrames === 90 && this.variant === 'full' && !POSE_PARAM && this.stats.detectMs > SLOW_DETECT_MS) {
      void this.useLite();
    }
    const settings = this.settings;
    this.stats.width = this.video.videoWidth;
    this.stats.height = this.video.videoHeight;
    this.stats.fps = settings?.frameRate ?? 0;
    const selected = selectCenteredPose(result.landmarks);
    const image = selected < 0 ? undefined : result.landmarks[selected];
    const world = selected < 0 ? undefined : result.worldLandmarks[selected];
    if (!image || !world) {
      this._latestFrame = null;
      this._tracking = false;
      return;
    }
    const frame: PoseFrame = {
      t: now,
      image: image.map(toLandmark),
      world: world.map(toLandmark),
      aspect: this.video.videoWidth / this.video.videoHeight,
    };
    this._latestFrame = frame;
    this._tracking = true;
    for (const listener of this.listeners) {
      try {
        listener(frame);
      } catch (error) {
        this.reportError(error); // the other listeners still get the frame
      }
    }
  }

  private async useLite() {
    if (this.swapping || !this.files) return;
    this.swapping = true;
    console.warn(`[camera] pose model full takes ${this.stats.detectMs.toFixed(0)} ms per frame here; switching to lite`);
    try {
      const lite = await PoseLandmarker.createFromOptions(this.files, {
        baseOptions: { modelAssetPath: modelUrl('lite'), delegate: this.delegate },
        runningMode: 'VIDEO',
        numPoses: new URLSearchParams(window.location.search).get('poses') === '1' ? 1 : 2,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      if (!this.running) return lite.close();
      const old = this.landmarker;
      this.landmarker = lite;
      this.variant = 'lite';
      old?.close();
    } catch (err) {
      console.warn('[camera] lite model failed to load, staying on full', err);
    } finally {
      this.swapping = false;
    }
  }

  /** Logged at most every few seconds: a persistent failure would otherwise flood the console at camera rate. */
  private reportError(error: unknown) {
    const t = performance.now();
    if (t - this.lastErrorAt < 5000) return;
    this.lastErrorAt = t;
    console.error('[camera] pose frame failed', error);
  }
}

function toLandmark(point: NormalizedLandmark): Landmark {
  return { x: point.x, y: point.y, z: point.z, visibility: point.visibility ?? 0 };
}

/** With numPoses 2 (bystanders around), pick the person nearest the center. */
function selectCenteredPose(poses: NormalizedLandmark[][]): number {
  let selected = -1;
  let nearest = Infinity;
  poses.forEach((pose, index) => {
    const left = pose[23];
    const right = pose[24];
    if (!left || !right) return;
    const x = (left.x + right.x) / 2;
    const y = (left.y + right.y) / 2;
    const distance = (x - 0.5) ** 2 + (y - 0.5) ** 2;
    if (distance < nearest) {
      selected = index;
      nearest = distance;
    }
  });
  return selected;
}

/** getUserMedia failures in words a player can act on. */
function cameraErrorText(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera is blocked. Click the camera icon in the address bar, allow it, and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found. Plug one in (or check it is not disabled) and try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy in another app (Zoom, Teams, another tab?). Close it and try again.';
    default:
      return `Camera didn't start (${err instanceof Error ? err.message : String(err)}). Try again, or reload the page.`;
  }
}
