import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame } from '../../types';
import type { InputSource } from '../InputSource';
import {
  WASM_ROOT, landmarkerOptions, modelUrl, selectCenteredPose, toLandmark,
  type PoseDelegate, type PoseVariant, type PoseWorkerReply, type PoseWorkerRequest,
} from './poseModel';

const PARAMS = new URLSearchParams(window.location.search);
/** `full` is more accurate at a modest cost; phones get `lite` to keep the frame rate up. `?pose=lite|full` overrides. */
const POSE_PARAM = PARAMS.get('pose');
const PHONE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse) and (max-width: 900px)').matches;
const POSE_VARIANT: PoseVariant = POSE_PARAM === 'lite' || POSE_PARAM === 'full' ? POSE_PARAM : PHONE ? 'lite' : 'full';
const NUM_POSES = PARAMS.get('poses') === '1' ? 1 : 2;
/** `?posedelegate=cpu` runs the model on the CPU (XNNPACK) instead of the GPU, e.g. when the GPU is the bottleneck. */
const DELEGATE: PoseDelegate = PARAMS.get('posedelegate')?.toLowerCase() === 'cpu' ? 'CPU' : 'GPU';
/** Detection runs in a worker where the browser can (`?poseworker=0` keeps it on the main thread, as before). */
const WORKER_OK = PARAMS.get('poseworker') !== '0';
/** Over this many ms per detection the full model can't keep up with a 30 fps camera: drop to lite (unless ?pose=). */
const SLOW_DETECT_MS = 38;
/** Same test as start(): the model runs in the worker (MediaPipe's module build) where the browser can. */
const useWorker = () => WORKER_OK && typeof Worker === 'function' && typeof VideoFrame === 'function' && typeof OffscreenCanvas === 'function';

let preloaded = false;
/**
 * Warm the browser's cache with what the camera will load (MediaPipe's wasm, ~3.6 MB compressed, and the pose model,
 * 9.4 MB): the game calls this at the title screen, so "Fight as" doesn't then wait ~10 s for them on venue Wi-Fi.
 * Low priority, so nothing on screen waits for it. The page or the pose worker then gets them from the cache
 * (jsDelivr's files are immutable, the model is cached for an hour). Safe to call more than once.
 */
export function preloadPose() {
  if (preloaded) return;
  preloaded = true;
  const wasm = `${WASM_ROOT}/vision_wasm${useWorker() ? '_module' : ''}_internal`;
  for (const url of [modelUrl(POSE_VARIANT), `${wasm}.js`, `${wasm}.wasm`]) {
    void fetch(url, { priority: 'low' })
      .then((res) => res.arrayBuffer())
      .catch(() => {});
  }
}

/**
 * Webcam -> MediaPipe PoseLandmarker -> timestamped image and world landmarks.
 *
 * The model runs in a worker (poseWorker.ts): each new camera frame goes over as a VideoFrame, the landmarks come
 * back a detection later, stamped with the frame's capture time. Only the newest frame waits while one is being
 * detected, so nothing queues up and adds lag. Browsers without VideoFrame / OffscreenCanvas run it in the page.
 */
export class CameraSource implements InputSource {
  readonly kind = 'camera';
  readonly video = document.createElement('video');
  private readonly listeners = new Set<(frame: PoseFrame) => void>();
  private stream: MediaStream | null = null;
  /** In-page model (no worker). */
  private landmarker: PoseLandmarker | null = null;
  /** For swapping to the lite model when this machine is too slow for full (see SLOW_DETECT_MS). */
  private files: unknown = null;
  private delegate: PoseDelegate = DELEGATE;
  private variant: PoseVariant = POSE_VARIANT;
  private timedFrames = 0;
  private swapping = false;
  private frameRequest = 0;
  private running = false;
  private _latestFrame: PoseFrame | null = null;
  private _tracking = false;
  /** Worker mode: the worker, whether a frame is being detected, and the newest frame waiting for it. */
  private worker: Worker | null = null;
  private inFlight = false;
  private pending: { image: VideoFrame; t: number } | null = null;
  private nextId = 0;
  /** Copies of the frames being detected, so listeners can see the exact image a pose came from. */
  private readonly kept = new Map<number, VideoFrame>();
  private delivering: CanvasImageSource | null = null;

  get latestFrame() {
    return this._latestFrame;
  }

  /**
   * The camera image the frame being delivered right now was detected on (valid inside an onFrame listener). In
   * worker mode the video has usually moved on by the time the landmarks arrive; this is the matching picture.
   */
  get image(): CanvasImageSource {
    return this.delivering ?? this.video;
  }

  /** Diagnostics for the tuner: what the camera actually delivers and how long MediaPipe takes. */
  readonly stats = {
    width: 0, height: 0, fps: 0, detectMs: 0, timestamps: 'none' as 'capture' | 'callback' | 'none',
    /** Where the model runs: 'worker' or 'page', and on what. */
    runner: 'page' as 'worker' | 'page', delegate: DELEGATE as PoseDelegate,
    /** Measured over the last two seconds: detections finished, and frames the camera delivered. */
    detectFps: 0, cameraFps: 0,
  };
  private rateStart = 0;
  private cameraFrames = 0;
  private detections = 0;

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
    // Downloads run while the permission prompt is up (no-op if the title screen already started them).
    preloadPose();
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

      if (useWorker()) {
        try {
          await this.startWorker();
        } catch (err) {
          console.warn('[camera] pose worker unavailable, detecting on the main thread', err);
        }
      }
      if (!this.worker) await this.startInPage();
      this.running = true;
      this.schedule();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    this.running = false;
    this.stats.detectFps = this.stats.cameraFps = 0;
    this.rateStart = 0;
    if (this.frameRequest && 'cancelVideoFrameCallback' in this.video) this.video.cancelVideoFrameCallback(this.frameRequest);
    else cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    this.worker?.terminate();
    this.worker = null;
    this.inFlight = false;
    this.pending?.image.close();
    this.pending = null;
    for (const image of this.kept.values()) image.close();
    this.kept.clear();
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

  private async startWorker() {
    const worker = new Worker(new URL('./poseWorker.ts', import.meta.url), { type: 'module' });
    try {
      this.delegate = await new Promise<PoseDelegate>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<PoseWorkerReply>) => {
          if (e.data.type === 'ready') resolve(e.data.delegate);
          else if (e.data.type === 'failed') reject(new Error(e.data.error));
        };
        worker.onerror = (e) => reject(new Error(e.message || 'pose worker failed to load'));
        this.post(worker, { type: 'init', variant: this.variant, delegate: this.delegate, numPoses: NUM_POSES });
      });
    } catch (err) {
      worker.terminate();
      throw err;
    }
    worker.onmessage = (e: MessageEvent<PoseWorkerReply>) => this.onWorkerMessage(e.data);
    worker.onerror = (e) => this.reportError(e.message);
    this.worker = worker;
    this.stats.runner = 'worker';
    this.stats.delegate = this.delegate;
  }

  private async startInPage() {
    const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
    const files = await FilesetResolver.forVisionTasks(WASM_ROOT);
    this.files = files;
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(files, landmarkerOptions(this.variant, this.delegate, NUM_POSES));
    } catch {
      this.delegate = 'CPU';
      // Some browsers expose WebGL but cannot initialize MediaPipe's GPU delegate.
      this.landmarker = await PoseLandmarker.createFromOptions(files, landmarkerOptions(this.variant, this.delegate, NUM_POSES));
    }
    this.stats.runner = 'page';
    this.stats.delegate = this.delegate;
  }

  private post(worker: Worker, msg: PoseWorkerRequest, transfer: Transferable[] = []) {
    worker.postMessage(msg, transfer);
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
    if (!this.running || !(this.landmarker || this.worker)) return;
    this.cameraFrames++;
    this.updateRates();
    // MediaPipe needs strictly increasing timestamps.
    const now = Math.max(time, this.lastTimestamp + 1);
    this.lastTimestamp = now;
    // Always reschedule: one throw here (a GPU hiccup, a listener failing mid-send) must not stop tracking for good.
    try {
      if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        if (this.worker) this.sendFrame(now);
        else this.detect(now);
      }
    } catch (error) {
      this.reportError(error);
    }
    this.schedule();
  };

  /** Worker mode: hand the frame over, or keep it as the next one if a detection is still running. */
  private sendFrame(now: number) {
    const image = new VideoFrame(this.video, { timestamp: Math.round(now * 1000) });
    if (this.inFlight) {
      this.pending?.image.close();
      this.pending = { image, t: now };
      return;
    }
    this.dispatch(image, now);
  }

  private dispatch(image: VideoFrame, t: number) {
    const id = ++this.nextId;
    this.kept.set(id, image.clone());
    this.inFlight = true;
    this.post(this.worker!, { type: 'frame', id, t, image }, [image]);
  }

  private onWorkerMessage(msg: PoseWorkerReply) {
    if (msg.type === 'variant') {
      this.swapping = false;
      if (msg.ok) this.variant = msg.variant;
      else console.warn('[camera] lite model failed to load, staying on full', msg.error);
      return;
    }
    if (msg.type !== 'result' && msg.type !== 'error') return;
    this.inFlight = false;
    const image = this.kept.get(msg.id) ?? null;
    this.kept.delete(msg.id);
    try {
      if (!this.running) return;
      if (msg.type === 'error') this.reportError(msg.error);
      else {
        this.timeDetection(msg.ms);
        this.deliver(msg.t, msg.image, msg.world, image);
      }
    } finally {
      image?.close();
      if (this.pending && this.running && this.worker) {
        const next = this.pending;
        this.pending = null;
        this.dispatch(next.image, next.t);
      }
    }
  }

  private detect(now: number) {
    const started = performance.now();
    const result = this.landmarker!.detectForVideo(this.video, now);
    this.timeDetection(performance.now() - started);
    const selected = selectCenteredPose(result.landmarks);
    const image = selected < 0 ? undefined : result.landmarks[selected];
    const world = selected < 0 ? undefined : result.worldLandmarks[selected];
    this.deliver(now, image?.map(toLandmark) ?? null, world?.map(toLandmark) ?? null, null);
  }

  /** Rates over two seconds (one second of a 24 fps camera counts 20 to 25: too noisy to act on). */
  private updateRates() {
    const now = performance.now();
    if (!this.rateStart) this.rateStart = now;
    const span = now - this.rateStart;
    if (span < 2000) return;
    this.stats.cameraFps = (this.cameraFrames * 1000) / span;
    this.stats.detectFps = (this.detections * 1000) / span;
    this.rateStart = now;
    this.cameraFrames = this.detections = 0;
  }

  private timeDetection(took: number) {
    this.detections++;
    this.stats.detectMs += 0.1 * (took - this.stats.detectMs);
    // After a warm-up, a laptop that can't run the full model at camera rate gets the lite one: a punch is only a
    // few frames long, and frames matter more than the full model's extra accuracy.
    if (++this.timedFrames === 90 && this.variant === 'full' && !POSE_PARAM && this.stats.detectMs > SLOW_DETECT_MS) {
      void this.useLite();
    }
  }

  /** A detection's landmarks -> a PoseFrame for the listeners. `picture`: the exact image it ran on (worker mode). */
  private deliver(t: number, image: Landmark[] | null, world: Landmark[] | null, picture: CanvasImageSource | null) {
    const settings = this.settings;
    this.stats.width = this.video.videoWidth;
    this.stats.height = this.video.videoHeight;
    this.stats.fps = settings?.frameRate ?? 0;
    if (!image || !world) {
      this._latestFrame = null;
      this._tracking = false;
      return;
    }
    const frame: PoseFrame = { t, image, world, aspect: this.video.videoWidth / this.video.videoHeight };
    this._latestFrame = frame;
    this._tracking = true;
    this.delivering = picture;
    try {
      for (const listener of this.listeners) {
        try {
          listener(frame);
        } catch (error) {
          this.reportError(error); // the other listeners still get the frame
        }
      }
    } finally {
      this.delivering = null;
    }
  }

  private async useLite() {
    if (this.swapping) return;
    this.swapping = true;
    console.warn(`[camera] pose model full takes ${this.stats.detectMs.toFixed(0)} ms per frame here; switching to lite`);
    if (this.worker) {
      this.post(this.worker, { type: 'variant', variant: 'lite' });
      return; // the worker answers with 'variant'
    }
    if (!this.files) return void (this.swapping = false);
    try {
      const { PoseLandmarker } = await import('@mediapipe/tasks-vision');
      const lite = await PoseLandmarker.createFromOptions(this.files as never, landmarkerOptions('lite', this.delegate, NUM_POSES));
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
