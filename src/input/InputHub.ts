import type { PlayerId, PoseFrame } from '../types';
import type { InputSource } from './InputSource';

/**
 * The input wrapper: maps any InputSource to a player slot.
 * Everything downstream (intent, director live pose) reads frames per player
 * from here and never cares where they came from.
 *
 *   hub.assign('p1', new CameraSource())   // host's own camera
 *   hub.assign('p2', remoteSource)         // client laptop over P2P
 *
 * TODO:
 *  - assign(): subscribe to source.onFrame, keep the latest frame per player, fan out to listeners
 *  - stamp each frame with receivedAt (host clock) next to the source's own t
 *  - drop frames older than the latest one (remote frames can arrive out of order)
 */
export class InputHub {
  assign(_player: PlayerId, _source: InputSource): void {}

  unassign(_player: PlayerId): void {}

  /** Latest frame for a player, or null if nothing has arrived yet. */
  latest(_player: PlayerId): PoseFrame | null {
    return null;
  }

  /** Listen to every frame for a player. Returns an unsubscribe function. */
  subscribe(_player: PlayerId, _cb: (frame: PoseFrame) => void): () => void {
    return () => {};
  }
}
