import { config } from '../config';
import { CameraSource, preloadPose } from './sources/CameraSource';
import { MockSource } from './sources/MockSource';
import type { InputSource } from './InputSource';

/** The source for a player tracked on THIS machine. Remote players use RemoteSource instead. */
export function createLocalSource(): InputSource {
  return config.input === 'camera' ? new CameraSource() : new MockSource();
}

/** Start the local source's downloads early (the camera's MediaPipe and pose model), if it has any. */
export function preloadLocalInput() {
  if (config.input === 'camera') preloadPose();
}

export { InputHub } from './InputHub';
export { RemoteSource } from './sources/RemoteSource';
export type { InputSource } from './InputSource';
