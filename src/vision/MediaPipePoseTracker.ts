import type { Pose } from './pose';
import type { PoseTracker } from './PoseTracker';

/**
 * Webcam pose tracker backed by MediaPipe (`@mediapipe/tasks-vision` is installed).
 *
 * TODO:
 *  - start(): getUserMedia -> <video>, create PoseLandmarker (runningMode: 'VIDEO')
 *  - per frame: landmarker.detectForVideo(video, now).worldLandmarks[0] -> normalizeLandmarks()
 *  - two cameras per player for real 3D (triangulate / fuse)
 *  - smoothing (One Euro filter) before poses reach combat
 */
export class MediaPipePoseTracker implements PoseTracker {
  readonly kind = 'mediapipe';
  readonly video = document.createElement('video');

  async start() {
    throw new Error('MediaPipePoseTracker not implemented yet');
  }

  stop() {}

  getPose(): Pose | null {
    return null;
  }
}
