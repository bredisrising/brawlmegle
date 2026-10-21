import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame, TrackerInfo } from '../../types';
import type { InputSource } from '../InputSource';
import { PoseHealth, type PoseWarning } from '../poseHealth';
import {
  WASM_ROOT, landmarkerOptions, modelUrl, toLandmark,
  type PoseDelegate, type PoseVariant, type PoseWorkerReply, type PoseWorkerRequest,
} from './poseModel';
import { PersonPicker } from './personPicker';
import { ShortExposure, exposureCaps, medianLuma } from '../exposure';

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
/** `?exposure=0` leaves the camera's exposure to the camera (see setShortExposure). */
const EXPOSURE_OK = PARAMS.get('exposure') !== '0';
/**
 * Lite only pays off on the CPU delegate: on a GPU the time goes to the person detector, so lite measured no faster
 * (25.8 vs 29.5 ms on an RTX 4070, slower on a Radeon 780M) and only gave up accuracy. Full on a laptop's CPU managed 9
 * poses a second: under this many, a CPU-delegate tracker drops to lite (unless ?pose=).
 */
const LITE_BELOW_FPS = 20;
/** Same test as start(): the model runs in the worker (MediaPipe's module build) where the browser can. */
const useWorker = () => WORKER_OK && typeof Worker === 'function' && typeof VideoFrame === 'function' && typeof OffscreenCanvas === 'function';

let preloaded = false;
/** The pose model file, downloaded once by preloadPose() and handed to MediaPipe (null if that download failed). */
let modelBytes: Promise<ArrayBuffer | null> | null = null;
/**
 * Warm the browser's cache with what the camera will load (MediaPipe's wasm, ~3.6 MB compressed, and the pose model,
 * 9.4 MB): the game calls this at the title screen, so "Fight as" doesn't then wait ~10 s for them on venue Wi-Fi.
 * Low priority, so nothing on screen waits for it. The wasm then comes from the cache (jsDelivr's files are
 * immutable); the model's bytes are kept and handed to MediaPipe, since the browser doesn't always keep them (an
 * incognito window downloaded all 9.4 MB again in the worker). Safe to call more than once.
 */
export function preloadPose() {
  if (preloaded) return;
  preloaded = true;
  modelBytes = fetch(modelUrl(POSE_VARIANT), { priority: 'low' })
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .catch(() => null);
  const wasm = `${WASM_ROOT}/vision_wasm${useWorker() ? '_module' : ''}_internal`;
  for (const url of [`${wasm}.js`, `${wasm}.wasm`]) {
    void fetch(url, { priority: 'low' })
      .then((res) => res.arrayBuffer())
      .catch(() => {});
  }
}

/** The preloaded model file for `variant`, if that's the one preloaded and it arrived. */
async function preloadedModel(variant: PoseVariant): Promise<ArrayBuffer | null> {
  return variant === POSE_VARIANT && modelBytes ? modelBytes : null;
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
  /** In-page model (no worker), and which of the people it finds is the player (the worker has its own). */
  private landmarker: PoseLandmarker | null = null;
  private readonly picker = new PersonPicker();
  /** For swapping to the lite model when the CPU runs the model too slowly for full (see LITE_BELOW_FPS). */
  private files: unknown = null;
  private delegate: PoseDelegate = DELEGATE;
  private variant: PoseVariant = POSE_VARIANT;
  private timedFrames = 0;
  private swapping = false;
  private liteTried = false;
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
  /** Short exposure (setShortExposure): wanted or not, the live camera's, and the tiny canvas it measures light on. */
  private exposureWanted = false;
  private exposure: ShortExposure | null = null;
  private lumaCanvas: HTMLCanvasElement | null = null;

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

  /** What the camera actually delivers and how long MediaPipe takes: the tuner shows them, the game warns on them. */
  readonly stats = {
    width: 0, height: 0, fps: 0, detectMs: 0, timestamps: 'none' as 'capture' | 'callback' | 'none',
    /** Where the model runs: 'worker' or 'page', and on what. */
    runner: 'page' as 'worker' | 'page', delegate: DELEGATE as PoseDelegate,
    /** Measured over the last two seconds: detections finished, and frames the camera delivered. */
    detectFps: 0, cameraFps: 0,
    /** The rates above cover time with the model running (false until a window has passed since its first result). */
    rated: false,
    /** One-pose mode is on (see setSinglePose). */
    singlePose: false,
    /** Tracking slow enough to tell the player (on screen next to their camera), or null. */
    warning: null as PoseWarning | null,
  };
  private health = new PoseHealth();
  private rateStart = 0;
  private cameraFrames = 0;
  private detections = 0;

  /** The camera's real settings (it may not grant the 60 fps we ask for). */
  get settings(): MediaTrackSettings | null {
    return this.stream?.getVideoTracks()[0]?.getSettings() ?? null;
  }

  /** What this camera tracks with right now, for the match recording. */
  info(): TrackerInfo {
    const s = this.stats;
    const round = (v: number) => Math.round(v * 10) / 10;
    return {
      model: this.variant, delegate: this.delegate, runner: s.runner, onePose: s.singlePose,
      detectMs: round(s.detectMs), posesPerSec: round(s.detectFps), cameraFps: round(s.cameraFps),
      width: this.video.videoWidth, height: this.video.videoHeight, frameRate: round(this.settings?.frameRate ?? 0),
      exposure: this.exposure?.state ?? (this.exposureWanted && this.stream ? 'unsupported' : 'off'),
      exposureTime: this.exposure?.time ?? null,
      userAgent: navigator.userAgent,
    };
  }

  /**
   * Short exposure: less motion blur on fast punches, where the camera lets the page set its exposure (many Windows
   * and Linux webcams; not MacBooks). As short as the room's light allows (exposure.ts), and the camera gets its own
   * exposure back whenever the tab hides or closes, the camera stops, or anything fails. Asked for before the camera
   * starts, it starts with it. Resolves false if this camera doesn't allow it (or with `?exposure=0`).
   */
  async setShortExposure(on: boolean): Promise<boolean> {
    this.exposureWanted = on && EXPOSURE_OK;
    if (!on) {
      await this.exposure?.release();
      return true;
    }
    if (!this.stream) return EXPOSURE_OK;
    this.startExposure();
    return !!this.exposure && this.exposure.state !== 'failed';
  }

  /** Short exposure on the live camera, if it's wanted, the camera allows it and the tab is in view. */
  private startExposure() {
    const track = this.stream?.getVideoTracks()[0];
    if (!this.exposureWanted || !track) return;
    if (!this.exposure) {
      const caps = exposureCaps(track);
      if (!caps) return;
      this.exposure = new ShortExposure(track, caps, () => this.measureLuma());
    }
    if (document.visibilityState !== 'hidden') this.exposure.start();
  }

  /** A hidden tab gives the camera its own exposure back (another app may open it), a visible one takes it again. */
  private onVisibility = () => {
    if (document.visibilityState === 'hidden') void this.exposure?.release();
    else this.startExposure();
  };

  private releaseExposure = () => void this.exposure?.release();

  /** The picture's median brightness, from a 32x24 copy of the current camera frame (null before there's one). */
  private measureLuma(): number | null {
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    try {
      this.lumaCanvas ??= Object.assign(document.createElement('canvas'), { width: 32, height: 24 });
      const ctx = this.lumaCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(this.video, 0, 0, 32, 24);
      return medianLuma(ctx.getImageData(0, 0, 32, 24).data);
    } catch {
      return null;
    }
  }

  get tracking() {
    return this._tracking;
  }

  /** The pose model has run at least once (the first detections can take a few seconds while it warms up). */
  get warm() {
    return this.timedFrames > 0;
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
      document.addEventListener('visibilitychange', this.onVisibility);
      window.addEventListener('pagehide', this.releaseExposure);
      this.startExposure();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    this.running = false;
    this.stats.detectFps = this.stats.cameraFps = 0;
    this.stats.rated = false;
    this.stats.singlePose = false;
    this.stats.warning = null;
    this.health = new PoseHealth();
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
    this.picker.reset();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.releaseExposure);
    const tracks = this.stream?.getTracks() ?? [];
    const stopTracks = () => tracks.forEach((track) => track.stop());
    const exposure = this.exposure;
    this.exposure = null;
    // The camera's own exposure back before letting it go: some webcams keep a manual one into the next app.
    if (exposure?.manual) void exposure.release().finally(stopTracks);
    else {
      void exposure?.release();
      stopTracks();
    }
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this._latestFrame = null;
    this._tracking = false;
  }

  /**
   * One-pose mode (the quality governor's last step): cheaper tracking that follows the player instead of re-detecting
   * people every frame, with MediaPipe's own smoothing. Worker only; see poseWorker.ts for how it keeps to the player.
   */
  setSinglePose(on: boolean) {
    if (on === this.stats.singlePose || !this.worker) return;
    this.stats.singlePose = on;
    console.info(`[camera] one pose at a time ${on ? 'on: the pose tracker still lags the camera at the lightest render' : 'off'}`);
    this.post(this.worker, { type: 'single', on });
  }

  onFrame(cb: (frame: PoseFrame) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private async startWorker() {
    const bytes = await preloadedModel(this.variant);
    const worker = new Worker(new URL('./poseWorker.ts', import.meta.url), { type: 'module' });
    try {
      this.delegate = await new Promise<PoseDelegate>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<PoseWorkerReply>) => {
          if (e.data.type === 'ready') resolve(e.data.delegate);
          else if (e.data.type === 'failed') reject(new Error(e.data.error));
        };
        worker.onerror = (e) => reject(new Error(e.message || 'pose worker failed to load'));
        // A copy goes over (moved, not cloned again): the page keeps its own in case the camera is started again.
        const model = bytes?.slice(0);
        this.post(worker, { type: 'init', variant: this.variant, delegate: this.delegate, numPoses: NUM_POSES, model }, model ? [model] : []);
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
    const bytes = await preloadedModel(this.variant);
    const model = bytes ? new Uint8Array(bytes.slice(0)) : undefined;
    this.files = files;
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(files, landmarkerOptions(this.variant, this.delegate, NUM_POSES, model));
    } catch {
      this.delegate = 'CPU';
      // Some browsers expose WebGL but cannot initialize MediaPipe's GPU delegate.
      this.landmarker = await PoseLandmarker.createFromOptions(files, landmarkerOptions(this.variant, this.delegate, NUM_POSES, model));
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
    const selected = this.picker.pick(result.landmarks, now, this.video.videoWidth / this.video.videoHeight || 4 / 3);
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
    this.stats.rated = this.timedFrames > 0;
    this.rateStart = now;
    this.cameraFrames = this.detections = 0;
    this.stats.warning = this.health.update(this.stats);
    // The CPU can't run the full model at the camera's rate: lite, since a punch is only a few frames long and frames
    // matter more than full's extra accuracy. Decided by poses a second, not ms each (detections overlap frames).
    const { rated, detectFps, cameraFps } = this.stats;
    if (rated && this.delegate === 'CPU' && this.variant === 'full' && !POSE_PARAM && !this.liteTried && detectFps < Math.min(LITE_BELOW_FPS, cameraFps * 0.8)) {
      this.liteTried = true;
      void this.useLite();
    }
  }

  private timeDetection(took: number) {
    // The first detection starts the rate window over, so the model's loading time doesn't read as a slow tracker.
    if (this.timedFrames === 0) {
      this.rateStart = performance.now();
      this.cameraFrames = this.detections = 0;
    }
    this.timedFrames++;
    this.detections++;
    this.stats.detectMs += 0.1 * (took - this.stats.detectMs);
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
    console.warn(`[camera] pose model full runs ${this.stats.detectFps.toFixed(0)} poses/s on the CPU here; switching to lite`);
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
