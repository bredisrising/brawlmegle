import { Signaling } from '../../src/net/Signaling';
import type { ChunkMessage, SignalMessage } from '../../src/net/protocol';

/**
 * Bare-bones host for testing the client Peer on its own, independent of Peer.host().
 * Opens a room, makes the offer when a client joins, and records what arrives on each channel.
 */
export class TestHost {
  readonly signaling: Signaling;
  code = '';
  pc: RTCPeerConnection | null = null;
  poses: RTCDataChannel | null = null;
  control: RTCDataChannel | null = null;
  /** Every signaling message from the server, in order. */
  readonly signals: SignalMessage[] = [];
  /** Control messages from the client, with chunks reassembled. */
  readonly received: { type: string; [key: string]: unknown }[] = [];
  readonly posesReceived: unknown[] = [];
  private readonly partial = new Map<number, string[]>();
  /** Handle signaling messages one at a time, so ICE candidates never race the answer. */
  private queue = Promise.resolve();
  private readonly pendingIce: RTCIceCandidateInit[] = [];

  constructor(url: string) {
    this.signaling = new Signaling(url);
  }

  async open(): Promise<string> {
    await this.signaling.connect();
    this.signaling.onMessage((msg) => {
      this.signals.push(msg);
      this.queue = this.queue.then(() => this.onSignal(msg)).catch((err) => console.error('[host]', err));
    });
    this.signaling.send({ type: 'host' });
    const room = await this.waitFor((m): m is Extract<SignalMessage, { type: 'room' }> => m.type === 'room');
    this.code = room.code;
    return room.code;
  }

  /** Resolves with the first signaling message (already received or upcoming) that matches. */
  waitFor<T extends SignalMessage>(match: (m: SignalMessage) => m is T, from = 0): Promise<T> {
    return poll(() => this.signals.slice(from).find(match), 'signaling message');
  }

  /** Resolves once the client sends a control message of this type. */
  waitForMessage(type: string) {
    return poll(() => this.received.find((m) => m.type === type), `"${type}" from the client`);
  }

  whenOpen() {
    return poll(() => (this.poses?.readyState === 'open' && this.control?.readyState === 'open') || undefined, 'host channels');
  }

  /** Sends a control message the way Peer would, splitting it into chunks if asked. */
  send(msg: object, chunkSize = Infinity) {
    const json = JSON.stringify(msg);
    if (json.length <= chunkSize) return this.control!.send(json);
    const count = Math.ceil(json.length / chunkSize);
    for (let index = 0; index < count; index++) {
      const data = json.slice(index * chunkSize, (index + 1) * chunkSize);
      this.control!.send(JSON.stringify({ type: 'chunk', id: 1, index, count, data } satisfies ChunkMessage));
    }
  }

  /** Drop the P2P link but keep the room open, like a host whose Wi-Fi blips. */
  dropPeer() {
    this.poses?.close();
    this.control?.close();
    this.pc?.close();
    this.pc = this.poses = this.control = null;
  }

  close() {
    this.dropPeer();
    this.signaling.close();
  }

  private async onSignal(msg: SignalMessage) {
    if (msg.type === 'peer-joined') {
      this.dropPeer();
      this.pendingIce.length = 0;
      const pc = new RTCPeerConnection({ iceServers: msg.iceServers });
      this.pc = pc;
      pc.onicecandidate = (e) => {
        if (e.candidate) this.signaling.send({ type: 'signal', data: e.candidate.toJSON() });
      };
      this.poses = pc.createDataChannel('poses', { ordered: false, maxRetransmits: 0 });
      this.control = pc.createDataChannel('control');
      this.poses.onmessage = (e) => this.posesReceived.push(JSON.parse(e.data));
      this.control.onmessage = (e) => this.receive(e.data);
      await pc.setLocalDescription();
      this.signaling.send({ type: 'signal', data: pc.localDescription!.toJSON() });
      return;
    }
    const pc = this.pc;
    if (msg.type !== 'signal' || !pc) return;
    if ('type' in msg.data) {
      await pc.setRemoteDescription(msg.data);
      for (const candidate of this.pendingIce.splice(0)) await pc.addIceCandidate(candidate);
    } else if (pc.remoteDescription) {
      await pc.addIceCandidate(msg.data);
    } else {
      this.pendingIce.push(msg.data);
    }
  }

  private receive(raw: string) {
    let msg = JSON.parse(raw);
    if (msg.type === 'chunk') {
      const parts = this.partial.get(msg.id) ?? [];
      parts.push(msg.data);
      if (parts.length < msg.count) return void this.partial.set(msg.id, parts);
      this.partial.delete(msg.id);
      msg = JSON.parse(parts.join(''));
    }
    this.received.push(msg);
  }
}

/** Polls `check` until it returns something, or rejects after `timeoutMs`. */
export function poll<T>(check: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const tick = () => {
      const value = check();
      if (value !== undefined) return resolve(value);
      if (performance.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}
