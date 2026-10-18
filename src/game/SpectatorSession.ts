import { config } from '../config';
import type { HostMessage, MatchPlayer, MirrorEvent, MirrorFrame } from '../net/protocol';
import { Signaling } from '../net/Signaling';
import { useGameStore } from './store';

/** Where a watched fight goes: the same mirror the client laptop draws (see Game.mirrorMatch / mirrorTick). */
export type SpectatorMirror = {
  match: (players: Record<'p1' | 'p2', MatchPlayer>) => void;
  frame: (frame: MirrorFrame) => void;
  events: (events: MirrorEvent[]) => void;
};

/**
 * A screen that only watches (spectate): a TV or a third laptop shows a hosted room's fight with no camera and no
 * player. It asks the signaling server to watch the room code, and the host casts its match, phase, frames and
 * events through the server. The two players' laptops still talk peer to peer, so watching adds no lag to the fight.
 * Keeps watching through Wi-Fi blips and a host reconnecting (same code).
 */
export class SpectatorSession {
  private readonly signaling = new Signaling(config.signalUrl);
  private closed = false;
  private retryTimer = 0;

  constructor(
    readonly code: string,
    private readonly mirror: SpectatorMirror,
  ) {
    this.signaling.onMessage((msg) => {
      if (msg.type === 'cast') this.onHostMessage(msg.data);
      else if (msg.type === 'watching') useGameStore.setState({ connection: 'open' });
    });
    this.signaling.onDrop(() => this.retry());
  }

  /** Resolves once the server says we're watching; rejects with its message (no room with that code). */
  async connect(): Promise<void> {
    await this.signaling.connect();
    await new Promise<void>((resolve, reject) => {
      const off = this.signaling.onMessage((msg) => {
        if (msg.type === 'watching') {
          off();
          resolve();
        } else if (msg.type === 'error') {
          off();
          reject(new Error(msg.message));
        }
      });
      this.signaling.send({ type: 'watch', code: this.code });
    });
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.signaling.close();
  }

  /** Lost the server: keep trying every 2 s (the room may be gone for a moment while its host reconnects). */
  private retry() {
    if (this.closed) return;
    useGameStore.setState({ connection: 'reconnecting' });
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.connect().catch(() => this.retry());
    }, 2000);
  }

  private onHostMessage(msg: HostMessage) {
    switch (msg.type) {
      case 'phase':
        useGameStore.setState({
          phase: msg.phase,
          countdown: msg.countdown,
          ...(msg.winner !== undefined ? { winner: msg.winner } : {}),
          ...(msg.ending !== undefined ? { ending: msg.ending } : {}),
        });
        break;
      case 'match':
        this.mirror.match(msg.players);
        break;
      case 'frame':
        this.mirror.frame(msg.frame);
        break;
      case 'events':
        this.mirror.events(msg.events);
        break;
    }
  }
}
