import { config } from '../config';
import type { ChunkMessage, ClientMessage, HostMessage, SignalMessage } from './protocol';
import type { Signaling } from './Signaling';
import type { Role } from '../types';

type Message = ClientMessage | HostMessage;
type ChannelName = 'poses' | 'control';

/** Control messages longer than this get split into chunks (scan JPEGs). Well under SCTP message limits. */
const CHUNK_SIZE = 16 * 1024;
/** A late pose is useless: drop new ones instead of queueing them behind a slow link. */
const POSE_BUFFER_LIMIT = 64 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
/** 'disconnected' can recover by itself; only treat it as a drop if it lasts this long. */
const DISCONNECT_GRACE_MS = 3_000;

/**
 * WebRTC connection between host and client laptops.
 * Two data channels: "poses" (unordered, maxRetransmits 0) and "control" (reliable).
 * The host creates the offer and both channels; the client answers and receives them.
 *
 * TODO (host):
 *  - host(): ask signaling for a room, wait for peer-joined, createConnection(),
 *    create both channels (attach() them), send the offer
 *  - keep signaling open after connecting so the client can rejoin
 */
export class Peer {
  readonly role: Role;
  private readonly signaling: Signaling;
  private pc: RTCPeerConnection | null = null;
  private readonly channels: Partial<Record<ChannelName, RTCDataChannel>> = {};
  private readonly listeners = new Set<(msg: Message) => void>();
  private readonly closeListeners = new Set<() => void>();
  /** Remote ICE candidates that arrived before the remote description. */
  private readonly pendingIce: RTCIceCandidateInit[] = [];
  /** Chunked messages being reassembled, by chunk id. */
  private readonly partial = new Map<number, string[]>();
  private nextChunkId = 0;
  /** Set while connecting; settles when both channels open or connecting fails. */
  private opening: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private disconnectTimer = 0;
  private closed = false;

  constructor(role: Role, signaling: Signaling) {
    this.role = role;
    this.signaling = signaling;
  }

  /** Host only: returns the room code to show on the title screen. */
  async host(): Promise<string> {
    return '';
  }

  /** Client only. Resolves once both data channels are open. */
  async join(code: string): Promise<void> {
    await this.signaling.connect();
    const opened = this.whenOpen();
    this.signaling.onMessage(this.onSignal);
    this.createConnection();
    this.signaling.send({ type: 'join', code });
    try {
      await opened;
    } finally {
      // Signaling is done once the channels are open. Game data never touches the server.
      this.signaling.close();
    }
  }

  get connected(): boolean {
    return this.channels.control?.readyState === 'open';
  }

  /** Poses go on the lossy channel, everything else on the reliable one. */
  send(msg: Message): void {
    if (msg.type === 'pose') {
      const ch = this.channels.poses;
      if (ch?.readyState === 'open' && ch.bufferedAmount < POSE_BUFFER_LIMIT) ch.send(JSON.stringify(msg));
      return;
    }

    const ch = this.channels.control;
    if (ch?.readyState !== 'open') {
      console.warn(`[peer] dropped "${msg.type}": control channel not open`);
      return;
    }
    const json = JSON.stringify(msg);
    if (json.length <= CHUNK_SIZE) {
      ch.send(json);
      return;
    }
    const id = this.nextChunkId++;
    const count = Math.ceil(json.length / CHUNK_SIZE);
    for (let index = 0; index < count; index++) {
      const data = json.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
      ch.send(JSON.stringify({ type: 'chunk', id, index, count, data } satisfies ChunkMessage));
    }
  }

  onMessage(cb: (msg: Message) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Fires once if an open connection drops. Not called for close(). */
  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.disconnectTimer);
    this.opening?.reject(new Error('Connection closed'));
    for (const ch of Object.values(this.channels)) ch.close();
    this.pc?.close();
    this.signaling.close();
    this.partial.clear();
  }

  private whenOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.opening?.reject(new Error('Timed out connecting to the other laptop')), CONNECT_TIMEOUT_MS);
      const settle = () => {
        clearTimeout(timer);
        this.opening = null;
      };
      this.opening = {
        resolve: () => (settle(), resolve()),
        reject: (err) => (settle(), reject(err)),
      };
    });
  }

  private createConnection() {
    const pc = new RTCPeerConnection({ iceServers: config.iceServers });
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signaling.send({ type: 'signal', data: e.candidate.toJSON() });
    };
    pc.ondatachannel = (e) => this.attach(e.channel);
    pc.onconnectionstatechange = () => {
      clearTimeout(this.disconnectTimer);
      if (pc.connectionState === 'failed') this.drop('Connection failed');
      if (pc.connectionState === 'disconnected') {
        this.disconnectTimer = window.setTimeout(() => this.drop('Connection lost'), DISCONNECT_GRACE_MS);
      }
    };
    this.pc = pc;
  }

  private attach(channel: RTCDataChannel) {
    const label = channel.label;
    if (label !== 'poses' && label !== 'control') return;
    this.channels[label] = channel;
    channel.onmessage = (e) => this.receive(e.data);
    channel.onopen = () => this.checkOpen();
    channel.onclose = () => this.drop(`"${label}" channel closed`);
    this.checkOpen();
  }

  private checkOpen() {
    if (this.channels.poses?.readyState === 'open' && this.channels.control?.readyState === 'open') this.opening?.resolve();
  }

  private onSignal = async (msg: SignalMessage) => {
    const pc = this.pc;
    try {
      if (msg.type === 'error') throw new Error(msg.message);
      if (msg.type !== 'signal' || !pc) return;

      if ('type' in msg.data) {
        await pc.setRemoteDescription(msg.data);
        for (const candidate of this.pendingIce.splice(0)) await pc.addIceCandidate(candidate);
        if (msg.data.type === 'offer') {
          await pc.setLocalDescription();
          this.signaling.send({ type: 'signal', data: pc.localDescription!.toJSON() });
        }
      } else if (pc.remoteDescription) {
        await pc.addIceCandidate(msg.data);
      } else {
        this.pendingIce.push(msg.data);
      }
    } catch (err) {
      console.error('[peer] signaling', err);
      this.opening?.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };

  private receive(raw: unknown) {
    if (typeof raw !== 'string') return;
    let msg: Message | ChunkMessage;
    try {
      msg = JSON.parse(raw) as Message | ChunkMessage;
    } catch {
      return;
    }

    if (msg.type === 'chunk') {
      // Chunks only travel on the ordered control channel, so they arrive in order.
      const parts = this.partial.get(msg.id) ?? [];
      parts.push(msg.data);
      if (parts.length < msg.count) {
        this.partial.set(msg.id, parts);
        return;
      }
      this.partial.delete(msg.id);
      msg = JSON.parse(parts.join('')) as Message;
    }
    for (const cb of this.listeners) cb(msg);
  }

  /** Connection failed or dropped: reject a pending connect, or tell listeners an open link went down. */
  private drop(reason: string) {
    if (this.closed) return;
    const wasOpen = !this.opening;
    this.opening?.reject(new Error(reason));
    this.close();
    if (wasOpen) for (const cb of this.closeListeners) cb();
  }
}
