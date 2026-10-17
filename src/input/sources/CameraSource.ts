import type { PoseFrame } from '../../types';
import type { InputSource } from '../InputSource';

/**
 * Local webcam -> MediaPipe PoseLandmarker -> PoseFrame.
 * Used on the host for its player, and on the client before frames go over P2P.
 *
 * TODO (see SPEC.md "Vision"):
 *  - getUserMedia (640x480, camera picked in settings) -> <video>
 *  - PoseLandmarker, runningMode 'VIDEO', GPU, numPoses 2, keep the pose nearest frame center
 *  - per frame: emit { t, image: landmarks[i], world: worldLandmarks[i] }
 *  - One Euro filter on every landmark
 */
export class CameraSource implements InputSource {
  readonly kind = 'camera';
  readonly video = document.createElement('video');

  async start() {
    throw new Error('CameraSource not implemented yet');
  }

  stop() {}

  onFrame(_cb: (frame: PoseFrame) => void) {
    return () => {};
  }
}
