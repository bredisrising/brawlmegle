import { createLocalSource, type InputSource } from '../input';
import { captureScan, forgeBusy } from '../forge/forge';
import { FORGE_STEPS, onChange, scanStatus } from '../forge/status';
import { Peer } from '../net/Peer';
import { Signaling } from '../net/Signaling';
import { PROTOCOL_VERSION, type ClientMessage, type HostMessage, type MatchPlayer, type MirrorEvent, type MirrorFrame } from '../net/protocol';
import { config } from '../config';
import type { ForgedFighter, PlayerId, PoseFrame } from '../types';
import type { FighterChoice } from './Game';
import { localPlayerId, updatePlayer, useGameStore } from './store';

const PLAYER = localPlayerId('client');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where the host's fight goes on this laptop (the Game draws it). */
export type ClientMirror = {
  match(players: Record<PlayerId, MatchPlayer>): void;
  frame(frame: MirrorFrame): void;
  events(events: MirrorEvent[]): void;
};

/**
 * The client laptop's side of P2P. Joins the host's room, tracks + scans P2 on this camera,
 * sends the profile / scan / pick to the host and streams live poses. The host forges and runs
 * the fight; this only mirrors what the host reports (roster, phase, forge progress) into the store.
 *
 * If the link drops it rejoins with the same room code and resumes streaming; the host keeps P2's fighter.
 */
export class ClientSession {
  private readonly code: string;
  private peer: Peer | null = null;
  private source: InputSource | null = null;
  private stopStream: (() => void) | null = null;
  /** What we told the host about P2's fighter. Resent after a reconnect until the host confirms it. */
  private setup: ClientMessage[] = [];
  private confirmed = false;
  private disposed = false;
  /** This laptop's latest camera frame (P2's own pose, blended into its fighter on this screen). */
  lastFrame: PoseFrame | null = null;

  constructor(code: string, private readonly mirror?: ClientMirror) {
    this.code = code;
  }

  /** Link quality to the host (see Peer.linkStats). */
  linkStats() {
    return this.peer?.linkStats() ?? Promise.resolve(null);
  }

  /** K.O. screen "Rematch" on this laptop: the host decides. */
  requestRematch() {
    this.send({ type: 'rematch' });
  }

  get inputSource() {
    return this.source;
  }

  /** Title screen "Join". Throws if the room can't be reached. */
  async connect() {
    this.peer = await this.open();
    useGameStore.setState({ connection: 'open' });
  }

  /** Avatar screen: tell the host who P2 is, scan if needed, and start streaming poses. */
  async choose(choice: FighterChoice) {
    const name = choice.kind === 'existing' ? choice.fighter.name : choice.name;
    if (choice.kind === 'scan') {
      // The host forges what this laptop scans: don't make them turn around for nothing if the forge is full.
      const busy = await forgeBusy();
      if (busy) {
        updatePlayer(PLAYER, { status: 'waiting', statusDetail: `The forge can't take a new scan right now (${busy}). Pick a saved fighter, go masked, or try again in a minute.` });
        useGameStore.setState({ screen: 'avatar' });
        return;
      }
    }
    try {
      updatePlayer(PLAYER, { name, status: 'scanning', statusDetail: 'Starting camera' });
      if (!this.source) {
        const source = createLocalSource();
        await source.start();
        this.source = source;
      }

      this.setup =
        choice.kind === 'existing'
          ? [{ type: 'pick', fighterId: choice.fighter.id }]
          : choice.kind === 'scan'
            ? [{ type: 'profile', name, consent: 'save', username: choice.username }]
            : [{ type: 'profile', name, consent: 'masked' }];
      this.confirmed = false;
      this.setup.forEach((msg) => this.send(msg));
      this.stream(this.source);

      if (choice.kind === 'scan') {
        updatePlayer(PLAYER, { statusDetail: 'Turn slowly' });
        const show = onChange((statusDetail) => updatePlayer(PLAYER, { statusDetail }));
        const frames = await captureScan(this.source.video, this.source, (p) => show(scanStatus(p)));
        const scan: ClientMessage = { type: 'scan', frames };
        this.setup.push(scan);
        this.send(scan);
      }
      // The host answers with `fighter` messages: forge progress, then status 'ready'.
      updatePlayer(PLAYER, { status: 'forging', statusDetail: 'Sending to the big screen' });
    } catch (err) {
      console.error(err);
      this.stopStream?.();
      this.stopStream = null;
      this.source?.stop();
      this.source = null;
      updatePlayer(PLAYER, { status: 'waiting', statusDetail: 'Something went wrong — try again' });
      useGameStore.setState({ screen: 'avatar' });
    }
  }

  dispose() {
    this.disposed = true;
    this.stopStream?.();
    this.source?.stop();
    this.peer?.close();
    this.peer = null;
  }

  private async open(): Promise<Peer> {
    const peer = new Peer('client', new Signaling(config.signalUrl));
    // Listen before joining: the host may send welcome + roster the moment the channels open.
    peer.onMessage((msg) => this.onHostMessage(msg as HostMessage));
    try {
      await peer.join(this.code);
    } catch (err) {
      peer.close();
      throw err;
    }
    peer.onClose(this.onDrop);
    peer.send({ type: 'hello', version: PROTOCOL_VERSION });
    return peer;
  }

  private send(msg: ClientMessage) {
    this.peer?.send(msg);
  }

  private stream(source: InputSource) {
    this.stopStream?.();
    this.stopStream = source.onFrame((frame) => {
      this.lastFrame = frame;
      this.send({ type: 'pose', frame });
    });
  }

  private onHostMessage(msg: HostMessage) {
    switch (msg.type) {
      case 'welcome':
        if (msg.player !== PLAYER) console.warn(`[client] host assigned ${msg.player}, expected ${PLAYER}`);
        break;
      case 'roster':
        useGameStore.setState({ roster: msg.fighters });
        break;
      case 'phase': {
        const { screen, players } = useGameStore.getState();
        useGameStore.setState({
          phase: msg.phase,
          countdown: msg.countdown,
          ...(msg.winner !== undefined ? { winner: msg.winner } : {}),
          ...(msg.ending !== undefined ? { ending: msg.ending } : {}),
          // Once the fight starts, this laptop shows it too.
          ...(msg.phase !== 'lobby' && screen === 'client' && players[PLAYER].status === 'ready' ? { screen: 'game' as const } : {}),
        });
        break;
      }
      case 'match':
        this.mirror?.match(msg.players);
        break;
      case 'frame':
        this.mirror?.frame(msg.frame);
        break;
      case 'events':
        this.mirror?.events(msg.events);
        break;
      case 'fighter':
        this.confirmed = true;
        this.showFighter(msg.fighter, msg.detail);
        break;
    }
  }

  private showFighter(fighter: ForgedFighter, detail?: string) {
    switch (fighter.status) {
      case 'scanning':
      case 'forging':
        updatePlayer(PLAYER, {
          name: fighter.name,
          status: 'forging',
          statusDetail: detail || (fighter.step ? FORGE_STEPS[fighter.step] : 'Forging your fighter'),
          ...(fighter.cardUrl ? { portraitUrl: fighter.cardUrl } : {}),
        });
        break;
      case 'failed':
        // The host drops down the fallback ladder (SPEC.md "Forge"), so P2 still gets a fighter.
        updatePlayer(PLAYER, { status: 'forging', statusDetail: 'Forge hiccup, picking a backup fighter' });
        break;
      case 'ready': {
        updatePlayer(PLAYER, { name: fighter.name, status: 'ready', statusDetail: '', portraitUrl: fighter.cardUrl ?? null });
        // Rejoined mid-fight: straight back to the fight.
        const { phase, screen } = useGameStore.getState();
        if (phase !== 'lobby' && screen === 'client') useGameStore.setState({ screen: 'game' });
        break;
      }
    }
  }

  private onDrop = () => {
    this.peer = null;
    this.stopStream?.();
    this.stopStream = null;
    useGameStore.setState({ connection: 'reconnecting' });
    void this.reconnect();
  };

  private async reconnect() {
    for (let attempt = 0; !this.disposed; attempt++) {
      await wait(Math.min(1000 * 2 ** attempt, 8000));
      if (this.disposed) return;
      let peer: Peer;
      try {
        peer = await this.open();
      } catch (err) {
        console.warn('[client] rejoin failed, retrying', err);
        continue;
      }
      if (this.disposed) return peer.close();

      this.peer = peer;
      useGameStore.setState({ connection: 'open' });
      if (!this.confirmed) this.setup.forEach((msg) => this.send(msg));
      if (this.source) this.stream(this.source);
      return;
    }
  }
}
