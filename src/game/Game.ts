import { Renderer } from '../director/Renderer';
import { poseRateOf, setOnePose } from '../director/QualityGovernor';
import * as THREE from 'three';
import { Effects, type EffectKind } from '../director/Effects';
import { FighterView } from '../director/FighterView';
import { Sfx } from '../director/Sfx';
import { Announcer } from '../director/Announcer';
import { Fireballs } from '../director/Fireballs';
import { Walkout } from '../director/Walkout';
import { ROUND_CALL_SECONDS, WALKOUT_SECONDS } from '../director/walkoutTiming';
import { Cpu, type CpuLevel, type CpuOutput } from '../fight/Cpu';
import { FightEngine } from '../fight/FightEngine';
import { Resolver } from '../fight/Resolver';
import { IntentReader } from '../intent/IntentReader';
import type { Intent } from '../intent/intents';
import { InputHub, createLocalSource, preloadLocalInput, type InputSource } from '../input';
import { MockSource } from '../input/sources/MockSource';
import { captureScan, forgeBusy, forgeFighter, type ScanFrames } from '../forge/forge';
import { forgeStatus, onChange, scanStatus } from '../forge/status';
import { fetchServerFighters, maskedFighter, saveFighter } from '../forge/roster';
import { preloadModel } from '../forge/models';
import { recordMatch } from '../forge/leaderboard';
import { config } from '../config';
import {
  PLAYER_IDS, opponentOf,
  type Command, type FightEvent, type FighterState, type ForgedFighter, type PlayerId, type PoseFrame, type Stance,
} from '../types';
import { COUNTDOWN_FROM, KO_FREEZE, MAX_HP, PLAYER_COLORS, PLAYER_NAMES, ROUND_SECONDS, SIM_DT } from './constants';
import { ClientSession } from './ClientSession';
import type { MatchPlayer, MirrorEvent, MirrorFrame } from '../net/protocol';
import { HostSession } from './HostSession';
import { MatchRecorder, recordingEnabled } from './MatchRecorder';
import { Commentary, TEMPLATES, fill, spoken, type Line } from './Commentary';
import { localPlayerId, pushPopup, updatePlayer, useGameStore } from './store';

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
  private readonly fight = new FightEngine();
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
  /** Bumped per setup, so a late forge never swaps into a slot that has since picked someone else. */
  private readonly setupGen: Record<PlayerId, number> = { p1: 0, p2: 0 };
  /** Practice mode: the CPU level to bring in for P2 once the local player is ready ('dummy' = Training). */
  private practiceLevel: CpuLevel | 'dummy' | null = null;
  /** The CPU's fighter, picked ahead with its model downloading (prepareCpu), so the CPU spawns as soon as it's in. */
  private cpuRoster: Promise<ForgedFighter[]> | null = null;
  private cpuPick: { opponent: string; fighter: Promise<ForgedFighter | undefined> } | null = null;
  /** Seconds left in the round (the store shows it rounded up). */
  private clock = ROUND_SECONDS;
  private hostSession: HostSession | null = null;
  private client: ClientSession | null = null;
  /** Host: P2's moves as read on the client laptop (newer clients read their own camera), waiting for the tick. */
  private remoteIntents: Intent[] = [];
  private remoteStance: { stance: Stance; at: number } | null = null;
  /** Host: each slot's fighter, for the client laptop's copy of the fight; and what to tell it this tick. */
  private readonly fighters: Partial<Record<PlayerId, ForgedFighter>> = {};
  private outbox: MirrorEvent[] = [];
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
  private firstHitDone = false;
  private accumulator = 0;
  private phaseTimer = 0;
  /** Aborted on dispose: stops in-flight scans and forge polling (HMR / unmount), so no camera is left running. */
  private readonly lifetime = new AbortController();

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
      if (s.phase === 'ko' && prev.phase !== 'ko') {
        void this.recorder.stop({ winner: s.winner, ending: s.ending });
        this.announceFinish(s.winner, s.ending);
        if (!this.client) {
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
      if (s.countdown === 0 && !this.client && recordingEnabled()) this.startRecording();
      if (s.countdown === COUNTDOWN_FROM) {
        this.commentary.hush();
        this.firstCalled = false;
        this.dangerCalled = {};
        if (!this.client) this.callIntro();
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
    this.hostSession?.dispose();
    const session = new HostSession(this.input, (choice, source, scan) => this.setupPlayer('p2', choice, source, scan), {
      rematch: () => this.rematch(),
      connected: () => this.sendMatch(),
      skip: () => this.skipForgeWait('p2'),
      read: (intents, stance) => {
        this.remoteIntents.push(...intents);
        this.remoteStance = { stance: { ...stance, player: 'p2' }, at: performance.now() };
      },
    });
    this.hostSession = session;
    const code = await session.open();
    useGameStore.setState({ role: 'host', roomCode: code || null, screen: 'avatar' });
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
      const client = new ClientSession(code, {
        match: (players) => this.mirrorMatch(players),
        frame: (frame) => (this.mirrored = frame),
        events: (events) => this.mirrorEvents(events),
        local: (intents) => this.localRead(intents),
      });
      await client.connect();
      this.client = client;
    } else {
      console.warn('VITE_SIGNAL_URL not set: the client flow runs offline on this laptop');
    }
    useGameStore.setState({ role: 'client', roomCode: code, screen: 'avatar' });
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
    if (this.client || phase !== 'countdown' || countdown !== COUNTDOWN_FROM) return;
    this.phaseTimer = WALKOUT_SECONDS;
  }

  /** The local player chose not to wait for their forge (see setupPlayer). */
  skipForgeWait(id: PlayerId) {
    if (this.client) return this.client.skipForge();
    this.skipForge[id]?.();
  }

  /** A forge that finished after its player went ahead with a stand-in: swap the real fighter in, with the beam. */
  private async arriveLate(id: PlayerId, gen: number, fighter: ForgedFighter) {
    if (fighter.status !== 'ready') return console.warn('forge failed, keeping the stand-in:', fighter.error);
    saveFighter(fighter);
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
      if (choice.kind === 'scan') {
        // Don't make them turn around for 20 s just to hear the forge is full.
        const busy = scan ? null : await forgeBusy();
        if (busy) throw new Error(`the forge can't take a new scan right now (${busy}). Pick a saved fighter, go masked, or try again in a minute`);
        const show = onChange((statusDetail) => updatePlayer(id, { statusDetail }));
        show('Turn slowly');
        const { signal } = this.lifetime;
        const frames = await (scan ?? captureScan(source.video, source, (p) => show(scanStatus(p)), { signal }));
        // Say what the scan got: a partial scan still forges, the missing sides are filled in.
        const got = frames.filter(Boolean).length;
        updatePlayer(id, { status: 'forging', statusDetail: got < 3 ? `Got ${got} of 3 sides, forging anyway` : 'Forging fighter' });
        // The fighter goes by the player's username; the brief's playful nickname stays in brief.name for flavor.
        // Show the design (card, else the sheet) as soon as it exists: the 3D model takes another minute or so.
        const preview = (f: ForgedFighter) => {
          const art = f.cardUrl ?? f.sheetUrl ?? null;
          if (art && art !== useGameStore.getState().players[id].portraitUrl) updatePlayer(id, { portraitUrl: art });
        };
        const forging = forgeFighter(name, frames, (f) => (show(forgeStatus(f)), preview(f)), { username: choice.username, signal });
        const skipped = new Promise<null>((resolve) => (this.skipForge[id] = () => resolve(null)));
        const done = await Promise.race([forging, skipped]);
        delete this.skipForge[id];
        if (done) {
          fighter = done;
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
      await this.loadFighter(id, fighter);
      this.lifetime.signal.throwIfAborted();

      this.spawn(id);
      updatePlayer(id, { status: 'ready', statusDetail: '', portraitUrl: fighter.cardUrl ?? null });
      this.fighters[id] = fighter;
      this.sendMatch();
      // Practice: bring in the CPU as soon as the player is set (unless someone's already in P2).
      const p2 = useGameStore.getState().players.p2;
      if (this.practiceLevel && id === 'p1' && p2.status === 'waiting') return void this.addCpuPlayer('p2', this.practiceLevel);
      // Hosting with nobody in yet: the lobby offers "Fight the CPU", so have its fighter ready.
      if (id === 'p1' && p2.status === 'waiting') this.prepareCpu(name);

      const { players } = useGameStore.getState();
      if (PLAYER_IDS.every((p) => players[p].status === 'ready')) this.startCountdown();
    } catch (err) {
      this.input.unassign(id);
      source.stop();
      if (this.lifetime.signal.aborted) return; // disposed mid-setup: nothing left to show
      console.error(err);
      // Say what actually broke (camera denied, nobody in view, forge down...), not just "something".
      const reason = err instanceof Error ? err.message : String(err);
      updatePlayer(id, { status: 'waiting', statusDetail: `Couldn't set up your fighter: ${reason}` });
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

  rematch() {
    // On the client laptop the host runs the fight: ask it.
    if (this.client) return this.client.requestRematch();
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
    window.removeEventListener('keydown', this.onDebugKey);
    window.removeEventListener('keydown', this.onMuteKey);
    this.unsubscribe();
    this.unwatchScreen();
    clearInterval(this.linkTimer);
    this.hostSession?.dispose();
    this.client?.dispose();
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
    this.clock = ROUND_SECONDS;
    useGameStore.setState({ phase: 'countdown', countdown: COUNTDOWN_FROM, timeLeft: ROUND_SECONDS, ending: null });
  }

  private update = (dt: number, frozen: boolean) => {
    this.effects.update(dt);
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
    if (this.client) return this.mirrorTick();
    const { phase, countdown } = useGameStore.getState();
    this.phaseTimer += SIM_DT;

    // The first beat is the walkout, then ROUND 1, then FIGHT.
    if (phase === 'countdown' && this.phaseTimer >= (countdown === COUNTDOWN_FROM ? (this.walkout.hold === null ? WALKOUT_SECONDS : Infinity) : ROUND_CALL_SECONDS)) {
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
  changeFighter() {
    if (this.client) return void window.location.reload();
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
    updatePlayer(id, { status: 'waiting', statusDetail: '', portraitUrl: null });
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
    if (!replaying && !ko && event.type === 'counter') {
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
    this.replay = null;
    this.renderer.cinematic(null);
    this.fireballs.sync([]);
    useGameStore.setState({ replay: false });
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
    if (!this.hostSession?.connected) return;
    const { players } = useGameStore.getState();
    const entry = (id: PlayerId): MatchPlayer => {
      const fighter = players[id].status === 'ready' ? this.fighters[id] : undefined;
      return { name: players[id].name, fighter: fighter ? { ...fighter, brief: undefined } : null, hp: players[id].hp };
    };
    this.hostSession.send({ type: 'match', players: { p1: entry('p1'), p2: entry('p2') } });
  }

  /** Host: this tick's fight state, and anything that happened, to the client laptop. */
  private sendFrame(stances: Record<PlayerId, Stance>, frozen: boolean) {
    const session = this.hostSession;
    const { phase, timeLeft } = useGameStore.getState();
    if (!session?.connected || phase === 'lobby') {
      this.outbox = [];
      return;
    }
    if (this.outbox.length) session.send({ type: 'events', events: this.outbox });
    this.outbox = [];
    session.send({
      type: 'frame',
      frame: {
        states: { p1: this.fight.state('p1'), p2: this.fight.state('p2') },
        guard: { p1: stances.p1.guard, p2: stances.p2.guard },
        distance: this.fight.distance(),
        frozen,
        timeLeft,
        projectiles: [...this.fight.projectiles()],
      },
    });
  }

  /** Client: load and spawn the fighters the host says are fighting. */
  private mirrorMatch(players: Record<PlayerId, MatchPlayer>) {
    for (const id of PLAYER_IDS) {
      const p = players[id];
      // P2 is this laptop's player: its name and status come from its own setup messages.
      if (id !== localPlayerId('client')) {
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
      else if (e.player === localPlayerId('client')) useGameStore.setState({ lastMove: { text: e.text, at: performance.now() } });
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
