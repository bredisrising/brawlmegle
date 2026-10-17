import { Renderer } from '../director/Renderer';
import { Effects } from '../director/Effects';
import { FighterView } from '../director/FighterView';
import { FightEngine } from '../fight/FightEngine';
import { Resolver } from '../fight/Resolver';
import { IntentReader } from '../intent/IntentReader';
import { InputHub, createLocalSource, type InputSource } from '../input';
import { MockSource } from '../input/sources/MockSource';
import { captureScan, forgeFighter } from '../forge/forge';
import { scanStatus, forgeStatus } from '../forge/status';
import { maskedFighter, saveFighter } from '../forge/roster';
import { Peer } from '../net/Peer';
import { Signaling } from '../net/Signaling';
import { config } from '../config';
import {
  PLAYER_IDS, opponentOf,
  type Command, type FightEvent, type ForgedFighter, type PlayerId, type Stance,
} from '../types';
import { COUNTDOWN_FROM, KO_FREEZE, MAX_HP, PLAYER_NAMES, SIM_DT } from './constants';
import { ClientSession } from './ClientSession';
import { localPlayerId, pushPopup, updatePlayer, useGameStore } from './store';

/** What the player picked on the avatar screen. */
export type FighterChoice =
  | { kind: 'scan'; name: string } // consented: scan + forge + save to memory card
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
  private peer: Peer | null = null;
  private client: ClientSession | null = null;
  private accumulator = 0;
  private phaseTimer = 0;

  constructor(container: HTMLElement) {
    this.renderer = new Renderer(container);
    this.effects = new Effects(this.renderer.scene);
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

  /** Title screen: "Host". Opens a room on the signaling server and shows its code. */
  async host() {
    this.peer = new Peer('host', new Signaling(config.signalUrl));
    const code = await this.peer.host();
    useGameStore.setState({ role: 'host', roomCode: code || null, screen: 'avatar' });
    // TODO: when the client connects, assign a RemoteSource to p2 and run setupPlayer('p2', ...)
    // with the profile + scan it sends over P2P.
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

  /** Start a player's input source, get their fighter (scan + forge, masked, or saved), spawn them. */
  private async setupPlayer(id: PlayerId, choice: FighterChoice, source: InputSource = createLocalSource()) {
    const name = choice.kind === 'existing' ? choice.fighter.name : choice.name;
    try {
      updatePlayer(id, { name, status: 'scanning', statusDetail: 'Starting camera' });
      await source.start();
      this.input.assign(id, source);

      let fighter: ForgedFighter;
      if (choice.kind === 'scan') {
        updatePlayer(id, { statusDetail: 'Turn slowly' });
        const frames = await captureScan(source.video, source, (p) => updatePlayer(id, { statusDetail: scanStatus(p) }));
        updatePlayer(id, { status: 'forging', statusDetail: 'Forging fighter' });
        fighter = await forgeFighter(name, frames, (f) => updatePlayer(id, { statusDetail: forgeStatus(f) }));
        if (fighter.status === 'ready') saveFighter(fighter); // they said yes to "save fighter to memory card"
        // A failed forge still fights: no glbUrl means the default model (SPEC fallback ladder).
        else console.warn('forge failed, using the default fighter:', fighter.error);
      } else if (choice.kind === 'masked') {
        fighter = maskedFighter(name);
      } else {
        fighter = choice.fighter;
      }
      await this.views[id].setFighter(fighter);

      this.views[id].setVisible(true);
      this.effects.burst(this.views[id].root.position, 'spawn');
      updatePlayer(id, { status: 'ready', statusDetail: '', portraitUrl: fighter.cardUrl ?? null });

      const { players } = useGameStore.getState();
      if (PLAYER_IDS.every((p) => players[p].status === 'ready')) this.startCountdown();
    } catch (err) {
      console.error(err);
      this.input.unassign(id);
      source.stop();
      updatePlayer(id, { status: 'waiting', statusDetail: 'Something went wrong — try again' });
      const { role } = useGameStore.getState();
      if (id === localPlayerId(role)) useGameStore.setState({ screen: 'avatar' });
    }
  }

  rematch() {
    this.fight.reset();
    for (const id of PLAYER_IDS) updatePlayer(id, { hp: MAX_HP });
    useGameStore.setState({ winner: null });
    this.startCountdown();
  }

  dispose() {
    window.removeEventListener('keydown', this.onDebugKey);
    this.peer?.close();
    this.client?.dispose();
    for (const id of PLAYER_IDS) this.input.unassign(id);
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
      if (out) commands.push(...this.resolver.resolve(id, out.intents, this.fight));
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
