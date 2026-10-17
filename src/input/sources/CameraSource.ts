import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame } from '../../types';
import type { InputSource } from '../InputSource';

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm';
/** `full` is more accurate (including depth) at a modest cost; `?pose=lite` for slow laptops. */
const POSE_VARIANT = new URLSearchParams(window.location.search).get('pose') === 'lite' ? 'lite' : 'full';
const POSE_MODEL = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${POSE_VARIANT}/float16/1/pose_landmarker_${POSE_VARIANT}.task`;

/** Webcam -> MediaPipe PoseLandmarker -> timestamped image and world landmarks. */
export class CameraSource implements InputSource {
  readonly kind = 'camera';
  readonly video = document.createElement('video');
  private readonly listeners = new Set<(frame: PoseFrame) => void>();
  private stream: MediaStream | null = null;
  private landmarker: PoseLandmarker | null = null;
  private frameRequest = 0;
  private running = false;
  private _latestFrame: PoseFrame | null = null;
  private _tracking = false;

  get latestFrame() {
    return this._latestFrame;
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
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        // 60 fps if the camera can: a punch lasts only ~4–6 frames at 30.
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 }, facingMode: 'user' },
      });
      this.video.srcObject = this.stream;
      await this.video.play();

      const files = await FilesetResolver.forVisionTasks(WASM_ROOT);
      const options = {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' as const },
        runningMode: 'VIDEO' as const,
        // One person: MediaPipe then tracks frame to frame instead of re-running its person detector every
        // frame (faster), and applies its own light smoothing. `?poses=2` if bystanders steal the tracking.
        numPoses: new URLSearchParams(window.location.search).get('poses') === '2' ? 2 : 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      };
      try {
        this.landmarker = await PoseLandmarker.createFromOptions(files, options);
      } catch {
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
      this.frameRequest = this.video.requestVideoFrameCallback((now, meta) => this.detectFrame(meta.captureTime ?? now));
    } else {
      this.frameRequest = requestAnimationFrame(this.detectFrame);
    }
  }

  private lastTimestamp = 0;

  private detectFrame = (time: number) => {
    if (!this.running || !this.landmarker) return;
    // MediaPipe needs strictly increasing timestamps.
    const now = Math.max(time, this.lastTimestamp + 1);
    this.lastTimestamp = now;
    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const result = this.landmarker.detectForVideo(this.video, now);
      const selected = selectCenteredPose(result.landmarks);
      const image = selected < 0 ? undefined : result.landmarks[selected];
      const world = selected < 0 ? undefined : result.worldLandmarks[selected];
      if (image && world) {
        const frame: PoseFrame = {
          t: now,
          image: image.map(toLandmark),
          world: world.map(toLandmark),
          aspect: this.video.videoWidth / this.video.videoHeight,
        };
        this._latestFrame = frame;
        this._tracking = true;
        this.listeners.forEach((listener) => listener(frame));
      } else {
        this._latestFrame = null;
        this._tracking = false;
      }
    }
    this.schedule();
  };
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
