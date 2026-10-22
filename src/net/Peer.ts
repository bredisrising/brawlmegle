import { config } from '../config';
import type { ChunkMessage, ClientMessage, HostMessage, SignalMessage } from './protocol';
import type { Signaling } from './Signaling';
import type { Role } from '../types';

export type LinkStats = { rttMs: number | null; relay: boolean; path: 'cable' | 'lan' | 'internet' | 'relay' };

type Message = ClientMessage | HostMessage;
type ChannelName = 'poses' | 'control';
type Opening = { resolve: () => void; reject: (err: Error) => void };

/** Control messages longer than this get split into chunks (scan JPEGs). Well under SCTP message limits. */
const CHUNK_SIZE = 16 * 1024;
/** A late pose is useless: drop new ones instead of queueing them behind a slow link. */
const POSE_BUFFER_LIMIT = 64 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
/** 'disconnected' can recover by itself; only treat it as a drop if it lasts this long. */
const DISCONNECT_GRACE_MS = 3_000;
/**
 * The camera video to the other laptop: a light track (Game shrinks it to ~320x240 at 15 fps), capped here too, so it
 * never competes with the pose tracker for the GPU or with the game data for the link.
 */
const VIDEO_ENCODING: RTCRtpEncodingParameters = { maxBitrate: 250_000, maxFramerate: 15 };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * WebRTC connection between host and client laptops.
 * Two data channels: "poses" (unordered, maxRetransmits 0) and "control" (reliable).
 * The host creates the offer and both channels; the client answers and receives them.
 *
 * The host keeps one Peer for the whole session: its signaling socket stays open (closing it
 * deletes the room), and every peer-joined (first join or a rejoin after a drop) gets a fresh
 * RTCPeerConnection. peer-left also arrives once the client closes signaling after P2P is up,
 * so drops are read from the RTCPeerConnection, not from signaling.
 */
export class Peer {
  readonly role: Role;
  private readonly signaling: Signaling;
  private pc: RTCPeerConnection | null = null;
  private readonly channels: Partial<Record<ChannelName, RTCDataChannel>> = {};
  private readonly listeners = new Set<(msg: Message) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly connectListeners = new Set<() => void>();
  private readonly roomListeners = new Set<(code: string) => void>();
  private readonly watcherListeners = new Set<(count: number) => void>();
  private readonly quickJoinListeners = new Set<(code: string) => void>();
  private readonly failListeners = new Set<(reason: string) => void>();
  private readonly videoListeners = new Set<(stream: MediaStream | null) => void>();
  /** What the host asks the server for: a room for a code, or ("Find a fight") an opponent. */
  private hostRequest: SignalMessage = { type: 'host' };
  /**
   * "Find a fight": connect only through our TURN relay, so neither stranger ever gets the other's IP address (a
   * direct P2P link hands each side the other's). Friends with a room code keep the direct, lower-latency path.
   */
  private relayOnly = false;
  /** This laptop's camera for the other one (null: nothing sent). Kept across connections. */
  private videoTrack: MediaStreamTrack | null = null;
  /** The other laptop's camera, while it sends one. */
  remoteVideo: MediaStream | null = null;
  /** Remote ICE candidates that arrived before the remote description. */
  private readonly pendingIce: RTCIceCandidateInit[] = [];
  /** Chunked messages being reassembled, by chunk id. */
  private readonly partial = new Map<number, string[]>();
  private nextChunkId = 0;
  /** Set while connecting; settles when both channels open or connecting fails. */
  private opening: Opening | null = null;
  /** Signaling messages are handled one at a time, so ICE candidates never race the offer or answer. */
  private signalQueue = Promise.resolve();
  /** Host only: waiting for the server's `room` message. */
  private roomWaiter: { resolve: (code: string) => void; reject: (err: Error) => void } | null = null;
  private reopening = false;
  private disconnectTimer = 0;
  private closed = false;
  /** Host only: the code clients join with ('' until the server sends one). */
  roomCode = '';

  constructor(role: Role, signaling: Signaling) {
    this.role = role;
    this.signaling = signaling;
  }

  /**
   * Host only: opens a room and returns its code to show on screen. Clients that join (or rejoin)
   * get connected in the background: see onConnected / onClose. Throws if the signaling server
   * can't be reached, but keeps retrying and reports the code through onRoom when it gets one.
   */
  async host(opts: { quick?: string } = {}): Promise<string> {
    // "Find a fight": the server may answer with someone to join instead of a room (onQuickJoin; this resolves '').
    if (opts.quick) {
      this.hostRequest = { type: 'quick', player: opts.quick };
      this.relayOnly = true;
    }
    this.signaling.onMessage((msg) => this.queueSignal(msg));
    // Losing signaling deletes the room on the server: open a new one (new code) so P2 can still rejoin.
    this.signaling.onDrop(() => void this.reopenRoom());
    try {
      return await this.openRoom();
    } catch (err) {
      void this.reopenRoom();
      throw err;
    }
  }

  /** Client only. Resolves once both data channels are open. `player`: "Find a fight", the room is held for it. */
  async join(code: string, player?: string): Promise<void> {
    this.relayOnly = !!player;
    await this.signaling.connect();
    const opened = this.whenOpen();
    this.signaling.onMessage((msg) => this.queueSignal(msg));
    this.createConnection();
    this.signaling.send(player ? { type: 'join', code, player } : { type: 'join', code });
    try {
      await opened;
    } finally {
      // Signaling is done once the channels are open. Game data never touches the server.
      this.signaling.close();
    }
  }

  /**
   * Link quality from WebRTC's own stats: round-trip time of the connection in use, and whether it goes through
   * the TURN relay (venue Wi-Fi that blocks direct P2P) or straight between the laptops. Null when not connected.
   */
  /**
   * The chosen path to the other laptop: 'cable' (a direct LAN path on an ethernet adapter, e.g. two laptops joined by a
   * cable with their own IPs), 'lan' (same network), 'internet' (P2P through NAT) or 'relay' (TURN).
   */
  async linkStats(): Promise<LinkStats | null> {
    const pc = this.pc;
    if (!pc || !this.connected) return null;
    const report = await pc.getStats();
    let pair: RTCIceCandidatePairStats | undefined;
    report.forEach((s) => {
      if (s.type === 'candidate-pair' && (s as RTCIceCandidatePairStats).nominated && (s as RTCIceCandidatePairStats).state === 'succeeded') pair = s as RTCIceCandidatePairStats;
    });
    if (!pair) return null;
    type Candidate = { candidateType?: string; address?: string; networkType?: string; networkAdapterType?: string };
    const local = report.get(pair.localCandidateId) as Candidate | undefined;
    const remote = report.get(pair.remoteCandidateId) as Candidate | undefined;
    const rtt = pair.currentRoundTripTime;
    const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
    // A LAN path sends from this laptop's own address (a 'host' candidate); over the internet it's the NAT's (srflx/prflx).
    const lan = !relay && local?.candidateType === 'host';
    const adapter = local?.networkType ?? local?.networkAdapterType ?? '';
    const cable = lan && (adapter === 'ethernet' || /^169\.254\./.test(local?.address ?? ''));
    const path = relay ? 'relay' : cable ? 'cable' : lan ? 'lan' : 'internet';
    return { rttMs: rtt === undefined ? null : Math.round(rtt * 1000), relay, path };
  }

  /** Host: send a message to every screen watching this room (through the signaling server, see Spectate). */
  cast(msg: HostMessage): void {
    this.signaling.send({ type: 'cast', data: msg });
  }

  /** Host ("Find a fight"): the server sent us to join someone who's waiting, instead of waiting ourselves. */
  onQuickJoin(cb: (code: string) => void): () => void {
    this.quickJoinListeners.add(cb);
    return () => this.quickJoinListeners.delete(cb);
  }

  /** Host: a client was sent to us but never connected. */
  onConnectFailed(cb: (reason: string) => void): () => void {
    this.failListeners.add(cb);
    return () => this.failListeners.delete(cb);
  }

  /**
   * This laptop's camera for the other laptop, or null to stop sending. Every connection has a video transceiver from
   * the start (sendrecv), so this only swaps the track: no renegotiation.
   */
  setVideo(track: MediaStreamTrack | null) {
    if (track === this.videoTrack) return;
    this.videoTrack = track;
    void this.videoSender()?.replaceTrack(track).catch((err) => console.warn('[peer] could not swap the video track', err));
  }

  /** The video this laptop is sending right now (null: none). */
  get sendingVideo(): MediaStreamTrack | null {
    return this.videoSender()?.track ?? null;
  }

  /** The other laptop's camera arriving (a stream) or going (null: the connection closed). */
  onRemoteVideo(cb: (stream: MediaStream | null) => void): () => void {
    this.videoListeners.add(cb);
    return () => this.videoListeners.delete(cb);
  }

  private videoSender(): RTCRtpSender | undefined {
    return this.pc?.getTransceivers().find((t) => t.receiver.track?.kind === 'video')?.sender;
  }

  private setRemoteVideo(stream: MediaStream | null) {
    if (stream === this.remoteVideo) return;
    this.remoteVideo = stream;
    for (const cb of this.videoListeners) cb(stream);
  }

  /** Host: how many screens watch this room, whenever it changes. */
  onWatchers(cb: (count: number) => void): () => void {
    this.watcherListeners.add(cb);
    return () => this.watcherListeners.delete(cb);
  }

  get connected(): boolean {
    return this.channels.control?.readyState === 'open';
  }

  /** Poses go on the lossy channel, everything else on the reliable one. */
  send(msg: Message): void {
    if (msg.type === 'pose' || msg.type === 'frame' || msg.type === 'stance') {
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

  /** Fires every time both channels open: the client's join, and on the host each (re)joined client. */
  onConnected(cb: () => void): () => void {
    this.connectListeners.add(cb);
    return () => this.connectListeners.delete(cb);
  }

  /**
   * Fires if an open connection drops. Not called for close().
   * A client Peer is finished after this; a host Peer waits for the client to rejoin.
   */
  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  /** Host only: fires with each room code from the server (a new one after signaling reconnects). */
  onRoom(cb: (code: string) => void): () => void {
    this.roomListeners.add(cb);
    return () => this.roomListeners.delete(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.opening?.reject(new Error('Connection closed'));
    this.roomWaiter?.reject(new Error('Connection closed'));
    this.teardown();
    this.signaling.close();
  }

  /** Host: connect signaling, ask for a room, resolve with its code. */
  private async openRoom(): Promise<string> {
    await this.signaling.connect();
    const room = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The signaling server never sent a room code')), CONNECT_TIMEOUT_MS);
      this.roomWaiter = {
        resolve: (code) => (clearTimeout(timer), resolve(code)),
        reject: (err) => (clearTimeout(timer), reject(err)),
      };
    });
    this.signaling.send(this.hostRequest);
    try {
      return await room;
    } finally {
      this.roomWaiter = null;
    }
  }

  /** Host: signaling dropped (or never connected). Retry with backoff until there's a room again. */
  private async reopenRoom() {
    if (this.reopening || this.closed) return;
    this.reopening = true;
    try {
      for (let attempt = 0; !this.closed; attempt++) {
        await wait(Math.min(1000 * 2 ** attempt, 8000));
        if (this.closed) return;
        try {
          await this.openRoom();
          return;
        } catch (err) {
          console.warn('[peer] signaling unreachable, retrying', err);
        }
      }
    } finally {
      this.reopening = false;
    }
  }

  private whenOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const opening: Opening = {
        resolve: () => (settle(), resolve()),
        reject: (err) => (settle(), reject(err)),
      };
      const settle = () => {
        clearTimeout(timer);
        if (this.opening === opening) this.opening = null;
      };
      const timer = setTimeout(() => opening.reject(new Error('Timed out connecting to the other laptop')), CONNECT_TIMEOUT_MS);
      this.opening = opening;
    });
  }

  private get iceTransportPolicy(): RTCIceTransportPolicy {
    return this.relayOnly ? 'relay' : 'all';
  }

  private createConnection(iceServers = config.iceServers) {
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: this.iceTransportPolicy });
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signaling.send({ type: 'signal', data: e.candidate.toJSON() });
    };
    pc.ondatachannel = (e) => this.attach(e.channel);
    pc.ontrack = (e) => {
      if (e.track.kind === 'video' && this.pc === pc) this.setRemoteVideo(e.streams[0] ?? new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => {
      clearTimeout(this.disconnectTimer);
      if (pc.connectionState === 'failed') this.drop('Connection failed');
      if (pc.connectionState === 'disconnected') {
        this.disconnectTimer = window.setTimeout(() => this.drop('Connection lost'), DISCONNECT_GRACE_MS);
      }
    };
    this.pc = pc;
    return pc;
  }

  /** Host: a client joined the room (or rejoined after a drop). Fresh connection, both channels, offer. */
  private async offer(iceServers: RTCIceServer[]) {
    // The room reopens on the server once P2 is connected, so a third laptop could join: keep P2.
    if (this.connected && this.pc?.connectionState === 'connected') {
      console.warn('[peer] ignoring another client: P2 is already connected');
      return;
    }
    this.opening?.reject(new Error('Another client joined'));
    this.teardown();
    const pc = this.createConnection(iceServers);
    this.whenOpen().catch((err: Error) => {
      console.warn('[peer] client did not connect:', err.message);
      if (this.pc !== pc) return;
      this.teardown();
      for (const cb of this.failListeners) cb(err.message);
    });
    // Video first, so it's in the offer: both ways from the start, the camera swapped in later with replaceTrack.
    pc.addTransceiver(this.videoTrack ?? 'video', { direction: 'sendrecv', sendEncodings: [VIDEO_ENCODING] });
    this.attach(pc.createDataChannel('poses', { ordered: false, maxRetransmits: 0 }));
    this.attach(pc.createDataChannel('control'));
    await pc.setLocalDescription();
    this.signaling.send({ type: 'signal', data: pc.localDescription!.toJSON() });
  }

  /** Forget the current RTCPeerConnection without firing any callbacks. */
  private teardown() {
    clearTimeout(this.disconnectTimer);
    for (const name of ['poses', 'control'] as const) {
      const ch = this.channels[name];
      if (!ch) continue;
      ch.onopen = ch.onclose = ch.onmessage = null;
      ch.close();
      delete this.channels[name];
    }
    const pc = this.pc;
    if (pc) {
      pc.onicecandidate = pc.ondatachannel = pc.onconnectionstatechange = pc.ontrack = null;
      pc.close();
    }
    this.pc = null;
    this.setRemoteVideo(null);
    this.pendingIce.length = 0;
    this.partial.clear();
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
    if (!this.opening || this.channels.poses?.readyState !== 'open' || this.channels.control?.readyState !== 'open') return;
    // A matched quick host isn't looking any more: if signaling drops now, it just reopens a room (no new match).
    this.hostRequest = { type: 'host' };
    this.opening.resolve();
    for (const cb of this.connectListeners) cb();
  }

  private queueSignal(msg: SignalMessage) {
    this.signalQueue = this.signalQueue.then(() => this.onSignal(msg));
  }

  private onSignal = async (msg: SignalMessage) => {
    const pc = this.pc;
    try {
      if (msg.type === 'error') {
        if (this.role === 'client') throw new Error(msg.message);
        if (this.roomWaiter) this.roomWaiter.reject(new Error(msg.message));
        else console.warn('[peer] signaling error:', msg.message);
        return;
      }
      if (msg.type === 'quick-join') {
        this.roomWaiter?.resolve('');
        for (const cb of this.quickJoinListeners) cb(msg.code);
        return;
      }
      if (msg.type === 'room') {
        this.roomCode = msg.code;
        this.roomWaiter?.resolve(msg.code);
        for (const cb of this.roomListeners) cb(msg.code);
        return;
      }
      if (msg.type === 'watchers') {
        for (const cb of this.watcherListeners) cb(msg.count);
        return;
      }
      if (msg.type === 'peer-joined') return await this.offer(msg.iceServers);
      // Arrives before the offer, so the fresh TURN credentials apply before ICE gathering starts.
      // The relay-only policy goes along: a configuration without it would quietly reset it to 'all'.
      if (msg.type === 'joined') pc?.setConfiguration({ iceServers: msg.iceServers, iceTransportPolicy: this.iceTransportPolicy });
      if (msg.type !== 'signal' || !pc) return;

      if ('type' in msg.data) {
        await pc.setRemoteDescription(msg.data);
        for (const candidate of this.pendingIce.splice(0)) await pc.addIceCandidate(candidate);
        if (msg.data.type === 'offer') {
          // The host's offer has a video transceiver: send this laptop's camera back on it.
          const video = pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video');
          if (video) {
            video.direction = 'sendrecv';
            if (this.videoTrack) await video.sender.replaceTrack(this.videoTrack);
          }
          await pc.setLocalDescription();
          this.signaling.send({ type: 'signal', data: pc.localDescription!.toJSON() });
          if (video) {
            const params = video.sender.getParameters();
            if (params.encodings?.length) {
              params.encodings = params.encodings.map((e) => ({ ...e, ...VIDEO_ENCODING }));
              await video.sender.setParameters(params).catch((err) => console.warn('[peer] video encoding not capped', err));
            }
          }
        }
      } else if (pc.remoteDescription) {
        await pc.addIceCandidate(msg.data);
      } else {
        this.pendingIce.push(msg.data);
      }
    } catch (err) {
      console.error('[peer] signaling', err);
      // A connection that was already replaced or torn down doesn't fail the current one.
      if (pc === this.pc) this.opening?.reject(err instanceof Error ? err : new Error(String(err)));
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
    // The host keeps its room (signaling stays open) so the client can rejoin; a client Peer is done.
    if (this.role === 'host') this.teardown();
    else this.close();
    if (wasOpen) for (const cb of this.closeListeners) cb();
  }
}
