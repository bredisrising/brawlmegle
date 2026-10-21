import { createLocalSource, type InputSource } from '../input';
import { trackerInfoOf } from '../input/poseHealth';
import { captureScan, forgeBusy } from '../forge/forge';
import { saveOwner } from '../forge/roster';
import { FORGE_STEPS, onChange, scanStatus } from '../forge/status';
import { Peer } from '../net/Peer';
import { Signaling } from '../net/Signaling';
import { PROTOCOL_VERSION, type ClientMessage, type HostMessage, type MatchPlayer, type MirrorEvent, type MirrorFrame } from '../net/protocol';
import { config } from '../config';
import type { ForgedFighter, ForgePreview, PlayerId, PoseFrame } from '../types';
import { IntentReader } from '../intent/IntentReader';
import type { Intent } from '../intent/intents';
import type { FighterChoice } from './Game';
import { VideoClip } from './MatchRecorder';
import { localPlayerId, updatePlayer, useGameStore } from './store';

const PLAYER = localPlayerId('client');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where the host's fight goes on this laptop (the Game draws it). */
export type ClientMirror = {
  match(players: Record<PlayerId, MatchPlayer>): void;
  frame(frame: MirrorFrame): void;
  events(events: MirrorEvent[]): void;
  /** This laptop's own read of its player, for instant feedback on its own screen. */
  local?(intents: Intent[]): void;
  /** A connection to the host opened (each rejoin is a new Peer): for the camera share. */
  peer?(peer: Peer): void;
  /** The host player's "Hide my camera". */
  cam?(hidden: boolean): void;
  /** After a K.O.: who wants a rematch, and (matchmade) ms until both go find someone new. */
  votes?(votes: Record<PlayerId, boolean>, nextIn: number | null): void;
  /** Matchmade: the host is off to find a new opponent (so are we). */
  next?(): void;
  /** Matchmade: the link dropped (no rejoin: we go find someone new). */
  lost?(): void;
  /** The host called the match off: `who` walked away (tab hidden too long). */
  abandon?(who: PlayerId): void;
  /** Whether the host player's tab is visible. */
  presence?(visible: boolean): void;
  /** Any message at all from the host (the client's watchdog for a host gone quiet). */
  heard?(): void;
};

/** "Find a fight" sessions: the camera comes from the Game (it stays on between opponents), and there's no rejoin. */
export type ClientOptions = { source?: InputSource; player?: string; quick?: boolean };

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
  /** Done with (see retire): the host's messages no longer reach the game or the store. */
  private retired = false;
  private skipScanNow: (() => void) | null = null;
  /**
   * P2's moves are read here, from this laptop's own camera at full rate, and only the result crosses the network
   * (the poses still stream for the host's live layer and recordings). Reading streamed poses on the host suffered
   * every dropped or late packet: real 1v1 rounds delivered P2 at 2.5–7 fps.
   */
  private readonly reader = new IntentReader(PLAYER);
  /** `?video=1`: this laptop's camera during each round, saved locally (see MatchRecorder). */
  private readonly clip = new VideoClip();
  /** This laptop's latest camera frame (P2's own pose, blended into its fighter on this screen). */
  lastFrame: PoseFrame | null = null;

  /** The camera was handed in (matchmaking): it outlives this session, so it's not stopped here. */
  private readonly borrowed: boolean;

  constructor(code: string, private readonly mirror?: ClientMirror, private readonly opts: ClientOptions = {}) {
    this.code = code;
    this.source = opts.source ?? null;
    this.borrowed = !!opts.source;
  }

  /** "Hide my camera" to the host player. */
  sendCam(hidden: boolean) {
    this.send({ type: 'cam', hidden });
  }

  /** This player walked away mid-match (tab hidden too long), or came back (room code). */
  sendAway(away: boolean) {
    this.send({ type: away ? 'abandon' : 'back' });
  }

  /** Whether this player's tab is visible (also sent once a second: the host's sign of life from this laptop). */
  sendPresence(visible = document.visibilityState !== 'hidden') {
    this.send({ type: 'presence', visible });
  }

  private heartbeat = 0;

  /** Link quality to the host (see Peer.linkStats). */
  linkStats() {
    return this.peer?.linkStats() ?? Promise.resolve(null);
  }

  /** "Fight now": ask the host not to wait for this player's forge. */
  skipForge() {
    this.send({ type: 'skip' });
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
      updatePlayer(PLAYER, { name, status: 'scanning', statusDetail: this.source ? 'Joining the fight' : 'Starting camera' });
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
        updatePlayer(PLAYER, { statusDetail: 'Face the camera' });
        const show = onChange((statusDetail) => updatePlayer(PLAYER, { statusDetail }));
        const skip = new AbortController();
        this.skipScanNow = () => skip.abort();
        const frames = await captureScan(this.source.video, this.source, (u) => {
          show(scanStatus(u.view));
          useGameStore.setState({ scan: { view: u.view, thumbs: u.thumbs } });
        }, { skip: skip.signal }).finally(() => {
          this.skipScanNow = null;
          useGameStore.setState({ scan: null });
        });
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
      if (!this.borrowed) {
        this.source?.stop();
        this.source = null;
      }
      updatePlayer(PLAYER, { status: 'waiting', statusDetail: 'Something went wrong — try again' });
      useGameStore.setState({ screen: 'avatar' });
    }
  }

  /** The scan overlay's "Done: forge with the front photo". */
  skipScan() {
    this.skipScanNow?.();
  }

  /** Going back to the title (or closing the tab): tell the host, so P2's slot opens for the next person right away. */
  leave() {
    this.send({ type: 'leave' });
  }

  /**
   * Done with this host, but a last message (leave, abandon) is still going out: from now on nothing from the host
   * touches this laptop's game, and the connection closes a moment later.
   */
  retire(ms = 300) {
    this.retired = true;
    this.stopStream?.();
    this.stopStream = null;
    clearInterval(this.heartbeat);
    setTimeout(() => this.dispose(), ms);
  }

  dispose() {
    window.removeEventListener('pagehide', this.onPageHide);
    clearInterval(this.heartbeat);
    this.disposed = true;
    this.stopStream?.();
    if (!this.borrowed) this.source?.stop();
    this.clip.stop('p2');
    this.peer?.close();
    this.peer = null;
  }

  private async open(): Promise<Peer> {
    const peer = new Peer('client', new Signaling(config.signalUrl));
    // Listen before joining: the host may send welcome + roster the moment the channels open.
    peer.onMessage((msg) => this.onHostMessage(msg as HostMessage));
    try {
      await peer.join(this.code, this.opts.player);
    } catch (err) {
      peer.close();
      throw err;
    }
    peer.onClose(this.onDrop);
    peer.send({ type: 'hello', version: PROTOCOL_VERSION });
    this.mirror?.peer?.(peer);
    clearInterval(this.heartbeat);
    this.heartbeat = window.setInterval(() => this.sendPresence(), 1000);
    window.addEventListener('pagehide', this.onPageHide);
    return peer;
  }

  /** Best effort on a closed tab or a reload: a dropped client is freed after a timeout anyway. */
  private onPageHide = () => this.leave();

  private send(msg: ClientMessage) {
    this.peer?.send(msg);
  }

  private stream(source: InputSource) {
    this.stopStream?.();
    this.stopStream = source.onFrame((frame) => {
      this.lastFrame = frame;
      this.send({ type: 'pose', frame });
      const out = this.reader.update(frame, frame.t);
      if (out.intents.length) {
        this.send({ type: 'intents', intents: out.intents, stance: out.stance });
        this.mirror?.local?.(out.intents);
      } else {
        this.send({ type: 'stance', stance: out.stance });
      }
    });
  }

  private onHostMessage(msg: HostMessage) {
    if (this.retired) return;
    this.mirror?.heard?.();
    switch (msg.type) {
      case 'welcome':
        if (msg.player !== PLAYER) console.warn(`[client] host assigned ${msg.player}, expected ${PLAYER}`);
        break;
      case 'roster':
        useGameStore.setState({ roster: msg.fighters });
        break;
      case 'phase': {
        const { screen, players } = useGameStore.getState();
        const cam = this.source as { video?: HTMLVideoElement } | null;
        if (msg.phase === 'fighting') this.clip.start((cam?.video?.srcObject as MediaStream | null) ?? null);
        // The round's on: tell the host what this camera tracks with, for its match recording.
        const tracker = msg.phase === 'fighting' && msg.countdown === 0 ? trackerInfoOf(this.source) : null;
        if (tracker) this.send({ type: 'tracker', info: tracker });
        if (msg.phase === 'ko' || msg.phase === 'lobby') this.clip.stop('p2');
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
        this.showFighter(msg.fighter, msg.detail, msg.preview);
        break;
      case 'cam':
        this.mirror?.cam?.(msg.hidden);
        break;
      case 'owner':
        // The fighter forged for this laptop's player: this browser keeps its owner key ("Delete my fighter").
        saveOwner({ id: msg.fighterId, key: msg.key }, msg.name);
        if (msg.done) useGameStore.setState({ deleteCode: { fighterId: msg.fighterId, name: msg.name, code: msg.code } });
        break;
      case 'votes':
        this.mirror?.votes?.(msg.votes, msg.nextIn);
        break;
      case 'abandon':
        this.mirror?.abandon?.(msg.who);
        break;
      case 'presence':
        this.mirror?.presence?.(msg.visible);
        break;
      case 'next':
        this.mirror?.next?.();
        break;
    }
  }

  private showFighter(fighter: ForgedFighter, detail?: string, preview?: ForgePreview) {
    switch (fighter.status) {
      case 'scanning':
      case 'forging':
        updatePlayer(PLAYER, {
          name: fighter.name,
          status: 'forging',
          statusDetail: detail || (fighter.step ? FORGE_STEPS[fighter.step] : 'Forging your fighter'),
          ...(fighter.cardUrl ? { portraitUrl: fighter.cardUrl } : {}),
          forge: preview ?? null,
        });
        break;
      case 'failed':
        // The host drops down the fallback ladder (SPEC.md "Forge"), so P2 still gets a fighter.
        updatePlayer(PLAYER, { status: 'forging', statusDetail: 'Forge hiccup, picking a backup fighter' });
        break;
      case 'ready': {
        updatePlayer(PLAYER, { name: fighter.name, status: 'ready', statusDetail: '', portraitUrl: fighter.cardUrl ?? null, forge: null });
        // Rejoined mid-fight: straight back to the fight.
        const { phase, screen } = useGameStore.getState();
        if (phase !== 'lobby' && screen === 'client') useGameStore.setState({ screen: 'game' });
        break;
      }
    }
  }

  private onDrop = () => {
    if (this.retired) return;
    this.peer = null;
    this.stopStream?.();
    this.stopStream = null;
    // Matchmade: the stranger is gone (or their Wi-Fi is): find someone new rather than wait.
    if (this.opts.quick) return this.mirror?.lost?.();
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
