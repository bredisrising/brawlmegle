import type { NormalizedLandmark, PoseLandmarkerOptions } from '@mediapipe/tasks-vision';
import type { Landmark } from '../../types';

/** Shared by the camera source and its worker: which MediaPipe pose model, from where, with what options. */
export type PoseVariant = 'lite' | 'full';
export type PoseDelegate = 'GPU' | 'CPU';

export const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm';
export const modelUrl = (variant: PoseVariant) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${variant}/float16/1/pose_landmarker_${variant}.task`;

/** `model`: the model file's bytes when the page already has them (else MediaPipe downloads it). */
export function landmarkerOptions(variant: PoseVariant, delegate: PoseDelegate, numPoses: number, model?: Uint8Array): PoseLandmarkerOptions {
  return {
    baseOptions: model ? { modelAssetBuffer: model, delegate } : { modelAssetPath: modelUrl(variant), delegate },
    runningMode: 'VIDEO',
    // 2 on purpose: with numPoses 1, MediaPipe adds its own hidden smoothing (more lag on top of ours).
    // With 2 it re-runs person detection each frame (a few ms) but stays unsmoothed. `?poses=1` to compare.
    numPoses,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
}

export function toLandmark(point: NormalizedLandmark): Landmark {
  return { x: point.x, y: point.y, z: point.z, visibility: point.visibility ?? 0 };
}

/** With numPoses 2 (bystanders around), pick the person nearest the center. */
export function selectCenteredPose(poses: NormalizedLandmark[][]): number {
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

/** Worker protocol (CameraSource <-> poseWorker). */
export type PoseWorkerRequest =
  /** model: the model file the page preloaded (a copy), so the worker doesn't download it again. */
  | { type: 'init'; variant: PoseVariant; delegate: PoseDelegate; numPoses: number; model?: ArrayBuffer }
  /** One-pose mode on or off (see poseWorker.ts). */
  | { type: 'single'; on: boolean }
  | { type: 'variant'; variant: PoseVariant }
  | { type: 'frame'; id: number; t: number; image: VideoFrame }
  | { type: 'close' };

export type PoseWorkerReply =
  | { type: 'ready'; delegate: PoseDelegate }
  | { type: 'failed'; error: string }
  | { type: 'variant'; variant: PoseVariant; ok: boolean; error?: string }
  /** image/world: the selected person's landmarks, or null when nobody was found. ms: the model's time. */
  | { type: 'result'; id: number; t: number; ms: number; image: Landmark[] | null; world: Landmark[] | null }
  | { type: 'error'; id: number; error: string };
