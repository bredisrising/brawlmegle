import { Renderer } from '../director/Renderer';
import { poseRateOf, setOnePose } from '../director/QualityGovernor';
import * as THREE from 'three';
import { Effects, type EffectKind } from '../director/Effects';
import { FighterView } from '../director/FighterView';
import { Sfx } from '../director/Sfx';
import { Announcer } from '../director/Announcer';
import { Fireballs } from '../director/Fireballs';
import { Walkout } from '../director/Walkout';
import { ROUND_CALL_SECONDS } from '../director/walkoutTiming';
import { Cpu, type CpuLevel, type CpuOutput } from '../fight/Cpu';
import { FightEngine } from '../fight/FightEngine';
import { Resolver } from '../fight/Resolver';
import { IntentReader } from '../intent/IntentReader';
import type { Intent } from '../intent/intents';
import { InputHub, createLocalSource, preloadLocalInput, type InputSource } from '../input';
import { MockSource } from '../input/sources/MockSource';
import { captureScan, forgeBusy, forgeFighter, type ScanFrames } from '../forge/forge';
import { forgePreview, forgeStatus, onChange, samePreview, scanStatus } from '../forge/status';
import { fetchServerFighters, maskedFighter, saveFighter } from '../forge/roster';
import { preloadModel } from '../forge/models';
import { recordMatch } from '../forge/leaderboard';
import { config } from '../config';
import {
  PLAYER_IDS, opponentOf,
  type Command, type FightEvent, type FighterState, type ForgedFighter, type PlayerId, type PoseFrame, type Stance,
} from '../types';
import { COUNTDOWN_FROM, KO_FREEZE, MAX_HP, PLAYER_COLORS, PLAYER_NAMES, ROUND_SECONDS, SIM_DT } from './constants';
import { ClientSession, type ClientMirror, type ClientOptions } from './ClientSession';
import { CameraShare } from './CameraShare';
import { SpectatorSession } from './SpectatorSession';
import type { HostMessage, MatchPlayer, MirrorEvent, MirrorFrame } from '../net/protocol';
import { HostSession } from './HostSession';
import { MatchRecorder, recordingEnabled } from './MatchRecorder';
import { HighlightRecorder } from './HighlightRecorder';
import { Commentary, TEMPLATES, fill, spoken, type Line } from './Commentary';
import { NO_VOTES, localPlayerId, pushPopup, updatePlayer, useGameStore } from './store';

/** Round length: shorter at a demo booth (`?demo=1`). */
const ROUND = config.demo ? 45 : ROUND_SECONDS;

/** What drives a CPU slot: the real CPU, or Training's dummy. */
type Brain = { think(engine: FightEngine, tick: number): CpuOutput; reset(): void };

/** Training's dummy: stands there with its guard down, never swings, never moves. */
class Dummy implements Brain {
  constructor(private readonly player: PlayerId) {}
  think(): CpuOutput {
    return { commands: [], stance: { player: this.player, guard: false, advance: 0, lean: { x: 0, y: 0 }, tracked: true } };
  }
  reset() {}
}

/** K.O. replay: ticks kept, ticks shown before and after the K.O., playback speed, and a hold on the end. */
const REPLAY_KEEP = 240;
const REPLAY_BEFORE = 80;
const REPLAY_AFTER = 50;
const REPLAY_SPEED = 0.35;
const REPLAY_HOLD = 0.8;
/** Game seconds after the K.O. (after its freeze; slowed by the slow motion) before the replay starts. */
const REPLAY_DELAY = 1.2;
type ReplayFrame = MirrorFrame & { live: Record<PlayerId, PoseFrame | null>; events: MirrorEvent[] };
/** Roughly head height between the two fighters. */
/** How long a fresh forge shows itself off in the forging card (textured, then the rig flashes) before it's ready. */
const REVEAL_MS = 2200;
/** Matchmade fights: after the K.O. screen comes back from the replay, this long to vote for a rematch. */
const NEXT_MS = 4000;
/** ...measured from here when there's no replay to wait for (a time-out), or the replay never came. */
const NEXT_AFTER_TIME_MS = 2000;
const NEXT_REPLAY_BACKSTOP_MS = 12_000;

/** One id per tab for the matchmaker (it prefers a new opponent over the last one). */
const playerId = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ARENA_CENTER = new THREE.Vector3(0, 0.5, 0);
const ARENA_FLOOR = new THREE.Vector3(0, 0.01, 0);

/** What the player picked on the avatar screen. */
export type FighterChoice =
  | { kind: 'scan'; name: string; username?: string } // consented: scan + forge + save under their username
  | { kind: 'masked'; name: string } // declined: masked mystery fighter, no scan
  | { kind: 'existing'; fighter: ForgedFighter };

/**
 * Host-side orchestrator. Wires the pipeline and runs the phase state machine:
 *
 *   InputHub -> IntentReader (per player) -> FightEngine -> FighterView / Effects / store
 *
 *   lobby --(both ready)--> countdown --> fighting --(K.O.)--> ko --(rematch)--> countdown
 *
 * Only the host runs the fight. A client laptop hands off to ClientSession, which just scans + streams.
 */
export class Game {
  readonly renderer: Renderer;
  readonly input = new InputHub();
  private readonly fight = new FightEngine({ damageScale: config.demo ? 1.6 : 1 });
  /** Intent + fight state -> the move that happens (lunges, knee vs kick, punishing a duck...). */
  private readonly resolver = new Resolver();
  private readonly effects: Effects;
  private readonly views: Record<PlayerId, FighterView>;
  private readonly intent: Record<PlayerId, IntentReader>;
  /** CPU opponents by slot: they play through the same engine commands and stance a player's reader produces. */
  private readonly cpu: Partial<Record<PlayerId, Brain>> = {};
  private fightTicks = 0;
  /** "Fight now" while a forge runs: ends the wait early (the forged fighter swaps in when it's done). */
  private readonly skipForge: Partial<Record<PlayerId, () => void>> = {};
  /** Ends the running local body scan early (set while one runs). */
  private skipScanNow: (() => void) | null = null;
  /** Bumped per setup, so a late forge never swaps into a slot that has since picked someone else. */
  private readonly setupGen: Record<PlayerId, number> = { p1: 0, p2: 0 };
  /** Practice mode: the CPU level to bring in for P2 once the local player is ready ('dummy' = Training). */
  private practiceLevel: CpuLevel | 'dummy' | null = null;
  /** The CPU's fighter, picked ahead with its model downloading (prepareCpu), so the CPU spawns as soon as it's in. */
  private cpuRoster: Promise<ForgedFighter[]> | null = null;
  private cpuPick: { opponent: string; fighter: Promise<ForgedFighter | undefined> } | null = null;
  /** Seconds left in the round (the store shows it rounded up). */
  private clock = ROUND;
  private hostSession: HostSession | null = null;
  private client: ClientSession | null = null;
  /** A screen that only watches a hosted room (spectate). */
  private spectator: SpectatorSession | null = null;
  /** Host: P2's moves as read on the client laptop (newer clients read their own camera), waiting for the tick. */
  private remoteIntents: Intent[] = [];
  private remoteStance: { stance: Stance; at: number } | null = null;
  /** Host: each slot's fighter, for the client laptop's copy of the fight; and what to tell it this tick. */
  private readonly fighters: Partial<Record<PlayerId, ForgedFighter>> = {};
  private outbox: MirrorEvent[] = [];
  /** Alternates, so watching screens get every other frame. */
  private castTick = 0;
  /** Client: the host's latest fight frame, and which fighter models are showing. */
  private mirrored: MirrorFrame | null = null;
  private readonly mirrorShown: Partial<Record<PlayerId, string>> = {};
  readonly sfx = new Sfx();
  /** Shouted barks and the crowd (pre-made clips; silent until they're generated). */
  readonly announcer = new Announcer();
  private readonly fireballs: Fireballs;
  /** The fighters' entrances before round 1 (both laptops; ui/Walkout.tsx draws its titles from it). */
  readonly walkout: Walkout;
  /** Each fighter's phase last tick, to hear a strike come out (whoosh) on both laptops. */
  private readonly heardPhase: Partial<Record<PlayerId, string>> = {};
  private readonly unsubscribe: () => void;
  private readonly unwatchScreen: () => void;
  private readonly linkTimer: ReturnType<typeof setInterval>;
  /** Real matches recorded for improving the move reader (host only, when turned on). */
  private readonly recorder = new MatchRecorder();
  /** The commentators: the host decides what they say (and tells the client laptop); both laptops voice it. */
  readonly commentary = new Commentary();
  private lastCall = 0;
  private firstCalled = false;
  private dangerCalled: Partial<Record<PlayerId, boolean>> = {};
  /** Combo counting and the round's first hit (both laptops count from the same hit events). */
  private combo = { player: null as PlayerId | null, hits: 0, at: 0, key: 0 };
  /**
   * K.O. replay: the last few seconds as drawn (both laptops record what they show), played back slowly from a
   * sweeping camera once the K.O. has landed. `tickEvents` collects this tick's moments for the recording.
   */
  private history: ReplayFrame[] = [];
  private tickEvents: MirrorEvent[] = [];
  private replay: { frames: ReplayFrame[]; pos: number; drawn: number; hold: number } | null = null;
  /** Seconds of game time until the replay starts (counts after the K.O. freeze), or -1. */
  private replayIn = -1;
  /** Records the replay as a highlight for the title screen's reel (the laptop running the fight only). */
  private readonly highlight = new HighlightRecorder();
  private firstHitDone = false;
  private accumulator = 0;
  private phaseTimer = 0;
  /** Aborted on dispose: stops in-flight scans and forge polling (HMR / unmount), so no camera is left running. */
  private readonly lifetime = new AbortController();
  /** The two players see each other's camera; "Hide my camera" stops both ways. */
  private readonly cam = new CameraShare();
  /** Test hook: a camera stream to share when the local input has none (the mock input in dev and tests). */
  cameraOverride: MediaStream | null = null;
  /**
   * "Find a fight": this tab's matchmaker id, the fighter picked once and kept for every opponent (as host it's set up
   * as P1; as client it's sent as a pick), and the camera, kept running as the role flips between host and client.
   * `gen` is bumped per search / join / rehost, so a stale one gives way.
   */
  private quick: { player: string; choice: FighterChoice | null; camera: InputSource | null; gen: number } | null = null;
  /** Host: rematch votes after a K.O. (both must; a CPU or test player always does), and the auto-next deadline. */
  private votes: Record<PlayerId, boolean> = NO_VOTES;
  private nextAt: number | null = null;
  private koAt = 0;
  private replayEndedAt: number | null = null;
  /** Slots driven by addTestPlayer (dev): nobody there to click Rematch. */
  private readonly testSlots = new Set<PlayerId>();

  constructor(container: HTMLElement) {
    this.renderer = new Renderer(container);
    this.effects = new Effects(this.renderer.scene, this.renderer.camera);
    this.fireballs = new Fireballs(this.renderer.scene);
    this.views = { p1: new FighterView('p1'), p2: new FighterView('p2') };
    this.intent = { p1: new IntentReader('p1'), p2: new IntentReader('p2') };
    for (const v of Object.values(this.views)) this.renderer.scene.add(v.root);

    this.walkout = new Walkout(this.renderer, this.effects, this.views, this.announcer, this.sfx, () => this.skipWalkout());
    this.renderer.onFrame(this.update);
    // Render quality steps down when this laptop's pose tracker starves (QualityGovernor).
    this.renderer.watchPose(() => poseRateOf(this.localInputSource()), (on) => setOnePose(this.localInputSource(), on));
    // The title, fighter select and the client's waiting screen are opaque: the scene behind them barely draws.
    const covered = (screen: string) => screen === 'title' || screen === 'avatar' || screen === 'client';
    this.renderer.covered = covered(useGameStore.getState().screen);
    this.unwatchScreen = useGameStore.subscribe((s) => (this.renderer.covered = covered(s.screen)));
    this.renderer.start();
    if (this.renderer.perf) this.exposePerf(this.renderer.perf);
    // The camera's downloads (MediaPipe + pose model, ~13 MB) start under the title screen, not on "Fight as".
    setTimeout(preloadLocalInput, 300);
    window.addEventListener('keydown', this.onDebugKey);
    window.addEventListener('keydown', this.onMuteKey);
    // Countdown beeps, then the "go" (both laptops: the client's store follows the host's countdown).
    this.unsubscribe = useGameStore.subscribe((s, prev) => {
      if (prev.phase === 'ko' && s.phase !== 'ko' && (s.votes !== NO_VOTES || s.nextAt !== null)) {
        this.votes = NO_VOTES;
        this.nextAt = null;
        useGameStore.setState({ votes: NO_VOTES, nextAt: null });
      }
      if (s.phase === 'ko' && prev.phase !== 'ko') {
        if (!this.mirroring) this.startVotes(s.ending);
        void this.recorder.stop({ winner: s.winner, ending: s.ending });
        this.announceFinish(s.winner, s.ending);
        if (!this.mirroring) {
          // The CPU wears someone else's fighter: only human sides get a record.
          recordMatch({ p1: this.cpu.p1 ? undefined : this.fighters.p1, p2: this.cpu.p2 ? undefined : this.fighters.p2 }, s.winner);
          this.callFinish(s.winner, s.ending);
        }
      }
      if (s.countdown === prev.countdown || s.countdown === null) return;
      if (s.countdown === 0) this.sfx.play('go'); // the walkout and ROUND 1 bring their own sound
      if (s.countdown === COUNTDOWN_FROM) this.announcer.crowd('murmur', 0.35);
      if (s.countdown === 0) {
        this.announcer.bark('fight', true);
        this.announcer.crowd('cheer', 0.4);
      }
      // A new round: forget the last one's combos and first hit.
      if (s.countdown === 0 && !this.mirroring && recordingEnabled()) this.startRecording();
      if (s.countdown === COUNTDOWN_FROM) {
        this.commentary.hush();
        this.firstCalled = false;
        this.dangerCalled = {};
        if (!this.mirroring) this.callIntro();
        this.stopReplay();
        this.firstHitDone = false;
        this.combo.player = null;
        useGameStore.setState({ combo: null, callout: null });
      }
    });
    for (const id of PLAYER_IDS) this.views[id].onLand = (at) => this.effects.burst(at, 'dust');
    // Ping: how the link between the two laptops is doing, every couple of seconds.
    this.linkTimer = setInterval(() => void this.pollLink(), 2000);
  }

  /** `?perf`: the pose model's timing on the overlay, and the game for scripted measurements (scripts/perf). */
  private exposePerf(perf: NonNullable<Renderer['perf']>) {
    perf.extra = () => {
      const g = this.renderer.governor;
      const pose = poseRateOf(this.localInputSource());
      const poses = pose ? `  pose ${pose.detectFps.toFixed(0)}/${pose.cameraFps.toFixed(0)} fps ${pose.detectMs.toFixed(0)} ms` : '';
      return `quality ${g.level}${g.pinned ? ' (pinned)' : ''}${poses}`;
    };
    (window as unknown as { __brawl: unknown }).__brawl = { game: this, store: useGameStore, perf };
  }

  /** Current local camera or mock source, for the development pose monitor. */
  localInputSource() {
    const { role } = useGameStore.getState();
    return role === 'client'
      ? this.client?.inputSource ?? null
      : this.input.source(localPlayerId(role));
  }

  /**
   * Title screen: "Host". Opens a room on the signaling server and shows its code. When the client
   * laptop connects, HostSession streams its poses into p2 and sets p2 up from what it sends.
   */
  async host() {
    const session = this.openHost();
    const code = await session.open();
    useGameStore.setState({ role: 'host', roomCode: code || null, screen: 'avatar' });
  }

  /** A fresh HostSession (closing any old one). `quick`: "Find a fight", waiting for a stranger. */
  private openHost(quick?: string) {
    this.hostSession?.dispose();
    const mine = () => this.hostSession === session;
    const session: HostSession = new HostSession(this.input, (choice, source, scan) => this.setupPlayer('p2', choice, source, scan), {
      rematch: () => this.vote('p2'),
      connected: () => {
        if (!mine()) return;
        if (this.quick) useGameStore.setState({ searching: false });
        this.cam.connected();
        this.sendMatch();
        if (useGameStore.getState().phase === 'ko') this.publishVotes();
      },
      skip: () => this.skipForgeWait('p2'),
      watched: () => this.sendMatch(),
      left: () => {
        if (!mine()) return;
        this.releaseRemote();
        this.cam.connected(); // nobody to hide from: back to defaults
        // Matchmade: the stranger's gone, find the next one.
        if (this.quick) setTimeout(() => mine() && void this.search(), 0);
      },
      quickJoin: (code) => mine() && void this.joinQuick(code),
      cam: (hidden) => mine() && this.cam.remoteHidden(hidden),
      read: (intents, stance) => {
        this.remoteIntents.push(...intents);
        this.remoteStance = { stance: { ...stance, player: 'p2' }, at: performance.now() };
      },
    }, quick);
    this.hostSession = session;
    this.cam.attach(session.peer, (hidden) => session.send({ type: 'cam', hidden }));
    return session;
  }

  /**
   * Title screen: "Find a fight". Pick or scan a fighter (once: it's kept for every opponent), then the matchmaker
   * pairs this laptop with a stranger: one waits as the host, the other joins it like Connect does.
   */
  findFight() {
    this.quick = { player: playerId(), choice: null, camera: null, gen: 0 };
    useGameStore.setState({ quick: true, role: 'host', roomCode: null, screen: 'avatar' });
  }

  /** Matchmaking: look for an opponent (P1 is set up on this laptop). Waits as a host unless someone's waiting. */
  private async search() {
    const q = this.quick;
    if (!q || this.client) return;
    const gen = ++q.gen;
    useGameStore.setState({ searching: true, connection: null, roomCode: null });
    const session = this.openHost(q.player);
    await session.open();
    if (gen !== q.gen) return;
  }

  /** Matchmaking: the server sent us to a waiting player. This laptop becomes the client; fighter and camera come along. */
  private async joinQuick(code: string) {
    const q = this.quick;
    if (!q?.choice) return;
    const gen = ++q.gen;
    const camera = q.camera ?? this.input.source('p1') ?? null;
    this.hostSession?.dispose();
    this.hostSession = null;
    this.cam.attach(null, null);
    this.input.unassign('p1'); // the camera keeps running: the ClientSession streams it now
    this.clearMatch();
    useGameStore.setState({ role: 'client', roomCode: code, searching: false, screen: 'game' });
    const client = this.newClient(code, { source: camera ?? undefined, player: q.player, quick: true });
    this.client = client;
    try {
      await client.connect();
    } catch (err) {
      console.warn('[quick] could not join the waiting player, searching again', err);
      if (gen === q.gen) void this.rehost();
      return;
    }
    if (gen !== q.gen || this.client !== client) return client.dispose();
    await client.choose(q.choice);
  }

  /** Matchmaking, on the client laptop: the opponent left (or we did). Back to hosting P1 here, then search again. */
  private async rehost() {
    const q = this.quick;
    if (!q?.choice) return;
    ++q.gen;
    const client = this.client;
    this.client = null;
    client?.dispose();
    this.cam.attach(null, null);
    this.clearMatch();
    useGameStore.setState({ role: 'host', roomCode: null, connection: null, searching: true, screen: 'game' });
    q.camera ??= createLocalSource();
    // setupPlayer starts the search once P1 is ready again.
    await this.setupPlayer('p1', q.choice, q.camera);
  }

  /**
   * Matchmaking: "Next" on the K.O. screen (or nobody voted in time). Both go find someone new: the host tells the
   * client, which searches again on its own.
   */
  nextOpponent() {
    if (!this.quick) return;
    if (this.client) {
      this.client.leave();
      void this.rehost();
      return;
    }
    const session = this.hostSession;
    session?.send({ type: 'next' });
    // A moment for 'next' to go out before the connection closes.
    setTimeout(() => {
      if (this.hostSession !== session || this.client) return;
      this.releaseRemote();
      void this.search();
    }, 150);
  }

  /** Matchmaking: forget the last match (fight, both slots, the mirror) before the next one. P1's camera stays on. */
  private clearMatch() {
    this.stopReplay();
    this.fight.reset();
    this.fightTicks = 0;
    for (const id of PLAYER_IDS) {
      ++this.setupGen[id];
      delete this.cpu[id];
      delete this.skipForge[id];
      delete this.fighters[id];
      delete this.mirrorShown[id];
      this.views[id].reset();
      this.views[id].setVisible(false);
      updatePlayer(id, { name: PLAYER_NAMES[id], status: 'waiting', statusDetail: '', portraitUrl: null, forge: null, hp: MAX_HP, meter: 0 });
    }
    this.input.unassign('p2');
    this.mirrored = null;
    this.remoteIntents = [];
    this.remoteStance = null;
    this.votes = NO_VOTES;
    this.nextAt = null;
    useGameStore.setState({
      phase: 'lobby', countdown: null, winner: null, ending: null, timeLeft: null, combo: null, callout: null, replay: false,
      link: null, votes: NO_VOTES, nextAt: null, lastMove: null,
    });
  }

  /** The client side of a link to a host (Connect or matchmaking): it mirrors the host's fight here. */
  private newClient(code: string, opts: ClientOptions = {}) {
    const mine = () => this.client === client;
    const mirror: ClientMirror = {
      match: (players) => mine() && this.mirrorMatch(players),
      frame: (frame) => mine() && (this.mirrored = frame),
      events: (events) => mine() && this.mirrorEvents(events),
      local: (intents) => mine() && this.localRead(intents),
      peer: (peer) => {
        this.cam.attach(peer, (hidden) => client.sendCam(hidden));
        this.cam.connected();
      },
      cam: (hidden) => mine() && this.cam.remoteHidden(hidden),
      votes: (votes, nextIn) => mine() && useGameStore.setState({ votes, nextAt: nextIn === null ? null : performance.now() + nextIn }),
      next: () => mine() && void this.rehost(),
      lost: () => mine() && void this.rehost(),
    };
    const client: ClientSession = new ClientSession(code, mirror, opts);
    return client;
  }

  /** Title screen: "Practice". Hosts as usual (a friend can still join), and P2 is a CPU once P1 is ready. */
  async practice(level: CpuLevel | 'dummy' = 'normal') {
    this.practiceLevel = level;
    useGameStore.setState({ training: level === 'dummy' });
    this.prepareCpu();
    await this.host();
  }

  /** Title screen: "Connect" with a room code. */
  async join(code: string) {
    if (config.signalUrl) {
      const client = this.newClient(code);
      this.client = client;
      try {
        await client.connect();
      } catch (err) {
        this.client = null;
        throw err;
      }
    } else {
      console.warn('VITE_SIGNAL_URL not set: the client flow runs offline on this laptop');
    }
    useGameStore.setState({ role: 'client', roomCode: code, screen: 'avatar' });
  }

  /**
   * Title screen: "Watch" (spectate). This screen shows a hosted room's fight with no camera and no player of its own:
   * a TV or a third laptop next to the two players. Throws the server's message for a bad code.
   */
  watch(code: string): Promise<void> {
    // One watch at a time (a double tap, or React running the ?watch= effect twice in dev); a failed one can retry.
    this.watchStart ??= this.startWatching(code).catch((err) => {
      this.watchStart = null;
      throw err;
    });
    return this.watchStart;
  }

  private watchStart: Promise<void> | null = null;

  private async startWatching(code: string) {
    const session = new SpectatorSession(code.toUpperCase(), {
      match: (players) => this.mirrorMatch(players),
      frame: (frame) => (this.mirrored = frame),
      events: (events) => this.mirrorEvents(events),
    });
    await session.connect();
    this.spectator = session;
    useGameStore.setState({ role: 'spectator', roomCode: session.code, connection: 'open', screen: 'game' });
  }

  /** This laptop draws someone else's fight (the client laptop, or a watching screen) instead of running one. */
  private get mirroring() {
    return this.client !== null || this.spectator !== null;
  }

  /** Avatar screen: the player on THIS laptop scanned, went masked, or picked a saved fighter. */
  async chooseFighter(choice: FighterChoice) {
    if (choice.kind === 'existing') preloadModel(choice.fighter.glbUrl, 'high')?.catch(() => {});
    const { role } = useGameStore.getState();
    useGameStore.setState({ screen: role === 'client' ? 'client' : 'game' });
    // A connected client only scans + streams; the host forges and runs the fight.
    if (this.client) return this.client.choose(choice);
    // Host, or a client with no signaling server (offline dev): set the player up here.
    await this.setupPlayer(localPlayerId(role), choice);
  }

  /** Dev only: fill a slot with a house fighter driven by a MockSource. */
  addTestPlayer(id: PlayerId) {
    this.testSlots.add(id);
    return this.setupPlayer(id, { kind: 'existing', fighter: { id: 'test', name: PLAYER_NAMES[id], status: 'ready' } }, new MockSource());
  }

  /**
   * Fill a slot with a CPU opponent. It borrows a forged fighter from the server (not the one it's fighting), or
   * the house model without one. A client joining from another laptop takes the slot back (setupPlayer).
   */
  async addCpuPlayer(id: PlayerId, level: CpuLevel | 'dummy' = 'normal') {
    updatePlayer(id, { name: 'CPU', status: 'forging', statusDetail: 'Picking a fighter' });
    const opponent = useGameStore.getState().players[opponentOf(id)].name;
    this.prepareCpu(opponent);
    const pick = await this.cpuPick!.fighter;
    // The next CPU gets a fresh list and pick.
    this.cpuRoster = null;
    this.cpuPick = null;
    const fighter: ForgedFighter = pick ?? { id: 'cpu', name: 'Sparring Bot', status: 'ready', glbUrl: `${import.meta.env.BASE_URL}models/default.glb` };
    this.input.unassign(id);
    this.cpu[id] = level === 'dummy' ? new Dummy(id) : new Cpu(id, level, Math.floor(Math.random() * 1e6));
    try {
      await this.views[id].setFighter(fighter);
    } catch (err) {
      console.warn('cpu fighter failed to load, using the placeholder', err);
      await this.views[id].setFighter({ id: 'cpu', name: 'Sparring Bot', status: 'ready' });
    }
    this.spawn(id);
    const label = level === 'normal' ? 'CPU' : `CPU ${level}`;
    const shown = level === 'dummy' ? 'Training dummy' : `${fighter.name} (${label})`;
    updatePlayer(id, { name: shown, status: 'ready', statusDetail: '', portraitUrl: fighter.cardUrl ?? null });
    this.fighters[id] = fighter;
    this.sendMatch();
    const { players } = useGameStore.getState();
    if (PLAYER_IDS.every((p) => players[p].status === 'ready')) this.startCountdown();
  }

  /**
   * Pick the CPU's fighter ahead and start downloading its model (low priority), so it spawns as soon as it's called
   * in. The server's list is fetched once; the pick waits until the opponent is known (it never wears theirs).
   */
  private prepareCpu(opponent?: string) {
    this.cpuRoster ??= fetchServerFighters(undefined, 10_000);
    if (opponent === undefined || this.cpuPick?.opponent === opponent.toLowerCase()) return;
    const against = opponent.toLowerCase();
    const fighter = this.cpuRoster.then((all) => {
      // The server lists newest first: the CPU wears one of the recent (new-style) fighters.
      const recent = all.filter((f) => f.glbUrl && f.name.toLowerCase() !== against).slice(0, 6);
      const pick = recent[Math.floor(Math.random() * recent.length)];
      preloadModel(pick?.glbUrl)?.catch(() => {});
      return pick;
    });
    this.cpuPick = { opponent: against, fighter };
  }

  /** A fighter arrives: it prints in out of a beam of light in its player's color. */
  private spawn(id: PlayerId) {
    // A model that finishes loading mid-walkout (the client laptop loading the host's pick) joins its shots instead.
    if (this.walkout.active) return this.walkout.adopt(id);
    this.views[id].setVisible(true);
    this.views[id].materialize();
    this.sfx.play('spawn');
    this.effects.burst(this.views[id].root.position, 'spawn', PLAYER_COLORS[id]);
  }

  /** Any key or click during the walkout (host): straight to ROUND 1. The client laptop follows the countdown. */
  private skipWalkout() {
    const { phase, countdown } = useGameStore.getState();
    if (this.mirroring || phase !== 'countdown' || countdown !== COUNTDOWN_FROM) return;
    this.phaseTimer = Infinity;
  }

  /** The local player chose not to wait for their forge (see setupPlayer). */
  /**
   * The guided body scan on this laptop's camera: its live state goes to the store for the scan overlay, and
   * "Done: forge with the front photo" (skipScan) ends it early.
   */
  private async localScan(source: InputSource, show: (text: string) => void, signal: AbortSignal, current: () => boolean): Promise<ScanFrames> {
    const skip = new AbortController();
    this.skipScanNow = () => skip.abort();
    try {
      return await captureScan(source.video, source, (u) => {
        if (!current()) return;
        show(scanStatus(u.view));
        useGameStore.setState({ scan: { view: u.view, thumbs: u.thumbs } });
      }, { signal, skip: skip.signal });
    } finally {
      this.skipScanNow = null;
      useGameStore.setState({ scan: null });
    }
  }

  /** The scan overlay's "Done: forge with the front photo" (Enter): forge from what the scan has so far. */
  skipScan() {
    if (this.client) return this.client.skipScan();
    this.skipScanNow?.();
  }

  skipForgeWait(id: PlayerId) {
    if (this.client) return this.client.skipForge();
    this.skipForge[id]?.();
  }

  /** A forge that finished after its player went ahead with a stand-in: swap the real fighter in, with the beam. */
  private async arriveLate(id: PlayerId, gen: number, fighter: ForgedFighter) {
    if (fighter.status !== 'ready') return console.warn('forge failed, keeping the stand-in:', fighter.error);
    saveFighter(fighter);
    if (this.quick && id === 'p1') this.keepFighter({ kind: 'existing', fighter }, fighter);
    if (gen !== this.setupGen[id] || useGameStore.getState().players[id].status !== 'ready') return;
    await this.loadFighter(id, fighter);
    this.spawn(id);
    updatePlayer(id, { portraitUrl: fighter.cardUrl ?? null });
    this.fighters[id] = fighter;
    this.sendMatch();
    useGameStore.setState({ callout: { text: 'Fighter forged!', key: performance.now() } });
  }

  /** Secret debug menu: fire an effect in the middle of the arena, optionally with hit-stop + shake. */
  debugBurst(kind: EffectKind, impact = false) {
    // Spawn is a ground effect (it fires at a fighter's feet in play).
    this.effects.burst(kind === 'spawn' ? ARENA_FLOOR : ARENA_CENTER, kind);
    if (!impact) return;
    this.renderer.freeze(kind === 'ko' ? KO_FREEZE : kind === 'counter' ? 0.2 : 0.08);
    if (kind === 'counter' || kind === 'ko') this.renderer.shake(0.04);
  }

  /**
   * Start a player's input source, get their fighter (scan + forge, masked, or saved), spawn them.
   * `scan`: frames captured on another laptop (P2's client), instead of scanning on `source` here.
   */
  private async setupPlayer(id: PlayerId, choice: FighterChoice, source: InputSource = createLocalSource(), scan?: Promise<ScanFrames>) {
    const name = choice.kind === 'existing' ? choice.fighter.name : choice.name;
    delete this.cpu[id]; // a real player takes the slot
    if (choice.kind !== 'existing' || choice.fighter.id !== 'test') this.testSlots.delete(id);
    const gen = ++this.setupGen[id];
    // A saved fighter's model downloads while the camera starts, instead of after; in practice, the CPU's too.
    if (choice.kind === 'existing') preloadModel(choice.fighter.glbUrl, 'high')?.catch(() => {});
    if (this.practiceLevel && id === 'p1') this.prepareCpu(name);
    try {
      updatePlayer(id, { name, status: 'scanning', statusDetail: 'Starting camera' });
      await source.start();
      this.lifetime.signal.throwIfAborted();
      this.input.assign(id, source);

      let fighter: ForgedFighter;
      let revealGlb: string | null = null;
      if (choice.kind === 'scan') {
        // Don't make them turn around for 20 s just to hear the forge is full.
        const busy = scan ? null : await forgeBusy();
        if (busy) throw new Error(`the forge can't take a new scan right now (${busy}). Pick a saved fighter, go masked, or try again in a minute`);
        const show = onChange((statusDetail) => gen === this.setupGen[id] && updatePlayer(id, { statusDetail }));
        show('Face the camera');
        const { signal } = this.lifetime;
        const frames = await (scan ?? this.localScan(source, show, signal, () => gen === this.setupGen[id]));
        // Say what the scan got: a partial scan still forges, the missing sides are filled in.
        const got = frames.filter(Boolean).length;
        updatePlayer(id, { status: 'forging', statusDetail: got === 1 && frames[0] ? 'Forging from your front photo' : got < 3 ? `Got ${got} of 3 sides, forging anyway` : 'Forging fighter' });
        // The fighter goes by the player's username; the brief's playful nickname stays in brief.name for flavor.
        // Show the design (card, else the sheet) as soon as it exists: the 3D model takes another minute or so.
        // ...and the live preview: the brief typing out, the sheet developing, the voxels and clay from the GPU box.
        const preview = (f: ForgedFighter) => {
          if (gen !== this.setupGen[id]) return;
          const art = f.cardUrl ?? f.sheetUrl ?? null;
          const current = useGameStore.getState().players[id];
          if (art && art !== current.portraitUrl) updatePlayer(id, { portraitUrl: art });
          const forge = forgePreview(f);
          if (!samePreview(forge, current.forge)) updatePlayer(id, { forge });
        };
        const forging = forgeFighter(name, frames, (f) => (show(forgeStatus(f)), preview(f)), { username: choice.username, signal });
        const skipped = new Promise<null>((resolve) => (this.skipForge[id] = () => resolve(null)));
        const done = await Promise.race([forging, skipped]);
        delete this.skipForge[id];
        if (done) {
          fighter = done;
          if (done.status === 'ready' && done.glbUrl) revealGlb = done.glbUrl;
          if (fighter.status === 'ready') saveFighter(fighter); // they said yes to "save fighter to memory card"
          // A failed forge still fights: no glbUrl means the default model (SPEC fallback ladder).
          else console.warn('forge failed, using the default fighter:', fighter.error);
        } else {
          // Fight now as a stand-in; the forged fighter materializes in when it's ready (even mid-round).
          fighter = { id: `stand-in-${id}`, name, status: 'ready', glbUrl: `${import.meta.env.BASE_URL}models/default.glb` };
          forging.then((f) => this.arriveLate(id, gen, f)).catch((err) => console.warn('background forge failed, keeping the stand-in:', err));
        }
      } else if (choice.kind === 'masked') {
        fighter = maskedFighter(name);
      } else {
        fighter = choice.fighter;
      }
      // A fresh forge shows itself off in the forging card (textured, then the rig flashes) while its model loads.
      const forge = useGameStore.getState().players[id].forge;
      const reveal = revealGlb && forge ? (updatePlayer(id, { forge: { ...forge, glbUrl: revealGlb } }), wait(REVEAL_MS)) : null;
      if (gen !== this.setupGen[id]) return; // the player left (or chose again) while it forged
      await Promise.all([this.loadFighter(id, fighter), reveal]);
      this.lifetime.signal.throwIfAborted();
      if (gen !== this.setupGen[id]) return;

      this.spawn(id);
      updatePlayer(id, { status: 'ready', statusDetail: '', portraitUrl: fighter.cardUrl ?? null, forge: null });
      this.fighters[id] = fighter;
      this.sendMatch();
      // Matchmaking: this fighter is the player's for every opponent from now on; go find the first (or next) one.
      if (this.quick && id === 'p1' && !this.client) {
        this.keepFighter(choice, fighter);
        this.quick.camera = source;
        if (!this.hostSession && useGameStore.getState().players.p2.status === 'waiting') return void this.search();
      }
      // Practice: bring in the CPU as soon as the player is set (unless someone's already in P2).
      const p2 = useGameStore.getState().players.p2;
      if (this.practiceLevel && id === 'p1' && p2.status === 'waiting') return void this.addCpuPlayer('p2', this.practiceLevel);
      // Hosting with nobody in yet: the lobby offers "Fight the CPU", so have its fighter ready.
      if (id === 'p1' && p2.status === 'waiting' && !this.quick) this.prepareCpu(name);

      const { players } = useGameStore.getState();
      if (PLAYER_IDS.every((p) => players[p].status === 'ready')) this.startCountdown();
    } catch (err) {
      if (gen !== this.setupGen[id]) return; // superseded: the slot belongs to someone (or no one) else now
      this.input.unassign(id);
      source.stop();
      if (this.lifetime.signal.aborted) return; // disposed mid-setup: nothing left to show
      console.error(err);
      // Say what actually broke (camera denied, nobody in view, forge down...), not just "something".
      const reason = err instanceof Error ? err.message : String(err);
      updatePlayer(id, { status: 'waiting', statusDetail: `Couldn't set up your fighter: ${reason}`, forge: null });
      const { role } = useGameStore.getState();
      if (id === localPlayerId(role)) useGameStore.setState({ screen: 'avatar' });
    }
  }

  /** Show the fighter's model. A GLB that won't load (gone, unreachable, corrupt) still fights, as the default model. */
  private async loadFighter(id: PlayerId, fighter: ForgedFighter) {
    try {
      await this.views[id].setFighter(fighter);
    } catch (err) {
      console.warn(`fighter model ${fighter.glbUrl} failed to load, using the default fighter:`, err);
      await this.views[id].setFighter({ ...fighter, glbUrl: undefined });
    }
  }

  /**
   * Matchmaking: what to bring to the next opponent. A forged or saved fighter goes by its id (a pick, when this laptop
   * is the client next time); a masked one stays masked; a stand-in (its forge still running) goes masked by name.
   */
  private keepFighter(choice: FighterChoice, fighter: ForgedFighter) {
    if (!this.quick) return;
    const masked = choice.kind === 'masked' || fighter.id.startsWith('stand-in-') || fighter.status !== 'ready';
    this.quick.choice = masked ? { kind: 'masked', name: fighter.name } : { kind: 'existing', fighter: { ...fighter, brief: undefined } };
  }

  /** K.O. screen "Rematch": a vote. The rematch starts once both players have voted (the host counts them). */
  voteRematch() {
    if (this.spectator) return;
    if (this.client) {
      this.client.requestRematch();
      useGameStore.setState((s) => ({ votes: { ...s.votes, p2: true } }));
      return;
    }
    this.vote(localPlayerId(useGameStore.getState().role));
  }

  /** Host: a K.O. or time-out. Fresh votes (a CPU or test player votes yes at once); matchmade fights get a countdown. */
  private startVotes(ending: 'ko' | 'time' | null) {
    this.votes = { p1: !!this.cpu.p1 || this.testSlots.has('p1'), p2: !!this.cpu.p2 || this.testSlots.has('p2') };
    this.nextAt = null;
    this.koAt = performance.now();
    this.replayEndedAt = ending === 'time' ? this.koAt + NEXT_AFTER_TIME_MS : null;
    this.publishVotes();
  }

  private vote(id: PlayerId) {
    if (this.mirroring || useGameStore.getState().phase !== 'ko' || this.votes[id]) return;
    this.votes = { ...this.votes, [id]: true };
    if (this.votes.p1 && this.votes.p2) return this.rematch();
    this.publishVotes();
  }

  /** Host: the votes and the countdown, here and on the client laptop. */
  private publishVotes() {
    useGameStore.setState({ votes: this.votes, nextAt: this.nextAt });
    const nextIn = this.nextAt === null ? null : Math.max(0, Math.round(this.nextAt - performance.now()));
    this.hostSession?.send({ type: 'votes', votes: this.votes, nextIn });
  }

  /** Host, matchmade fight on the K.O. screen: start the "next opponent" countdown, and go when it runs out. */
  private checkNext() {
    const { phase, quick } = useGameStore.getState();
    if (!quick || !this.quick || this.mirroring || phase !== 'ko' || !this.hostSession?.connected || this.cpu.p2) return;
    const now = performance.now();
    if (this.nextAt === null) {
      const shown = this.replayEndedAt ?? this.koAt + NEXT_REPLAY_BACKSTOP_MS;
      if (now < shown) return;
      this.nextAt = now + NEXT_MS;
      this.publishVotes();
    } else if (now >= this.nextAt) {
      this.nextAt = null;
      this.nextOpponent();
    }
  }

  /** Both voted: same two fighters again. */
  private rematch() {
    if (this.mirroring) return;
    this.votes = NO_VOTES;
    this.nextAt = null;
    this.stopReplay();
    this.fight.reset();
    this.fightTicks = 0;
    for (const id of PLAYER_IDS) {
      this.cpu[id]?.reset();
      this.views[id].reset();
    }
    for (const id of PLAYER_IDS) updatePlayer(id, { hp: MAX_HP });
    useGameStore.setState({ winner: null, ending: null });
    this.startCountdown();
  }

  dispose() {
    this.lifetime.abort();
    this.highlight.cancel();
    window.removeEventListener('keydown', this.onDebugKey);
    window.removeEventListener('keydown', this.onMuteKey);
    this.unsubscribe();
    this.unwatchScreen();
    clearInterval(this.linkTimer);
    this.hostSession?.dispose();
    this.client?.dispose();
    this.spectator?.dispose();
    this.cam.dispose();
    this.quick?.camera?.stop();
    for (const id of PLAYER_IDS) {
      this.input.source(id)?.stop(); // release the camera, not just the hub's subscription
      this.input.unassign(id);
    }
    for (const v of Object.values(this.views)) v.dispose();
    this.effects.dispose();
    this.fireballs.dispose();
    this.walkout.dispose();
    this.renderer.dispose();
  }

  private startCountdown() {
    this.phaseTimer = 0;
    this.clock = ROUND;
    useGameStore.setState({ phase: 'countdown', countdown: COUNTDOWN_FROM, timeLeft: ROUND, ending: null });
  }

  private update = (dt: number, frozen: boolean) => {
    this.effects.update(dt);
    const video = this.localInputSource()?.video?.srcObject;
    this.cam.camera(video instanceof MediaStream ? video : this.cameraOverride);
    this.checkNext();
    if (this.replayIn > 0 && !frozen && (this.replayIn -= dt) <= 0) {
      this.replayIn = -1;
      this.startReplay();
    }
    this.fireballs.update(dt);
    // The camera follows whoever's on stage.
    const shown = PLAYER_IDS.filter((id) => this.views[id].root.visible).map((id) => this.views[id].root.position.x);
    if (shown.length === 2) this.renderer.track((shown[0] + shown[1]) / 2, Math.abs(shown[0] - shown[1]));
    else this.renderer.track(0, 0.6); // lobby: keep the stage framed around the panels
    if (frozen) return;
    this.accumulator += dt;
    while (this.accumulator >= SIM_DT) {
      this.tick();
      this.accumulator -= SIM_DT;
    }
  };

  /** One fixed 60 Hz step. */
  private tick() {
    if (this.replay) return this.replayTick();
    if (this.mirroring) return this.mirrorTick();
    const { phase, countdown } = useGameStore.getState();
    this.phaseTimer += SIM_DT;

    // The first beat is the walkout, then ROUND 1, then FIGHT.
    if (phase === 'countdown' && this.phaseTimer >= (countdown === COUNTDOWN_FROM ? this.walkout.length : ROUND_CALL_SECONDS)) {
      this.phaseTimer = 0;
      const next = (countdown ?? 1) - 1;
      useGameStore.setState(next <= 0 ? { phase: 'fighting', countdown: 0 } : { countdown: next });
    }
    if (phase === 'fighting' && countdown === 0 && this.phaseTimer >= 0.8) {
      useGameStore.setState({ countdown: null });
    }

    // Input -> intent -> resolver -> fight engine. A CPU slot thinks instead, from the engine's state.
    const commands: Command[] = [];
    const stances = {} as Record<PlayerId, Stance>;
    for (const id of PLAYER_IDS) {
      const cpu = this.cpu[id];
      if (cpu) {
        const out = phase === 'fighting' ? cpu.think(this.fight, this.fightTicks) : null;
        if (out) commands.push(...out.commands);
        stances[id] = out?.stance ?? { player: id, guard: true, advance: 0, lean: { x: 0, y: 0 }, tracked: true };
        continue;
      }
      // P2 on a client laptop that reads its own moves: use what it sent (a full-rate local read, no network
      // jitter on the poses). Otherwise read the streamed poses here.
      const remote = id === 'p2' ? this.takeRemoteRead() : null;
      const frame = remote ? null : this.input.latest(id);
      const out = remote ?? (frame ? this.intent[id].update(frame) : null);
      if (out) {
        commands.push(...this.resolver.resolve(id, out.intents, this.fight));
        for (const i of out.intents) {
          if (i.kind !== 'cancel' || (i.limb !== 'armL' && i.limb !== 'armR')) continue;
          const hand = i.limb === 'armL' ? 'L' : 'R';
          this.views[id].cancelTell(hand);
          this.outbox.push({ kind: 'anticipate', player: id, hand, cancel: true });
        }
        this.recorder.intents(id, out.intents);
        const text = moveText(out.intents);
        if (text && id === localPlayerId(useGameStore.getState().role)) useGameStore.setState({ lastMove: { text, at: performance.now() } });
        else if (text) this.outbox.push({ kind: 'move', player: id, text });
      }
      stances[id] = out?.stance ?? { player: id, guard: true, advance: 0, lean: { x: 0, y: 0 }, tracked: false };
    }
    for (const c of commands) {
      if (c.kind !== 'anticipate') continue;
      this.views[c.player].anticipate(c.hand);
      this.outbox.push({ kind: 'anticipate', player: c.player, hand: c.hand });
      this.tickEvents.push({ kind: 'anticipate', player: c.player, hand: c.hand });
    }
    if (phase === 'fighting') {
      this.fightTicks++;
      for (const event of this.fight.step(commands, stances)) {
        this.recorder.event(event);
        this.applyEvent(event);
        this.react(event);
      }
      this.tickClock();
    }
    // Hit-stop: the picture holds on the impact while the engine does (effects and camera shake keep going).
    // (Only mid-round: the K.O. hit's hit-stop never runs out, since the engine stops stepping.)
    const frozen = useGameStore.getState().phase === 'fighting' && this.fight.frozen;
    for (const id of PLAYER_IDS) this.recorder.frame(id, this.cpu[id] ? null : this.input.latest(id));
    this.fireballs.sync(this.fight.projectiles());
    this.showMeters({ p1: this.fight.state('p1'), p2: this.fight.state('p2') });
    this.sendFrame(stances, frozen);
    this.record(
      { states: { p1: this.fight.state('p1'), p2: this.fight.state('p2') }, guard: { p1: stances.p1.guard, p2: stances.p2.guard }, distance: this.fight.distance(), frozen, timeLeft: null, projectiles: [...this.fight.projectiles()] },
      { p1: this.cpu.p1 ? null : this.input.latest('p1'), p2: this.cpu.p2 ? null : this.input.latest('p2') },
    );
    if (frozen) return;
    const distance = this.fight.distance();
    this.hearStrikes({ p1: this.fight.state('p1'), p2: this.fight.state('p2') });
    for (const id of PLAYER_IDS) {
      this.views[id].update({
        state: this.fight.state(id),
        live: this.cpu[id] ? null : this.input.latest(id),
        guard: stances[id].guard,
        distance,
        opponentKo: this.fight.state(opponentOf(id)).phase === 'ko',
        phase: useGameStore.getState().phase,
        dt: SIM_DT,
      });
    }
  }

  private startRecording() {
    const { players } = useGameStore.getState();
    const cam = this.input.source('p1') as { video?: HTMLVideoElement } | null;
    this.recorder.start(
      { p1: { name: players.p1.name, cpu: !!this.cpu.p1 }, p2: { name: players.p2.name, cpu: !!this.cpu.p2 } },
      (cam?.video?.srcObject as MediaStream | null) ?? null,
    );
  }

  private async pollLink() {
    const stats = this.hostSession?.connected ? await this.hostSession.peer.linkStats() : this.client ? await this.client.linkStats() : null;
    const prev = useGameStore.getState().link;
    if (stats?.rttMs !== prev?.rttMs || stats?.path !== prev?.path) useGameStore.setState({ link: stats });
  }

  /**
   * Back to fighter select for this laptop's player (keeps the room, the other player and a CPU). The client
   * laptop can only go back to the title: the host owns the match.
   */
  /** Back to the title screen (a fresh page). The client laptop tells the host first, so its slot opens up. */
  toTitle() {
    this.client?.leave();
    // A moment for the message to go out before the page (and its connection) goes away.
    window.setTimeout(() => window.location.reload(), this.client ? 150 : 0);
  }

  /** Host: P2's player left (went back to the title, or never came back). Free the slot so someone else can join. */
  private releaseRemote() {
    const id: PlayerId = 'p2';
    if (this.cpu[id]) return; // the CPU took the slot meanwhile
    ++this.setupGen[id]; // a setup still running for them (scan, forge) no longer applies
    delete this.skipForge[id];
    this.stopReplay();
    this.fight.reset();
    this.fightTicks = 0;
    for (const p of PLAYER_IDS) {
      this.views[p].reset();
      updatePlayer(p, { hp: MAX_HP, meter: 0 });
    }
    this.input.unassign(id);
    this.views[id].setVisible(false);
    delete this.fighters[id];
    updatePlayer(id, { name: PLAYER_NAMES[id], status: 'waiting', statusDetail: '', portraitUrl: null, forge: null });
    useGameStore.setState({ phase: 'lobby', countdown: null, winner: null, ending: null, timeLeft: null, combo: null, callout: null, connection: null });
    this.sendMatch();
  }

  changeFighter() {
    if (this.client || this.spectator) return void window.location.reload();
    const id = localPlayerId(useGameStore.getState().role);
    this.stopReplay();
    this.fight.reset();
    this.fightTicks = 0;
    for (const p of PLAYER_IDS) {
      this.cpu[p]?.reset();
      this.views[p].reset();
      updatePlayer(p, { hp: MAX_HP, meter: 0 });
    }
    this.input.source(id)?.stop();
    this.input.unassign(id);
    this.views[id].setVisible(false);
    delete this.fighters[id];
    updatePlayer(id, { status: 'waiting', statusDetail: '', portraitUrl: null, forge: null });
    useGameStore.setState({ phase: 'lobby', countdown: null, winner: null, ending: null, timeLeft: null, combo: null, callout: null, screen: 'avatar' });
    this.sendMatch();
  }

  /** Training: health never runs out and the meter stays full, so any move can be tried any time. */
  private refill() {
    for (const id of PLAYER_IDS) {
      const s = this.fight.state(id);
      if (s.hp < 40) {
        this.fight.heal(id);
        updatePlayer(id, { hp: MAX_HP });
      }
      if (!this.cpu[id] && (s.meter ?? 0) < 100) this.fight.fillMeter(id);
    }
  }

  /** Drop a pending or running K.O. replay (a rematch, a new round). */
  private stopReplay() {
    this.replayIn = -1;
    this.highlight.cancel();
    if (this.replay) this.endReplay();
    this.history = [];
  }

  /** The finish, shouted: K.O. (and PERFECT if the winner took no damage), TIME or DRAW, and the crowd erupts. */
  private announceFinish(winner: PlayerId | null, ending: string | null) {
    this.announcer.crowd('roar', 0.55);
    if (ending === 'time') this.announcer.bark(winner ? 'time' : 'draw', true);
    else this.announcer.bark('ko', true);
    const perfect = winner && useGameStore.getState().players[winner].hp >= MAX_HP;
    if (perfect) setTimeout(() => this.announcer.bark('perfect', true), 1400);
  }

  /** The client's latest read of P2, if it's been sending them (stale after a second: back to reading poses here). */
  private takeRemoteRead(): { intents: Intent[]; stance: Stance } | null {
    const r = this.remoteStance;
    if (!r || performance.now() - r.at > 1000) return null;
    const intents = this.remoteIntents;
    this.remoteIntents = [];
    // A stance that stopped arriving means the client lost its player: hold guard, untracked.
    const stale = performance.now() - r.at > 400;
    return { intents, stance: stale ? { ...r.stance, guard: true, advance: 0, tracked: false } : r.stance };
  }

  /** Client laptop: its own player's moves, read here, show on its own screen at once (the host's echo comes later). */
  private localRead(intents: Intent[]) {
    const id = localPlayerId('client');
    for (const i of intents) {
      if ((i.kind === 'anticipate' || i.kind === 'cancel') && (i.limb === 'armL' || i.limb === 'armR')) {
        const hand = i.limb === 'armL' ? 'L' : 'R';
        if (i.kind === 'anticipate') this.views[id].anticipate(hand);
        else this.views[id].cancelTell(hand);
      }
    }
    const text = moveText(intents);
    if (text) useGameStore.setState({ lastMove: { text, at: performance.now() } });
  }

  /** Round clock: when it runs out, more HP left wins (equal is a draw). Training has no clock. */
  private tickClock() {
    const { phase, training } = useGameStore.getState();
    if (phase !== 'fighting') return;
    if (training) return this.refill();
    this.clock -= SIM_DT;
    const shown = Math.max(0, Math.ceil(this.clock));
    if (shown !== useGameStore.getState().timeLeft) useGameStore.setState({ timeLeft: shown });
    if (this.clock > 0) return;
    const [a, b] = [this.fight.state('p1').hp, this.fight.state('p2').hp];
    useGameStore.setState({ phase: 'ko', ending: 'time', winner: a === b ? null : a > b ? 'p1' : 'p2', countdown: null });
  }

  /** Engine event -> HP in the store, hit-stop, effects, popups. */
  private applyEvent(event: FightEvent) {
    const { players, phase } = useGameStore.getState();
    if (phase !== 'fighting' || !event.damage) return;

    const defender = opponentOf(event.attacker);
    // TODO: once FightEngine is real, mirror FighterState.hp instead of subtracting here.
    const hp = Math.max(0, players[defender].hp - event.damage);
    updatePlayer(defender, { hp });
    const by = this.fight.state(event.attacker);
    const ko = hp <= 0;
    this.showHit(event, by, ko);
    this.outbox.push({ kind: 'fight', event, by, ko });
    this.tickEvents.push({ kind: 'fight', event, by, ko });
    if (ko) useGameStore.setState({ phase: 'ko', ending: 'ko', winner: event.attacker, countdown: null });
  }

  /** The look of a hit (both laptops): the reaction, sparks, impact frames, camera punch, popup, K.O. drama. */
  private showHit(event: FightEvent, by: Readonly<FighterState>, ko: boolean, replaying = false) {
    if (!event.damage) return;
    const defender = opponentOf(event.attacker);
    this.views[defender].onEvent(event, by);
    const point = this.views[defender].worldJoint(by.height === 'body' || event.move === 'knee' ? 'neck' : 'head');
    if (by.height === 'body' || event.move === 'knee') point.y -= 0.08;
    const heavy = event.type === 'counter' || event.damage >= 10;
    if (!replaying) this.countCombo(event, ko);
    if (!replaying && !ko && event.guardBreak) {
      useGameStore.setState({ callout: { text: 'Guard break', key: performance.now() } });
      this.announcer.crowd('ooh', 0.6);
    } else if (!replaying && !ko && event.type === 'counter') {
      this.announcer.bark('counter');
      this.announcer.crowd('ooh', 0.5);
    } else if (!replaying && !ko && heavy && event.type !== 'blocked') {
      this.announcer.crowd('ooh', 0.3);
    }
    this.sfx.play(ko ? 'ko' : event.type === 'blocked' ? 'blocked' : event.type === 'counter' ? 'counter' : heavy ? 'heavy' : 'hit');
    this.effects.burst(point, event.type === 'blocked' ? 'blocked' : event.type === 'counter' ? 'counter' : 'hit');
    // Punch: impact frames on the big ones, the camera leaning into the hit.
    if (!ko && event.type === 'counter') {
      if (config.impactFrames) this.renderer.impact(point, 0.08, '#ffc83a');
      this.renderer.punch(point, 0.22, 2.5);
    } else if (!ko && heavy && event.type !== 'blocked') {
      if (config.impactFrames) this.renderer.impact(point, 0.045);
      this.renderer.punch(point, 0.12, 3);
    } else if (event.type === 'blocked') {
      this.renderer.shake(0.012);
    } else {
      this.renderer.shake(0.018);
      this.renderer.punch(point, 0.05, 4);
    }
    pushPopup({
      ...this.renderer.project(point),
      label: event.type === 'blocked' ? 'BLOCKED' : event.type === 'counter' ? 'COUNTER!' : event.move.toUpperCase(),
      damage: Math.round(event.damage),
      kind: event.type === 'blocked' ? 'blocked' : heavy ? 'heavy' : 'light',
    });
    if (heavy) {
      this.renderer.shake(0.04);
      useGameStore.setState((s) => ({ flashKey: s.flashKey + 1 }));
    }
    if (ko) {
      if (!replaying) {
        this.renderer.freeze(KO_FREEZE);
        this.renderer.slowMotion(KO_FREEZE + 1.4, 0.3);
        // Then the replay of how it happened, once the slow-motion fall has played out.
        this.replayIn = REPLAY_DELAY;
      }
      if (config.impactFrames) this.renderer.impact(point, 0.14, '#ffffff');
      this.renderer.punch(point, 0.4, 0.7);
      this.effects.burst(point, 'ko');
    }
  }

  /** Keep what was drawn this tick (the last few seconds) for the K.O. replay. */
  private record(frame: MirrorFrame, live: Record<PlayerId, PoseFrame | null>) {
    this.history.push({ ...frame, live, events: this.tickEvents });
    this.tickEvents = [];
    if (this.history.length > REPLAY_KEEP) this.history.shift();
  }

  /** Play back the K.O.: the last stretch before it and the fall after, slowly, from a sweeping camera. */
  private startReplay() {
    if (useGameStore.getState().phase !== 'ko') return;
    const ko = this.history.findIndex((f) => f.events.some((e) => e.kind === 'fight' && e.ko));
    // The K.O. tick isn't recorded yet (a slow machine still frozen on it): try again shortly.
    if (ko < 0) {
      if (this.tickEvents.some((e) => e.kind === 'fight' && e.ko)) this.replayIn = 0.1;
      return;
    }
    const frames = this.history.slice(Math.max(0, ko - REPLAY_BEFORE), ko + REPLAY_AFTER);
    for (const id of PLAYER_IDS) this.views[id].reset();
    this.replay = { frames, pos: 0, drawn: -1, hold: 0 };
    this.renderer.cinematic((frames.length / 60) / REPLAY_SPEED + REPLAY_HOLD);
    useGameStore.setState({ replay: true });
    const finish = this.history[ko].events.find((e) => e.kind === 'fight' && e.ko);
    if (finish?.kind === 'fight') this.startHighlight(finish.event);
  }

  /** Host or Practice (not Training, not the client laptop): record the replay for the title screen's reel. */
  private startHighlight(finish: FightEvent) {
    const { training, players } = useGameStore.getState();
    if (this.mirroring || training || !HighlightRecorder.supported()) return;
    const side = (id: PlayerId) => ({ id: this.fighters[id]?.id, name: players[id].name.replace(/\s*\(CPU[^)]*\)$/, ''), cpu: !!this.cpu[id] });
    const winner = finish.attacker;
    this.highlight.start(this.renderer.renderer.domElement, {
      p1: side('p1'), p2: side('p2'), winner, move: finish.move,
      combo: this.combo.player === winner ? Math.max(1, this.combo.hits) : 1,
      roundTime: Math.round((ROUND - this.clock) * 10) / 10,
    });
    if (this.highlight.recording) this.renderer.onDrawn = () => this.highlight.frame();
  }

  private replayTick() {
    const r = this.replay!;
    r.pos = Math.min(r.frames.length - 1, r.pos + REPLAY_SPEED);
    for (let i = r.drawn + 1; i <= Math.floor(r.pos); i++) {
      const f = r.frames[i];
      for (const e of f.events) {
        if (e.kind === 'fight') this.showHit(e.event, e.by, e.ko, true);
        else if (e.kind === 'anticipate' && !e.cancel) this.views[e.player].anticipate(e.hand);
      }
      this.fireballs.sync(f.projectiles ?? []);
      if (!f.frozen) {
        for (const id of PLAYER_IDS) {
          this.views[id].update({
            state: f.states[id], live: f.live[id], guard: f.guard[id], distance: f.distance,
            opponentKo: f.states[opponentOf(id)].phase === 'ko', phase: 'fighting', dt: SIM_DT, smooth: true,
          });
        }
      }
      r.drawn = i;
    }
    // At the end, hold on the last moment, still in slow motion (the fall finishing, the winner's pose).
    if (r.pos >= r.frames.length - 1) {
      const f = r.frames[r.frames.length - 1];
      for (const id of PLAYER_IDS) {
        this.views[id].update({
          state: f.states[id], live: f.live[id], guard: f.guard[id], distance: f.distance,
          opponentKo: f.states[opponentOf(id)].phase === 'ko', phase: 'fighting', dt: SIM_DT * REPLAY_SPEED, smooth: true,
        });
      }
      if ((r.hold += SIM_DT) > REPLAY_HOLD) this.endReplay();
    }
  }

  private endReplay() {
    this.highlight.finish();
    this.renderer.onDrawn = null;
    this.replay = null;
    this.renderer.cinematic(null);
    this.fireballs.sync([]);
    useGameStore.setState({ replay: false });
    if (useGameStore.getState().phase === 'ko') this.replayEndedAt ??= performance.now();
  }

  /** Hits in a row (within ~1 s of each other, unanswered) make a combo; the round's first hit gets a callout. */
  private countCombo(event: FightEvent, ko: boolean) {
    const now = performance.now();
    if (event.type === 'blocked') {
      if (this.combo.player === event.attacker) this.combo.player = null;
      return;
    }
    const c = this.combo;
    if (c.player === event.attacker && now - c.at < 1100) c.hits++;
    else Object.assign(c, { player: event.attacker, hits: 1 });
    c.at = now;
    if (c.hits >= 2) useGameStore.setState({ combo: { player: event.attacker, hits: c.hits, key: ++c.key } });
    if (c.hits === 3) this.announcer.bark('combo');
    else if (c.hits === 5) this.announcer.bark('great');
    else if (c.hits === 7) this.announcer.bark('incredible');
    if (ko) {
      const winnerHp = useGameStore.getState().players[event.attacker].hp;
      if (winnerHp >= MAX_HP) useGameStore.setState({ callout: { text: 'Perfect', key: now } });
    } else if (!this.firstHitDone) {
      useGameStore.setState({ callout: { text: 'First attack', key: now } });
      this.announcer.bark('first');
    }
    this.firstHitDone = true;
  }

  // ---------------------------------------------------------------------------
  // Commentators (host decides, both laptops voice them).
  // ---------------------------------------------------------------------------

  /** Say lines here and on the client laptop. Non-urgent calls keep a gap so they don't chatter. */
  private call(lines: Line[], urgent = false) {
    if (!lines.length) return;
    const now = performance.now();
    if (!urgent && now - this.lastCall < 2500) return;
    this.lastCall = now;
    this.commentary.say(lines, urgent);
    this.outbox.push({ kind: 'call', lines, urgent });
  }

  private cast() {
    const { players } = useGameStore.getState();
    return { p1: { id: this.fighters.p1?.id, name: spoken(players.p1.name) }, p2: { id: this.fighters.p2?.id, name: spoken(players.p2.name) } };
  }

  /** The big moments get a line. */
  private react(event: FightEvent) {
    const { players } = useGameStore.getState();
    const d = opponentOf(event.attacker);
    const vars = { a: spoken(players[event.attacker].name), d: spoken(players[d].name) };
    if (event.type === 'startup') {
      if (event.move === 'fireball') this.call([fill(TEMPLATES.fireball, vars)], true);
      return;
    }
    if (!event.damage || useGameStore.getState().phase !== 'fighting') return;
    if (event.move === 'fireball') return this.call([fill(event.type === 'blocked' ? TEMPLATES.fireballBlocked : TEMPLATES.fireballHit, vars)], true);
    if (event.type === 'blocked') return;
    if (!this.firstCalled) {
      this.firstCalled = true;
      return this.call([fill(TEMPLATES.first, vars)]);
    }
    if (event.type === 'counter') return this.call([fill(TEMPLATES.counter, vars)]);
    if (this.combo.player === event.attacker && (this.combo.hits === 3 || this.combo.hits === 5)) {
      return this.call([fill(TEMPLATES.combo, { ...vars, n: this.combo.hits })], true);
    }
    if (players[d].hp < 25 && !this.dangerCalled[d]) {
      this.dangerCalled[d] = true;
      this.call([fill(TEMPLATES.danger, vars)]);
    }
  }

  /** Round start: the LLM writes the intro (it lands during the countdown); a template if it's slow or down. */
  private callIntro() {
    const cast = this.cast();
    const vars = { a: cast.p1.name, d: cast.p2.name };
    void this.commentary
      .write('The round is about to start: introduce the two fighters with some trash talk.', cast)
      .then(async (lines) => {
        // Not over the walkout's music and announcer: they speak once it's done.
        await afterWalkout();
        if (useGameStore.getState().phase !== 'countdown' && useGameStore.getState().phase !== 'fighting') return;
        this.call(lines.length ? lines : [fill(TEMPLATES.intro, vars)], true);
      });
  }

  /** The finish: an instant call, then the LLM's roast (over the replay). */
  private callFinish(winner: PlayerId | null, ending: string | null) {
    const { players } = useGameStore.getState();
    const w = winner ? spoken(players[winner].name) : '';
    const l = winner ? spoken(players[opponentOf(winner)].name) : '';
    if (!winner) this.call([fill(TEMPLATES.draw, {})], true);
    else this.call([fill(ending === 'time' ? TEMPLATES.time : TEMPLATES.ko, { w, d: l })], true);
    const moment = !winner
      ? 'Time ran out and it is a draw. Roast both of them.'
      : `${ending === 'time' ? 'Time ran out' : 'K.O.'}: ${w} beat ${l} with ${players[winner].hp} HP left. Hype the winner, roast the loser.`;
    void this.commentary.write(moment, this.cast()).then((lines) => lines.length && this.call(lines, true));
  }

  // ---------------------------------------------------------------------------
  // Mirror: the client laptop draws the host's fight. The host sends who's fighting as what ('match'), a frame
  // of engine state every tick, and the moments that need effects ('events'); the client runs no fight of its own.
  // ---------------------------------------------------------------------------

  /** Host: tell the client laptop who's fighting as what. */
  private sendMatch() {
    const session = this.hostSession;
    if (!session || (!session.connected && !session.watching)) return;
    const { players } = useGameStore.getState();
    const entry = (id: PlayerId): MatchPlayer => {
      const fighter = players[id].status === 'ready' ? this.fighters[id] : undefined;
      return { name: players[id].name, fighter: fighter ? { ...fighter, brief: undefined } : null, hp: players[id].hp };
    };
    const msg: HostMessage = { type: 'match', players: { p1: entry('p1'), p2: entry('p2') } };
    session.send(msg);
    session.cast(msg);
  }

  /** Host: this tick's fight state, and anything that happened, to the client laptop. */
  private sendFrame(stances: Record<PlayerId, Stance>, frozen: boolean) {
    const session = this.hostSession;
    const { phase, timeLeft } = useGameStore.getState();
    if (!session || (!session.connected && !session.watching) || phase === 'lobby') {
      this.outbox = [];
      return;
    }
    if (this.outbox.length) {
      const events: HostMessage = { type: 'events', events: this.outbox };
      session.send(events);
      session.cast(events);
    }
    this.outbox = [];
    const frame: HostMessage = {
      type: 'frame',
      frame: {
        states: { p1: this.fight.state('p1'), p2: this.fight.state('p2') },
        guard: { p1: stances.p1.guard, p2: stances.p2.guard },
        distance: this.fight.distance(),
        frozen,
        timeLeft,
        projectiles: [...this.fight.projectiles()],
      },
    };
    session.send(frame);
    // Watching screens get every other tick (30 a second through the server); their mirror holds the last one.
    if ((this.castTick = (this.castTick + 1) % 2) === 0) session.cast(frame);
  }

  /** Client: load and spawn the fighters the host says are fighting. */
  private mirrorMatch(players: Record<PlayerId, MatchPlayer>) {
    for (const id of PLAYER_IDS) {
      const p = players[id];
      // P2 is the client laptop's own player: its name and status come from its own setup messages. A watching screen
      // has no player of its own: both come from the host.
      if (this.spectator || id !== localPlayerId('client')) {
        updatePlayer(id, { name: p.name, status: p.fighter ? 'ready' : 'waiting', hp: p.hp, portraitUrl: p.fighter?.cardUrl ?? null });
      }
      const key = p.fighter ? `${p.fighter.id}:${p.fighter.glbUrl ?? ''}` : '';
      if (key === (this.mirrorShown[id] ?? '')) continue;
      this.mirrorShown[id] = key;
      if (!p.fighter) this.views[id].setVisible(false);
      else void this.loadFighter(id, p.fighter).then(() => this.spawn(id));
    }
  }

  /** Client: effects for what just happened on the host. */
  private mirrorEvents(events: MirrorEvent[]) {
    for (const e of events) {
      if (e.kind !== 'move') this.tickEvents.push(e);
      if (e.kind === 'fight') this.showHit(e.event, e.by, e.ko);
      else if (e.kind === 'call') this.commentary.say(e.lines, e.urgent);
      else if (e.kind === 'anticipate') {
        if (e.cancel) this.views[e.player].cancelTell(e.hand);
        else this.views[e.player].anticipate(e.hand);
      }
      else if (this.client && e.player === localPlayerId('client')) useGameStore.setState({ lastMove: { text: e.text, at: performance.now() } });
    }
  }

  /** Client: draw the host's latest frame (this laptop's own camera adds its player's live pose). */
  private mirrorTick() {
    const m = this.mirrored;
    if (!m) return;
    const { players, timeLeft, phase } = useGameStore.getState();
    if (m.timeLeft !== timeLeft) useGameStore.setState({ timeLeft: m.timeLeft });
    for (const id of PLAYER_IDS) if (players[id].hp !== m.states[id].hp) updatePlayer(id, { hp: m.states[id].hp });
    this.fireballs.sync(m.projectiles ?? []);
    this.showMeters(m.states);
    this.record(m, { p1: null, p2: this.client?.lastFrame ?? null });
    if (m.frozen && phase === 'fighting') return;
    this.hearStrikes(m.states);
    for (const id of PLAYER_IDS) {
      this.views[id].update({
        state: m.states[id],
        live: id === localPlayerId('client') ? this.client?.lastFrame ?? null : null,
        guard: m.guard[id],
        distance: m.distance,
        opponentKo: m.states[opponentOf(id)].phase === 'ko',
        phase,
        dt: SIM_DT,
      });
    }
  }

  /** Super meters into the store (only when the whole number changes, to spare the HUD re-renders). */
  private showMeters(states: Record<PlayerId, Readonly<FighterState>>) {
    const { players } = useGameStore.getState();
    for (const id of PLAYER_IDS) {
      const meter = Math.round(states[id].meter ?? 0);
      if (meter !== players[id].meter) updatePlayer(id, { meter });
    }
  }

  /** A strike coming out: a whoosh, heavier for the big ones. */
  private hearStrikes(states: Record<PlayerId, Readonly<FighterState>>) {
    for (const id of PLAYER_IDS) {
      const s = states[id];
      if (s.phase === 'active' && this.heardPhase[id] !== 'active') {
        if (s.move === 'fireball') {
          this.sfx.play('fireball');
          this.announcer.bark('fireball', true);
        }
        else this.sfx.play('whoosh', s.move === 'jab' ? 0.7 : s.move === 'kick' || s.move === 'uppercut' ? 1.3 : 1);
      }
      this.heardPhase[id] = s.phase;
    }
  }

  /** M mutes / unmutes the fight sounds. */
  private onMuteKey = (e: KeyboardEvent) => {
    if (e.code !== 'KeyM' || e.target instanceof HTMLInputElement) return;
    this.sfx.muted = !this.sfx.muted;
    this.announcer.muted = this.sfx.muted;

  };

  /** Dev only: press 1 / 2 to fake a hit on P1 / P2 (Shift = counter) until the fight engine exists. */
  private onDebugKey = (e: KeyboardEvent) => {
    if (!import.meta.env.DEV || e.target instanceof HTMLInputElement) return;
    if (e.code !== 'Digit1' && e.code !== 'Digit2') return;
    const defender: PlayerId = e.code === 'Digit1' ? 'p1' : 'p2';
    const damage = e.shiftKey ? 15 : 5;
    this.applyEvent({
      t: performance.now(),
      type: e.shiftKey ? 'counter' : 'hit',
      attacker: opponentOf(defender),
      move: e.shiftKey ? 'cross' : 'jab',
      damage,
      hitstopFrames: Math.min(14, 4 + damage / 2),
    });
  };
}

/** Resolves once no walkout is playing. */
function afterWalkout() {
  return new Promise<void>((resolve) => {
    if (!useGameStore.getState().walkout) return resolve();
    const off = useGameStore.subscribe((s) => {
      if (s.walkout) return;
      off();
      resolve();
    });
  });
}

/** Name the last real move the camera read, for the camera picture-in-picture. */
function moveText(intents: Intent[]): string | null {
  let last: string | null = null;
  for (const i of intents) {
    const text = i.kind === 'strike' ? `${i.limb.endsWith('L') ? 'Left' : 'Right'} ${i.style}`
      : i.kind === 'duck' ? 'Duck'
      : i.kind === 'dodge' ? `Dodge ${i.dir === 'L' ? 'left' : 'right'}`
      : i.kind === 'jump' ? 'Jump'
      : i.kind === 'guard' && i.up ? 'Guard up'
      : null;
    if (text) last = text;
  }
  return last;
}
