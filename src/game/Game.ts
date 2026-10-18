import { Renderer } from '../director/Renderer';
import * as THREE from 'three';
import { Effects, type EffectKind } from '../director/Effects';
import { FighterView } from '../director/FighterView';
import { Sfx } from '../director/Sfx';
import { Cpu, type CpuLevel } from '../fight/Cpu';
import { FightEngine } from '../fight/FightEngine';
import { Resolver } from '../fight/Resolver';
import { IntentReader } from '../intent/IntentReader';
import type { Intent } from '../intent/intents';
import { InputHub, createLocalSource, type InputSource } from '../input';
import { MockSource } from '../input/sources/MockSource';
import { captureScan, forgeBusy, forgeFighter, type ScanFrames } from '../forge/forge';
import { forgeStatus, onChange, scanStatus } from '../forge/status';
import { fetchServerFighters, maskedFighter, saveFighter } from '../forge/roster';
import { config } from '../config';
import {
  PLAYER_IDS, opponentOf,
  type Command, type FightEvent, type FighterState, type ForgedFighter, type PlayerId, type Stance,
} from '../types';
import { COUNTDOWN_FROM, KO_FREEZE, MAX_HP, PLAYER_COLORS, PLAYER_NAMES, ROUND_SECONDS, SIM_DT } from './constants';
import { ClientSession } from './ClientSession';
import type { MatchPlayer, MirrorEvent, MirrorFrame } from '../net/protocol';
import { HostSession } from './HostSession';
import { localPlayerId, pushPopup, updatePlayer, useGameStore } from './store';

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
  private readonly cpu: Partial<Record<PlayerId, Cpu>> = {};
  private fightTicks = 0;
  /** Seconds left in the round (the store shows it rounded up). */
  private clock = ROUND_SECONDS;
  private hostSession: HostSession | null = null;
  private client: ClientSession | null = null;
  /** Host: each slot's fighter, for the client laptop's copy of the fight; and what to tell it this tick. */
  private readonly fighters: Partial<Record<PlayerId, ForgedFighter>> = {};
  private outbox: MirrorEvent[] = [];
  /** Client: the host's latest fight frame, and which fighter models are showing. */
  private mirrored: MirrorFrame | null = null;
  private readonly mirrorShown: Partial<Record<PlayerId, string>> = {};
  readonly sfx = new Sfx();
  /** Each fighter's phase last tick, to hear a strike come out (whoosh) on both laptops. */
  private readonly heardPhase: Partial<Record<PlayerId, string>> = {};
  private readonly unsubscribe: () => void;
  private accumulator = 0;
  private phaseTimer = 0;
  /** Aborted on dispose: stops in-flight scans and forge polling (HMR / unmount), so no camera is left running. */
  private readonly lifetime = new AbortController();

  constructor(container: HTMLElement) {
    this.renderer = new Renderer(container);
    this.effects = new Effects(this.renderer.scene, this.renderer.camera);
    this.views = { p1: new FighterView('p1'), p2: new FighterView('p2') };
    this.intent = { p1: new IntentReader('p1'), p2: new IntentReader('p2') };
    for (const v of Object.values(this.views)) this.renderer.scene.add(v.root);

    this.renderer.onFrame(this.update);
    this.renderer.start();
    window.addEventListener('keydown', this.onDebugKey);
    window.addEventListener('keydown', this.onMuteKey);
    // Countdown beeps, then the "go" (both laptops: the client's store follows the host's countdown).
    this.unsubscribe = useGameStore.subscribe((s, prev) => {
      if (s.countdown === prev.countdown || s.countdown === null) return;
      this.sfx.play(s.countdown === 0 ? 'go' : 'beep');
    });
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
    });
    this.hostSession = session;
    const code = await session.open();
    useGameStore.setState({ role: 'host', roomCode: code || null, screen: 'avatar' });
  }

  /** Title screen: "Connect" with a room code. */
  async join(code: string) {
    if (config.signalUrl) {
      const client = new ClientSession(code, {
        match: (players) => this.mirrorMatch(players),
        frame: (frame) => (this.mirrored = frame),
        events: (events) => this.mirrorEvents(events),
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
  async addCpuPlayer(id: PlayerId, level: CpuLevel = 'normal') {
    updatePlayer(id, { name: 'CPU', status: 'forging', statusDetail: 'Picking a fighter' });
    const opponent = useGameStore.getState().players[opponentOf(id)].name.toLowerCase();
    const pool = (await fetchServerFighters()).filter((f) => f.glbUrl && f.name.toLowerCase() !== opponent);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const fighter: ForgedFighter = pick ?? { id: 'cpu', name: 'Sparring Bot', status: 'ready', glbUrl: `${import.meta.env.BASE_URL}models/default.glb` };
    this.input.unassign(id);
    this.cpu[id] = new Cpu(id, level, Math.floor(Math.random() * 1e6));
    try {
      await this.views[id].setFighter(fighter);
    } catch (err) {
      console.warn('cpu fighter failed to load, using the placeholder', err);
      await this.views[id].setFighter({ id: 'cpu', name: 'Sparring Bot', status: 'ready' });
    }
    this.spawn(id);
    const label = level === 'normal' ? 'CPU' : `CPU ${level}`;
    updatePlayer(id, { name: `${fighter.name} (${label})`, status: 'ready', statusDetail: '', portraitUrl: fighter.cardUrl ?? null });
    this.fighters[id] = fighter;
    this.sendMatch();
    const { players } = useGameStore.getState();
    if (PLAYER_IDS.every((p) => players[p].status === 'ready')) this.startCountdown();
  }

  /** A fighter arrives: it prints in out of a beam of light in its player's color. */
  private spawn(id: PlayerId) {
    this.views[id].setVisible(true);
    this.views[id].materialize();
    this.sfx.play('spawn');
    this.effects.burst(this.views[id].root.position, 'spawn', PLAYER_COLORS[id]);
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
        updatePlayer(id, { status: 'forging', statusDetail: 'Forging fighter' });
        // The fighter goes by the player's username; the brief's playful nickname stays in brief.name for flavor.
        fighter = await forgeFighter(name, frames, (f) => show(forgeStatus(f)), { username: choice.username, signal });
        if (fighter.status === 'ready') saveFighter(fighter); // they said yes to "save fighter to memory card"
        // A failed forge still fights: no glbUrl means the default model (SPEC fallback ladder).
        else console.warn('forge failed, using the default fighter:', fighter.error);
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
    this.hostSession?.dispose();
    this.client?.dispose();
    for (const id of PLAYER_IDS) {
      this.input.source(id)?.stop(); // release the camera, not just the hub's subscription
      this.input.unassign(id);
    }
    for (const v of Object.values(this.views)) v.dispose();
    this.effects.dispose();
    this.renderer.dispose();
  }

  private startCountdown() {
    this.phaseTimer = 0;
    this.clock = ROUND_SECONDS;
    useGameStore.setState({ phase: 'countdown', countdown: COUNTDOWN_FROM, timeLeft: ROUND_SECONDS, ending: null });
  }

  private update = (dt: number, frozen: boolean) => {
    this.effects.update(dt);
    if (frozen) return;
    this.accumulator += dt;
    while (this.accumulator >= SIM_DT) {
      this.tick();
      this.accumulator -= SIM_DT;
    }
  };

  /** One fixed 60 Hz step. */
  private tick() {
    if (this.client) return this.mirrorTick();
    const { phase, countdown } = useGameStore.getState();
    this.phaseTimer += SIM_DT;

    if (phase === 'countdown' && this.phaseTimer >= 1) {
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
      const frame = this.input.latest(id);
      const out = frame ? this.intent[id].update(frame) : null;
      if (out) {
        commands.push(...this.resolver.resolve(id, out.intents, this.fight));
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
    }
    if (phase === 'fighting') {
      this.fightTicks++;
      for (const event of this.fight.step(commands, stances)) this.applyEvent(event);
      this.tickClock();
    }
    // Hit-stop: the picture holds on the impact while the engine does (effects and camera shake keep going).
    // (Only mid-round: the K.O. hit's hit-stop never runs out, since the engine stops stepping.)
    const frozen = useGameStore.getState().phase === 'fighting' && this.fight.frozen;
    this.sendFrame(stances, frozen);
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
        dt: SIM_DT,
      });
    }
  }

  /** Round clock: when it runs out, more HP left wins (equal is a draw). */
  private tickClock() {
    if (useGameStore.getState().phase !== 'fighting') return;
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
    if (ko) useGameStore.setState({ phase: 'ko', ending: 'ko', winner: event.attacker, countdown: null });
  }

  /** The look of a hit (both laptops): the reaction, sparks, impact frames, camera punch, popup, K.O. drama. */
  private showHit(event: FightEvent, by: Readonly<FighterState>, ko: boolean) {
    if (!event.damage) return;
    const defender = opponentOf(event.attacker);
    this.views[defender].onEvent(event, by);
    const point = this.views[defender].worldJoint(by.height === 'body' || event.move === 'knee' ? 'neck' : 'head');
    if (by.height === 'body' || event.move === 'knee') point.y -= 0.08;
    const heavy = event.type === 'counter' || event.damage >= 10;
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
      this.renderer.freeze(KO_FREEZE);
      if (config.impactFrames) this.renderer.impact(point, 0.14, '#ffffff');
      this.renderer.punch(point, 0.4, 0.7);
      this.renderer.slowMotion(KO_FREEZE + 1.4, 0.3);
      this.effects.burst(point, 'ko');
    }
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
      if (e.kind === 'fight') this.showHit(e.event, e.by, e.ko);
      else if (e.kind === 'anticipate') this.views[e.player].anticipate(e.hand);
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
    if (m.frozen && phase === 'fighting') return;
    this.hearStrikes(m.states);
    for (const id of PLAYER_IDS) {
      this.views[id].update({
        state: m.states[id],
        live: id === localPlayerId('client') ? this.client?.lastFrame ?? null : null,
        guard: m.guard[id],
        distance: m.distance,
        opponentKo: m.states[opponentOf(id)].phase === 'ko',
        dt: SIM_DT,
      });
    }
  }

  /** A strike coming out: a whoosh, heavier for the big ones. */
  private hearStrikes(states: Record<PlayerId, Readonly<FighterState>>) {
    for (const id of PLAYER_IDS) {
      const s = states[id];
      if (s.phase === 'active' && this.heardPhase[id] !== 'active') {
        this.sfx.play('whoosh', s.move === 'jab' ? 0.7 : s.move === 'kick' || s.move === 'uppercut' ? 1.3 : 1);
      }
      this.heardPhase[id] = s.phase;
    }
  }

  /** M mutes / unmutes the fight sounds. */
  private onMuteKey = (e: KeyboardEvent) => {
    if (e.code !== 'KeyM' || e.target instanceof HTMLInputElement) return;
    this.sfx.muted = !this.sfx.muted;
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
