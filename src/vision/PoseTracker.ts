import type { Pose } from './pose';

/**
 * Anything that produces poses for one player: a local webcam (MediaPipe),
 * a keyboard mock, or (later) a remote peer streamed over the network.
 */
export interface PoseTracker {
  readonly kind: string;
  /** Acquire camera / models. Resolves once poses are flowing. */
  start(): Promise<void>;
  stop(): void;
  /** Latest pose in fighter-local space, or null if nobody is detected. */
  getPose(): Pose | null;
  /** Optional live preview (e.g. webcam) the UI can show. */
  readonly video?: HTMLVideoElement;
}
