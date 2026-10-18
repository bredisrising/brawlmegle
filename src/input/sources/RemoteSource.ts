import type { PoseFrame } from '../../types';
import type { InputSource } from '../InputSource';
import type { Peer } from '../../net/Peer';

/**
 * Frames streamed from the client laptop over the P2P "poses" channel.
 * On the host this looks like any other source to the InputHub.
 * The host keeps one Peer across client rejoins, so this keeps working after a reconnect.
 */
export class RemoteSource implements InputSource {
  readonly kind = 'remote';
  private readonly peer: Peer;
  private readonly listeners = new Set<(frame: PoseFrame) => void>();
  private unsubscribe: (() => void) | null = null;
  latestFrame: PoseFrame | null = null;

  constructor(peer: Peer) {
    this.peer = peer;
  }

  /** Resolves right away: frames show up whenever the client streams them. */
  async start() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.peer.onMessage((msg) => {
      if (msg.type !== 'pose') return;
      this.latestFrame = msg.frame;
      for (const cb of this.listeners) cb(msg.frame);
    });
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.latestFrame = null;
  }

  onFrame(cb: (frame: PoseFrame) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
