import { RemoteSource, type InputHub, type InputSource } from '../input';
import { getForge, type ScanFrames } from '../forge/forge';
import { listFighters } from '../forge/roster';
import { Peer } from '../net/Peer';
import { Signaling } from '../net/Signaling';
import { PROTOCOL_VERSION, type ClientMessage, type HostMessage } from '../net/protocol';
import { config } from '../config';
import type { ForgedFighter, Stance, TrackerInfo } from '../types';
import type { Intent } from '../intent/intents';
import { PLAYER_NAMES } from './constants';
import type { FighterChoice } from './Game';
import { localPlayerId, useGameStore } from './store';

/** The slot the client laptop plays. */
const REMOTE = localPlayerId('client');
/** How long to wait for the client's scan frames before giving P2 a backup fighter. */
const SCAN_WAIT_MS = 90_000;

/** Game.setupPlayer for P2: `scan` is the frames the client captured, when it scanned. */
export type SetupRemote = (choice: FighterChoice, source: InputSource, scan?: Promise<ScanFrames>) => Promise<void>;

type Choice = Extract<ClientMessage, { type: 'profile' | 'pick' }>;
/** Game hooks: the client asked for a rematch; a client (re)connected and needs the match state. */
export type HostHooks = {
  rematch?: () => void;
  connected?: () => void;
  skip?: () => void;
  /** P2's moves as read on the client laptop (intents and/or the latest stance). */
  read?: (intents: Intent[], stance: Stance) => void;
  /** A screen started watching the room (spectate): it needs the match state. */
  watched?: () => void;
  /** P2's player left for good (said so, or never came back): free the slot for someone else. */
  left?: () => void;
  /** "Find a fight": the server sent us to join someone who's waiting (this session is done). */
  quickJoin?: (code: string) => void;
  /** The client player's "Hide my camera". */
  cam?: (hidden: boolean) => void;
  /** Room code: P2's player walked away mid-match (tab hidden), or came back. */
  away?: () => void;
  back?: () => void;
  /** Whether the client player's tab is visible. */
  presence?: (visible: boolean) => void;
  /** What the client's camera tracks P2 with (sent as each round starts). */
  tracker?: (info: TrackerInfo) => void;
  /** Any message at all from the client (the host's watchdog for a client gone quiet). */
  heard?: () => void;
};
type Deferred<T> = { resolve: (value: T) => void; reject: (err: Error) => void };

/**
 * The host laptop's side of P2P. Keeps a room open on the signaling server; whoever joins (first
 * time or after a drop) gets welcome + roster + phase, P2's poses go into the InputHub through a
 * RemoteSource, and P2 is set up from the profile / scan / pick the client sends. P2's setup
 * progress and the phase go back to the client so its screen follows the big one.
 */
export class HostSession {
  readonly peer = new Peer('host', new Signaling(config.signalUrl));
  /** P2's pose stream. One for the whole session: the host Peer survives rejoins. */
  readonly remote = new RemoteSource(this.peer);
  private readonly input: InputHub;
  private readonly setup: SetupRemote;
  /** Saved fighters, as last sent to the client. */
  private roster: ForgedFighter[] = [];
  /** The client's current profile/pick (JSON), so the copy it resends after a rejoin is ignored. */
  private choiceKey = '';
  /** Bumped per new choice, so a superseded setup doesn't hand out a backup fighter. */
  private gen = 0;
  private busy = false;
  /** One P2 setup at a time: a new pick waits for the old one to wind down. */
  private queue = Promise.resolve();
  /** Waiting for the client's scan frames. */
  private scan: Deferred<ScanFrames> | null = null;
  private lastFighter = '';
  private lastPhase = '';
  /** Screens watching this room (spectate). */
  private watchers = 0;
  /** A dropped client gets this long to come back before its slot is freed. */
  private releaseTimer = 0;
  private readonly cleanup: (() => void)[] = [];

  /**
   * `quick`: "Find a fight" with this player id. The room waits for a stranger (its code isn't shown), and whoever
   * leaves frees the slot at once: there's no rejoin, both go find someone new.
   */
  constructor(input: InputHub, setup: SetupRemote, private readonly hooks: HostHooks = {}, private readonly quick?: string) {
    this.input = input;
    this.setup = setup;
  }

  /** Whether a client laptop is connected right now. */
  get connected() {
    return this.peer.connected;
  }

  /** Send to the client laptop, if one is connected. */
  send(msg: HostMessage) {
    if (this.peer.connected) this.peer.send(msg);
  }

  /** Whether any screen watches this room (spectate). */
  get watching() {
    return this.watchers > 0;
  }

  /** Send to every screen watching this room, if any (through the signaling server). */
  cast(msg: HostMessage) {
    if (this.watchers > 0) this.peer.cast(msg);
  }

  /** Opens the room. Resolves with its code, or '' while signaling is unreachable (the code arrives via the store later). */
  async open(): Promise<string> {
    // Matchmade: closing the tab tells the stranger at once, so they go find someone new (no waiting for a timeout).
    const bye = () => this.quick && this.send({ type: 'next' });
    window.addEventListener('pagehide', bye);
    this.cleanup.push(
      () => window.removeEventListener('pagehide', bye),
      this.peer.onMessage((msg) => this.onMessage(msg as ClientMessage)),
      this.peer.onConnected(this.onConnected),
      this.peer.onClose(this.onDrop),
      this.peer.onRoom((roomCode) => useGameStore.setState({ roomCode })),
      this.peer.onQuickJoin((code) => this.hooks.quickJoin?.(code)),
      // A matched stranger who never connects: back to searching.
      this.peer.onConnectFailed(() => this.quick && this.release()),
      this.peer.onWatchers((count) => {
        const more = count > this.watchers;
        this.watchers = count;
        useGameStore.setState({ watchers: count });
        if (!more) return;
        this.sendPhase(true);
        this.hooks.watched?.();
      }),
      useGameStore.subscribe((s, prev) => {
        if (s.phase !== prev.phase || s.countdown !== prev.countdown || s.winner !== prev.winner || s.ending !== prev.ending || s.round !== prev.round || s.wins !== prev.wins) this.sendPhase();
        if (s.players[REMOTE] !== prev.players[REMOTE]) this.sendFighter();
      }),
    );
    try {
      return await this.peer.host({ quick: this.quick });
    } catch (err) {
      console.warn('[host] signaling server not reachable yet, retrying:', err);
      return '';
    }
  }

  dispose() {
    window.clearTimeout(this.releaseTimer);
    this.cleanup.splice(0).forEach((off) => off());
    this.scan?.reject(new Error('Host closed'));
    this.peer.close();
    this.remote.stop();
    useGameStore.setState({ connection: null });
  }

  private onConnected = () => {
    window.clearTimeout(this.releaseTimer);
    useGameStore.setState({ connection: 'open' });
    this.peer.send({ type: 'welcome', player: REMOTE });
    this.sendPhase(true);
    this.sendFighter(true);
    this.hooks.connected?.();
    // A reloaded client restarts its pose clock: reassign so the hub doesn't drop its "older" frames.
    if (this.input.source(REMOTE) === this.remote) this.input.assign(REMOTE, this.remote);
    void listFighters().then((fighters) => {
      this.roster = fighters;
      if (this.peer.connected) this.peer.send({ type: 'roster', fighters });
    });
  };

  /** The client dropped. The room stays open for its rejoin; P2 keeps their fighter but goes untracked (holds guard). */
  private onDrop = () => {
    useGameStore.setState({ connection: 'reconnecting' });
    this.remote.latestFrame = null;
    if (this.input.source(REMOTE) === this.remote) this.input.assign(REMOTE, this.remote);
    // Not back in time: they've gone, not blipped. The lobby frees the slot quickly so the next person can join;
    // mid-fight it waits longer for a Wi-Fi blip to recover.
    window.clearTimeout(this.releaseTimer);
    if (this.quick) return this.release();
    this.releaseTimer = window.setTimeout(() => this.release(), useGameStore.getState().phase === 'lobby' ? 10_000 : 45_000);
  };

  /** P2's player is gone: forget their choice and setup, and let the game free the slot (the room code shows again). */
  private release() {
    window.clearTimeout(this.releaseTimer);
    this.gen++;
    this.choiceKey = '';
    this.lastFighter = '';
    this.scan?.reject(new Error('P2 left'));
    this.scan = null;
    this.remote.latestFrame = null;
    useGameStore.setState({ connection: null });
    this.hooks.left?.();
  }

  /** Let the client go now (it went quiet, or never came back to its tab): its slot frees up as if it had left. */
  drop() {
    if (this.peer.connected) this.release();
  }

  private onMessage(msg: ClientMessage) {
    this.hooks.heard?.();
    switch (msg.type) {
      case 'hello':
        if (msg.version !== PROTOCOL_VERSION) console.warn(`[host] client protocol ${msg.version}, host ${PROTOCOL_VERSION}`);
        break;
      case 'profile':
      case 'pick':
        this.choose(msg);
        break;
      case 'scan':
        if (this.scan) this.scan.resolve(msg.frames);
        else console.warn('[host] got a scan nobody was waiting for');
        break;
      case 'rematch':
        if (useGameStore.getState().phase === 'ko') this.hooks.rematch?.();
        break;
      case 'skip':
        this.hooks.skip?.();
        break;
      case 'leave':
        this.release();
        break;
      case 'cam':
        this.hooks.cam?.(msg.hidden);
        break;
      case 'abandon':
        // Matchmade: they're gone, same as leaving. Room code: they're still in the room, the fight restarts when they're back.
        if (this.quick) this.release();
        else this.hooks.away?.();
        break;
      case 'back':
        this.hooks.back?.();
        break;
      case 'presence':
        this.hooks.presence?.(msg.visible);
        break;
      case 'intents':
        this.hooks.read?.(msg.intents, msg.stance);
        break;
      case 'stance':
        this.hooks.read?.([], msg.stance);
        break;
      case 'tracker':
        this.hooks.tracker?.(msg.info);
        break;
      // 'pose' goes to the RemoteSource.
    }
  }

  /** The client chose P2's fighter, or resent its choice after a rejoin. */
  private choose(msg: Choice) {
    const key = JSON.stringify(msg);
    const { phase, players } = useGameStore.getState();
    // A resend after a rejoin, or a fight already on: keep P2's fighter, tell the client where it's at.
    if ((key === this.choiceKey && (this.busy || players[REMOTE].status === 'ready')) || phase !== 'lobby') {
      return this.sendFighter(true);
    }
    // Credits are already spent on a running forge: let it finish.
    if (this.busy && !this.scan) return console.warn('[host] P2 is still forging, ignoring the new choice');
    this.scan?.reject(new Error('P2 chose a different fighter'));
    this.choiceKey = key;
    const gen = ++this.gen;
    // Listen for the scan now: it can arrive before an earlier setup has wound down.
    const scan = msg.type === 'profile' && msg.consent === 'save' ? this.waitForScan() : undefined;
    this.queue = this.queue.then(() => this.setUp(msg, gen, scan));
  }

  private async setUp(msg: Choice, gen: number, scan?: Promise<ScanFrames>) {
    if (gen !== this.gen) return; // superseded before it started
    this.busy = true;
    try {
      let choice: FighterChoice;
      try {
        choice = await this.toChoice(msg);
      } catch (err) {
        console.warn('[host]', err);
        choice = { kind: 'masked', name: PLAYER_NAMES[REMOTE] };
      }
      await this.setup(choice, this.remote, scan);
      // Nobody sits out: if P2's setup broke (forge down, empty scan), P2 gets a masked fighter.
      const p2 = useGameStore.getState().players[REMOTE];
      if (gen === this.gen && p2.status === 'waiting') {
        this.sendFighter(true, p2.statusDetail || 'Setup failed');
        await this.setup({ kind: 'masked', name: p2.name }, this.remote);
      }
    } finally {
      this.busy = false;
    }
  }

  private async toChoice(msg: Choice): Promise<FighterChoice> {
    if (msg.type === 'pick') return { kind: 'existing', fighter: await this.findFighter(msg.fighterId), guest: !!msg.guest };
    if (msg.consent === 'masked') return { kind: 'masked', name: msg.name };
    return { kind: 'scan', name: msg.name, username: msg.username, proof: typeof msg.ticket === 'string' ? { ticket: msg.ticket } : undefined };
  }

  /** Roster first; the client may have found a newer one by username on the shared forge. */
  private async findFighter(id: string): Promise<ForgedFighter> {
    const known = this.roster.find((f) => f.id === id);
    if (known) return known;
    this.roster = await listFighters();
    const listed = this.roster.find((f) => f.id === id);
    if (listed) return listed;
    const forged = await getForge(id, '');
    if (forged.status !== 'ready') throw new Error(`Fighter ${id} is not ready`);
    return forged;
  }

  private waitForScan(): Promise<ScanFrames> {
    let deferred!: Deferred<ScanFrames>;
    const promise = new Promise<ScanFrames>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        if (this.scan === deferred) this.scan = null;
      };
      const timer = setTimeout(() => deferred.reject(new Error("P2's scan never arrived")), SCAN_WAIT_MS);
      deferred = {
        resolve: (frames) => (settle(), resolve(frames)),
        reject: (err) => (settle(), reject(err)),
      };
    });
    promise.catch(() => {}); // setupPlayer reports it; a superseded scan nobody awaits shouldn't be "unhandled"
    this.scan = deferred;
    return promise;
  }

  private sendPhase(force = false) {
    if (!this.peer.connected && !this.watching) return;
    const { phase, countdown, winner, ending, round, wins } = useGameStore.getState();
    const key = `${phase}:${countdown}:${winner}:${ending}:${round}:${wins.p1}:${wins.p2}`;
    if (!force && key === this.lastPhase) return;
    this.lastPhase = key;
    const msg: HostMessage = { type: 'phase', phase, countdown, winner, ending, round, wins };
    this.send(msg);
    this.cast(msg);
  }

  /**
   * P2's setup progress, as the client shows it. Only while P2 is the client's player (not a test
   * player), and not while waiting on the scan (the client shows its own scan progress then).
   */
  private sendFighter(force = false, failed?: string) {
    if (!this.peer.connected) return;
    const p2 = useGameStore.getState().players[REMOTE];
    const base = { id: REMOTE, name: p2.name };
    let msg: HostMessage;
    if (failed) msg = { type: 'fighter', fighter: { ...base, status: 'failed', error: failed } };
    else if (this.input.source(REMOTE) !== this.remote) return;
    else if (p2.status === 'forging') {
      const preview = p2.forge ? { preview: p2.forge } : {};
      msg = { type: 'fighter', fighter: { ...base, status: 'forging', ...(p2.portraitUrl ? { cardUrl: p2.portraitUrl } : {}) }, detail: p2.statusDetail, ...preview };
    }
    else if (p2.status === 'ready') msg = { type: 'fighter', fighter: { ...base, status: 'ready', ...(p2.portraitUrl ? { cardUrl: p2.portraitUrl } : {}) } };
    else return;
    const key = JSON.stringify(msg);
    if (!force && key === this.lastFighter) return;
    this.lastFighter = key;
    this.peer.send(msg);
  }
}
