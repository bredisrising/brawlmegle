import { Engine } from '../engine/Engine';
import { Effects } from '../engine/Effects';
import { Fighter } from '../player/Fighter';
import { forgeFighter } from '../services/forge';
import { createTracker } from '../vision';
import { PLAYER_IDS, opponentOf, type PlayerId } from '../types';
import { COUNTDOWN_FROM, HITSTOP, MAX_HP, SIM_DT } from './constants';
import { detectHits, type HitEvent } from './combat';
import { pushPopup, updatePlayer, useGameStore } from './store';

/**
 * Orchestrates everything: owns the engine, fighters and phase state machine,
 * runs the fixed-step sim, and mirrors UI-relevant state into the store.
 *
 *   lobby --(both ready)--> countdown --> fighting --(hp 0)--> ko --(rematch)--> countdown
 */
export class Game {
  readonly engine: Engine;
  private readonly effects: Effects;
  private readonly fighters: Record<PlayerId, Fighter>;
  private accumulator = 0;
  private phaseTimer = 0;

  constructor(container: HTMLElement) {
    this.engine = new Engine(container);
    this.effects = new Effects(this.engine.scene);
    this.fighters = { p1: new Fighter('p1'), p2: new Fighter('p2') };
    for (const f of Object.values(this.fighters)) this.engine.scene.add(f.root);

    this.engine.onFrame(this.update);
    this.engine.start();
    window.addEventListener('keydown', this.onDebugKey);
  }

  /** "Detect player" button: start vision, run the forge pipeline, spawn the fighter. */
  async detectPlayer(id: PlayerId) {
    try {
      updatePlayer(id, { status: 'scanning', statusDetail: 'Starting camera' });
      const tracker = createTracker(id);
      await tracker.start();

      updatePlayer(id, { status: 'forging' });
      const forged = await forgeFighter((step) => updatePlayer(id, { statusDetail: step }));
      // TODO: load forged.modelUrl into the fighter instead of the placeholder model.

      this.fighters[id].setTracker(tracker);
      this.effects.burst(this.fighters[id].root.position, 'spawn');
      updatePlayer(id, { status: 'ready', statusDetail: '', portraitUrl: forged.heroImageUrl });

      const { players } = useGameStore.getState();
      if (PLAYER_IDS.every((p) => players[p].status === 'ready')) this.startCountdown();
    } catch (err) {
      console.error(err);
      updatePlayer(id, { status: 'waiting', statusDetail: 'Detection failed — try again' });
    }
  }

  rematch() {
    for (const id of PLAYER_IDS) updatePlayer(id, { hp: MAX_HP });
    useGameStore.setState({ winner: null });
    this.startCountdown();
  }

  dispose() {
    window.removeEventListener('keydown', this.onDebugKey);
    for (const f of Object.values(this.fighters)) f.dispose();
    this.effects.dispose();
    this.engine.dispose();
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
      this.tick(SIM_DT);
      this.accumulator -= SIM_DT;
    }
  };

  /** One fixed simulation step. */
  private tick(dt: number) {
    for (const f of Object.values(this.fighters)) f.step(dt);

    const { phase, countdown } = useGameStore.getState();
    this.phaseTimer += dt;

    if (phase === 'countdown' && this.phaseTimer >= 1) {
      this.phaseTimer = 0;
      const next = (countdown ?? 1) - 1;
      useGameStore.setState(next <= 0 ? { phase: 'fighting', countdown: 0 } : { countdown: next });
    }

    if (phase === 'fighting') {
      if (countdown === 0 && this.phaseTimer >= 0.8) useGameStore.setState({ countdown: null });
      for (const id of PLAYER_IDS) {
        for (const hit of detectHits(this.fighters[id], this.fighters[opponentOf(id)], dt)) this.applyHit(hit);
      }
    }
  }

  private applyHit(hit: HitEvent) {
    const { players, phase } = useGameStore.getState();
    if (phase !== 'fighting') return;

    const hp = Math.max(0, players[hit.defender].hp - hit.damage);
    updatePlayer(hit.defender, { hp });
    this.fighters[hit.defender].hit(hit.damage, hit.zone === 'head');
    this.effects.burst(hit.point, hit.kind);
    this.engine.freeze(HITSTOP[hit.kind]);

    const label = hit.kind === 'blocked' ? 'BLOCKED' : hit.kind === 'heavy' ? 'CRUSHING!' : hit.zone === 'head' ? 'HEADSHOT' : 'HIT';
    pushPopup({ ...this.engine.project(hit.point), label, damage: Math.round(hit.damage), kind: hit.kind });

    if (hit.kind === 'heavy') {
      this.engine.shake(0.04);
      useGameStore.setState((s) => ({ flashKey: s.flashKey + 1 }));
    }
    if (hp <= 0) {
      this.engine.freeze(HITSTOP.ko);
      this.effects.burst(hit.point, 'ko');
      useGameStore.setState({ phase: 'ko', winner: hit.attacker, countdown: null });
    }
  }

  /** Dev only: press 1 / 2 to fake a hit on that player (until combat detection exists). */
  private onDebugKey = (e: KeyboardEvent) => {
    if (!import.meta.env.DEV || (e.key !== '1' && e.key !== '2')) return;
    const defender: PlayerId = e.key === '1' ? 'p1' : 'p2';
    const heavy = e.shiftKey;
    this.applyHit({
      attacker: opponentOf(defender),
      defender,
      hand: 'right',
      zone: 'head',
      kind: heavy ? 'heavy' : 'light',
      damage: heavy ? 18 : 7,
      point: this.fighters[defender].worldJoint('head'),
    });
  };
}
