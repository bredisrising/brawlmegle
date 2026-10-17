import type { SignalMessage } from './protocol';

/**
 * WebSocket client for the AWS signaling server (config.signalUrl).
 * Host gets a room code; client joins with it; SDP/ICE get relayed until P2P is up.
 *
 * TODO (host): reconnect on drop, so a client can still rejoin the room mid-match.
 */
export class Signaling {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<(msg: SignalMessage) => void>();

  constructor(url: string) {
    this.url = url;
  }

  /** Resolves once the socket is open. */
  connect(): Promise<void> {
    if (!this.url) return Promise.reject(new Error('VITE_SIGNAL_URL is not set'));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`Could not reach the signaling server at ${this.url}`));
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
      };
      ws.onmessage = (e) => {
        let msg: SignalMessage;
        try {
          msg = JSON.parse(e.data as string) as SignalMessage;
        } catch {
          return;
        }
        for (const cb of this.listeners) cb(msg);
      };
    });
  }

  /** Dropped if the socket isn't open (e.g. late ICE candidates after P2P is already up). */
  send(msg: SignalMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onMessage(cb: (msg: SignalMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.listeners.clear();
  }
}
