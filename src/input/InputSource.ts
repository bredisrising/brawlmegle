import type { PoseFrame } from '../types';

/**
 * Anything that produces a live stream of PoseFrames for ONE person:
 * a local webcam, a remote peer over P2P, a keyboard mock, a recorded replay.
 * Sources don't know which player they are; InputHub assigns that.
 */
export interface InputSource {
  readonly kind: 'camera' | 'remote' | 'mock' | 'replay';
  /** Acquire camera / connection. Resolves once frames are flowing. */
  start(): Promise<void>;
  stop(): void;
  /** Subscribe to frames. Returns an unsubscribe function. */
  onFrame(cb: (frame: PoseFrame) => void): () => void;
  /** Optional live preview (e.g. webcam) the UI can show. */
  readonly video?: HTMLVideoElement;
}
