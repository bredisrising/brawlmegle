import type { SignalMessage } from './protocol';

/**
 * WebSocket client for the AWS signaling server (config.signalUrl).
 * Host gets a room code; client joins with it; SDP/ICE get relayed until P2P is up.
 *
 * TODO: connect, send/receive SignalMessage JSON, reconnect on drop.
 */
export class Signaling {
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    void this.url;
  }

  send(_msg: SignalMessage): void {}

  onMessage(_cb: (msg: SignalMessage) => void): () => void {
    return () => {};
  }

  close(): void {}
}
