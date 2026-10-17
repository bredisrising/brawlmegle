import { config } from '../config';
import type { PlayerId } from '../types';
import { MediaPipePoseTracker } from './MediaPipePoseTracker';
import { MockPoseTracker } from './MockPoseTracker';
import type { PoseTracker } from './PoseTracker';

export function createTracker(_id: PlayerId): PoseTracker {
  switch (config.tracker) {
    case 'mediapipe':
      return new MediaPipePoseTracker();
    case 'mock':
    default:
      return new MockPoseTracker();
  }
}

export type { PoseTracker } from './PoseTracker';
export * from './pose';
