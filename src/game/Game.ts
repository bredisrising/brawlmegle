import { Renderer } from '../director/Renderer';
import * as THREE from 'three';
import { Effects, type EffectKind } from '../director/Effects';
import { FighterView } from '../director/FighterView';
import { FightEngine } from '../fight/FightEngine';
import { Resolver } from '../fight/Resolver';
import { IntentReader } from '../intent/IntentReader';
import type { Intent } from '../intent/intents';
import { InputHub, createLocalSource, type InputSource } from '../input';
import { MockSource } from '../input/sources/MockSource';
import { captureScan, forgeFighter, type ScanFrames } from '../forge/forge';
import { forgeStatus, onChange, scanStatus } from '../forge/status';
import { maskedFighter, saveFighter } from '../forge/roster';
import { config } from '../config';
import {
  PLAYER_IDS, opponentOf,
  type Command, type FightEvent, type ForgedFighter, type PlayerId, type Stance,
} from '../types';
import { COUNTDOWN_FROM, KO_FREEZE, MAX_HP, PLAYER_NAMES, SIM_DT } from './constants';
import { ClientSession } from './ClientSession';
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
  private hostSession: HostSession | null = null;
  private client: ClientSession | null = null;
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
    const session = new HostSession(this.input, (choice, source, scan) => this.setupPlayer('p2', choice, source, scan));
    this.hostSession = session;
    const code = await session.open();
    useGameStore.setState({ role: 'host', roomCode: code || null, screen: 'avatar' });
  }

  /** Title screen: "Connect" with a room code. */
  async join(code: string) {
    if (config.signalUrl) {
      const client = new ClientSession(code);
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
    try {
      updatePlayer(id, { name, status: 'scanning', statusDetail: 'Starting camera' });
      await source.start();
      this.lifetime.signal.throwIfAborted();
      this.input.assign(id, source);

      let fighter: ForgedFighter;
      if (choice.kind === 'scan') {
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

      this.views[id].setVisible(true);
      this.effects.burst(this.views[id].root.position, 'spawn');
      updatePlayer(id, { status: 'ready', statusDetail: '', portraitUrl: fighter.cardUrl ?? null });

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
    this.fight.reset();
    for (const id of PLAYER_IDS) updatePlayer(id, { hp: MAX_HP });
    useGameStore.setState({ winner: null });
    this.startCountdown();
  }

  dispose() {
    this.lifetime.abort();
    window.removeEventListener('keydown', this.onDebugKey);
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
    useGameStore.setState({ phase: 'countdown', countdown: COUNTDOWN_FROM });
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

    // Input -> intent -> fight engine. All stubs for now (see SPEC.md).
    const commands: Command[] = [];
    const stances = {} as Record<PlayerId, Stance>;
    for (const id of PLAYER_IDS) {
      const frame = this.input.latest(id);
      const out = frame ? this.intent[id].update(frame) : null;
      if (out) {
        commands.push(...this.resolver.resolve(id, out.intents, this.fight));
        if (id === localPlayerId(useGameStore.getState().role)) showMove(out.intents);
      }
      stances[id] = out?.stance ?? { player: id, guard: true, advance: 0, lean: { x: 0, y: 0 }, tracked: false };
    }
    if (phase === 'fighting') {
      for (const event of this.fight.step(commands, stances)) this.applyEvent(event);
    }
    for (const id of PLAYER_IDS) this.views[id].update(this.fight.state(id), this.input.latest(id));
  }

  /** Engine event -> HP in the store, hit-stop, effects, popups. */
  private applyEvent(event: FightEvent) {
    const { players, phase } = useGameStore.getState();
    if (phase !== 'fighting' || !event.damage) return;

    const defender = opponentOf(event.attacker);
    // TODO: once FightEngine is real, mirror FighterState.hp instead of subtracting here.
    const hp = Math.max(0, players[defender].hp - event.damage);
    updatePlayer(defender, { hp });
    this.views[defender].onEvent(event);
    this.renderer.freeze((event.hitstopFrames ?? 0) * SIM_DT);

    const point = this.views[defender].worldJoint('head');
    const heavy = event.type === 'counter' || event.damage >= 10;
    this.effects.burst(point, event.type === 'blocked' ? 'blocked' : event.type === 'counter' ? 'counter' : 'hit');
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
    if (hp <= 0) {
      this.renderer.freeze(KO_FREEZE);
      this.effects.burst(point, 'ko');
      useGameStore.setState({ phase: 'ko', winner: event.attacker, countdown: null });
    }
  }

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
function showMove(intents: Intent[]) {
  for (const i of intents) {
    const text = i.kind === 'strike' ? `${i.limb.endsWith('L') ? 'Left' : 'Right'} ${i.style}`
      : i.kind === 'duck' ? 'Duck'
      : i.kind === 'dodge' ? `Dodge ${i.dir === 'L' ? 'left' : 'right'}`
      : i.kind === 'jump' ? 'Jump'
      : i.kind === 'guard' && i.up ? 'Guard up'
      : null;
    if (text) useGameStore.setState({ lastMove: { text, at: performance.now() } });
  }
}
