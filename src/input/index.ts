import { config } from '../config';
import { CameraSource } from './sources/CameraSource';
import { MockSource } from './sources/MockSource';
import type { InputSource } from './InputSource';

/** The source for a player tracked on THIS machine. Remote players use RemoteSource instead. */
export function createLocalSource(): InputSource {
  return config.input === 'camera' ? new CameraSource() : new MockSource();
}

export { InputHub } from './InputHub';
export { RemoteSource } from './sources/RemoteSource';
export type { InputSource } from './InputSource';
