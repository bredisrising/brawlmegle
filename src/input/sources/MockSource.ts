import type { PoseFrame } from '../../types';
import type { InputSource } from '../InputSource';

/**
 * Stand-in source so the game runs without a camera.
 *
 * TODO: emit a standing PoseFrame at 30 fps, or play back a recorded session
 * (lets us test P2P streaming and intent without anyone in front of a camera).
 */
export class MockSource implements InputSource {
  readonly kind = 'mock';

  async start() {}

  stop() {}

  onFrame(_cb: (frame: PoseFrame) => void) {
    return () => {};
  }
}
