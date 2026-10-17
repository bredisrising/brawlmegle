import type { PoseFrame } from '../../types';
import type { InputSource } from '../InputSource';
import type { Peer } from '../../net/Peer';

/**
 * Frames streamed from the client laptop over the P2P "poses" channel.
 * On the host this looks like any other source to the InputHub.
 *
 * TODO: listen for { type: 'pose' } messages on the peer and re-emit their frames.
 */
export class RemoteSource implements InputSource {
  readonly kind = 'remote';
  private readonly peer: Peer;

  constructor(peer: Peer) {
    this.peer = peer;
  }

  async start() {
    void this.peer;
  }

  stop() {}

  onFrame(_cb: (frame: PoseFrame) => void) {
    return () => {};
  }
}
