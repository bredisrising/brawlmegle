import { RemoteSource, type InputHub, type InputSource } from '../input';
import { getForge, type ScanFrames } from '../forge/forge';
import { listFighters } from '../forge/roster';
import { Peer } from '../net/Peer';
import { Signaling } from '../net/Signaling';
import { PROTOCOL_VERSION, type ClientMessage, type HostMessage } from '../net/protocol';
import { config } from '../config';
import type { ForgedFighter } from '../types';
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
  private readonly cleanup: (() => void)[] = [];

  constructor(input: InputHub, setup: SetupRemote) {
    this.input = input;
    this.setup = setup;
  }

  /** Opens the room. Resolves with its code, or '' while signaling is unreachable (the code arrives via the store later). */
  async open(): Promise<string> {
    this.cleanup.push(
      this.peer.onMessage((msg) => this.onMessage(msg as ClientMessage)),
      this.peer.onConnected(this.onConnected),
      this.peer.onClose(() => useGameStore.setState({ connection: 'reconnecting' })),
      this.peer.onRoom((roomCode) => useGameStore.setState({ roomCode })),
      useGameStore.subscribe((s, prev) => {
        if (s.phase !== prev.phase || s.countdown !== prev.countdown) this.sendPhase();
        if (s.players[REMOTE] !== prev.players[REMOTE]) this.sendFighter();
      }),
    );
    try {
      return await this.peer.host();
    } catch (err) {
      console.warn('[host] signaling server not reachable yet, retrying:', err);
      return '';
    }
  }

  dispose() {
    this.cleanup.splice(0).forEach((off) => off());
    this.scan?.reject(new Error('Host closed'));
    this.peer.close();
    this.remote.stop();
    useGameStore.setState({ connection: null });
  }

  private onConnected = () => {
    useGameStore.setState({ connection: 'open' });
    this.peer.send({ type: 'welcome', player: REMOTE });
    this.sendPhase(true);
    this.sendFighter(true);
    // A reloaded client restarts its pose clock: reassign so the hub doesn't drop its "older" frames.
    if (this.input.source(REMOTE) === this.remote) this.input.assign(REMOTE, this.remote);
    void listFighters().then((fighters) => {
      this.roster = fighters;
      if (this.peer.connected) this.peer.send({ type: 'roster', fighters });
    });
  };

  private onMessage(msg: ClientMessage) {
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
    if (msg.type === 'pick') return { kind: 'existing', fighter: await this.findFighter(msg.fighterId) };
    if (msg.consent === 'masked') return { kind: 'masked', name: msg.name };
    return { kind: 'scan', name: msg.name, username: msg.username };
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
    if (!this.peer.connected) return;
    const { phase, countdown } = useGameStore.getState();
    const key = `${phase}:${countdown}`;
    if (!force && key === this.lastPhase) return;
    this.lastPhase = key;
    this.peer.send({ type: 'phase', phase, countdown });
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
    else if (p2.status === 'forging') msg = { type: 'fighter', fighter: { ...base, status: 'forging' }, detail: p2.statusDetail };
    else if (p2.status === 'ready') msg = { type: 'fighter', fighter: { ...base, status: 'ready', ...(p2.portraitUrl ? { cardUrl: p2.portraitUrl } : {}) } };
    else return;
    const key = JSON.stringify(msg);
    if (!force && key === this.lastFighter) return;
    this.lastFighter = key;
    this.peer.send(msg);
  }
}
