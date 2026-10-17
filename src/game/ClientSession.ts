import { createLocalSource, type InputSource } from '../input';
import { captureScan } from '../forge/forge';
import { Peer } from '../net/Peer';
import { Signaling } from '../net/Signaling';
import { PROTOCOL_VERSION, type ClientMessage, type HostMessage } from '../net/protocol';
import { config } from '../config';
import type { ForgedFighter } from '../types';
import type { FighterChoice } from './Game';
import { localPlayerId, updatePlayer, useGameStore } from './store';

const PLAYER = localPlayerId('client');

const FORGE_STEPS: Record<NonNullable<ForgedFighter['step']>, string> = {
  brief: 'Sizing you up',
  sheet: 'Drawing your fighter',
  model: 'Building your 3D model',
  cleanup: 'Polishing',
  rig: 'Rigging your fighter',
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  constructor(code: string) {
    this.code = code;
  }

  /** Title screen "Join". Throws if the room can't be reached. */
  async connect() {
    this.peer = await this.open();
    useGameStore.setState({ connection: 'open' });
  }

  /** Avatar screen: tell the host who P2 is, scan if needed, and start streaming poses. */
  async choose(choice: FighterChoice) {
    const name = choice.kind === 'existing' ? choice.fighter.name : choice.name;
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
          : [{ type: 'profile', name, consent: choice.kind === 'scan' ? 'save' : 'masked' }];
      this.confirmed = false;
      this.setup.forEach((msg) => this.send(msg));
      this.stream(this.source);

      if (choice.kind === 'scan') {
        updatePlayer(PLAYER, { statusDetail: 'Turn slowly' });
        const scan: ClientMessage = { type: 'scan', frames: await captureScan(this.source.video) };
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
    this.stopStream = source.onFrame((frame) => this.send({ type: 'pose', frame }));
  }

  private onHostMessage(msg: HostMessage) {
    switch (msg.type) {
      case 'welcome':
        if (msg.player !== PLAYER) console.warn(`[client] host assigned ${msg.player}, expected ${PLAYER}`);
        break;
      case 'roster':
        useGameStore.setState({ roster: msg.fighters });
        break;
      case 'phase':
        useGameStore.setState({ phase: msg.phase, countdown: msg.countdown });
        break;
      case 'fighter':
        this.confirmed = true;
        this.showFighter(msg.fighter);
        break;
    }
  }

  private showFighter(fighter: ForgedFighter) {
    switch (fighter.status) {
      case 'scanning':
      case 'forging':
        updatePlayer(PLAYER, {
          name: fighter.name,
          status: 'forging',
          statusDetail: fighter.step ? FORGE_STEPS[fighter.step] : 'Forging your fighter',
        });
        break;
      case 'failed':
        // The host drops down the fallback ladder (SPEC.md "Forge"), so P2 still gets a fighter.
        updatePlayer(PLAYER, { status: 'forging', statusDetail: 'Forge hiccup, picking a backup fighter' });
        break;
      case 'ready':
        updatePlayer(PLAYER, { name: fighter.name, status: 'ready', statusDetail: '', portraitUrl: fighter.cardUrl ?? null });
        break;
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
