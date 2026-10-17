import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { config } from '../../config';
import type { Landmark, PoseFrame } from '../../types';
import { LandmarkFilter } from '../LandmarkFilter';
import type { InputSource } from '../InputSource';

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm';
const POSE_MODEL_ROOT = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
const MAX_INFERENCE_FPS = 30;

/** Webcam -> MediaPipe PoseLandmarker -> timestamped image and world landmarks. */
export class CameraSource implements InputSource {
  readonly kind = 'camera';
  readonly video = document.createElement('video');
  private readonly listeners = new Set<(frame: PoseFrame) => void>();
  private readonly filter = new LandmarkFilter();
  private stream: MediaStream | null = null;
  private landmarker: PoseLandmarker | null = null;
  private frameRequest = 0;
  private running = false;
  private _latestFrame: PoseFrame | null = null;
  private _tracking = false;
  private lastVideoTime = -1;
  private lastInferenceAt = -Infinity;

  readonly modelName = config.poseModel;

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
        video: {
          width: { ideal: 640 }, height: { ideal: 480 },
          frameRate: { ideal: MAX_INFERENCE_FPS, max: MAX_INFERENCE_FPS },
          facingMode: 'user',
        },
      });
      this.video.srcObject = this.stream;
      await this.video.play();

      const files = await FilesetResolver.forVisionTasks(WASM_ROOT);
      const modelAssetPath = `${POSE_MODEL_ROOT}/pose_landmarker_${config.poseModel}/float16/1/pose_landmarker_${config.poseModel}.task`;
      const options = {
        baseOptions: { modelAssetPath, delegate: 'GPU' as const },
        runningMode: 'VIDEO' as const,
        numPoses: config.poseCount,
        minPoseDetectionConfidence: 0.55,
        minPosePresenceConfidence: 0.55,
        minTrackingConfidence: 0.6,
      };
      try {
        this.landmarker = await PoseLandmarker.createFromOptions(files, options);
      } catch {
        // Some browsers expose WebGL but cannot initialize MediaPipe's GPU delegate.
        this.landmarker = await PoseLandmarker.createFromOptions(files, {
          ...options,
          baseOptions: { modelAssetPath, delegate: 'CPU' },
        });
      }
      this.running = true;
      this.frameRequest = requestAnimationFrame(this.detectFrame);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this._latestFrame = null;
    this._tracking = false;
    this.lastVideoTime = -1;
    this.lastInferenceAt = -Infinity;
    this.filter.reset();
  }

  onFrame(cb: (frame: PoseFrame) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private detectFrame = (now: number) => {
    if (!this.running || !this.landmarker) return;
    const freshVideoFrame = this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.video.currentTime !== this.lastVideoTime;
    const canInfer = now - this.lastInferenceAt >= 1000 / MAX_INFERENCE_FPS;
    if (freshVideoFrame && canInfer) {
      this.lastVideoTime = this.video.currentTime;
      this.lastInferenceAt = now;
      const result = this.landmarker.detectForVideo(this.video, now);
      const selected = selectCenteredPose(result.landmarks);
      const image = selected < 0 ? undefined : result.landmarks[selected];
      const world = selected < 0 ? undefined : result.worldLandmarks[selected];
      if (image && world) {
        const rawFrame: PoseFrame = {
          t: now,
          image: image.map(toLandmark),
          world: world.map(toLandmark),
        };
        const frame = this.filter.filter(rawFrame);
        this._latestFrame = frame;
        this._tracking = true;
        this.listeners.forEach((listener) => listener(frame));
      } else {
        this._latestFrame = null;
        this._tracking = false;
        this.filter.reset();
      }
    }
    this.frameRequest = requestAnimationFrame(this.detectFrame);
  };
}

function toLandmark(point: NormalizedLandmark): Landmark {
  return { x: point.x, y: point.y, z: point.z, visibility: point.visibility ?? 0 };
}

/** numPoses is two so the camera can track both people; choose the centered one. */
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
