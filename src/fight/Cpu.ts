import { opponentOf } from '../types';
import type { AttackMove, Command, FighterState, Hand, PlayerId, Stance } from '../types';
import type { FightEngine } from './FightEngine';
import { FIGHT, MOVES } from './moves';

/**
 * A CPU opponent: a sparring partner for someone fighting with their body through a webcam. Their inputs
 * land ~150 ms late and imprecise, so the CPU is built to be readable and beatable, not optimal:
 *
 * - Spacing: hovers just outside jab range, steps in to attack, backs off after attacking or when tired.
 * - Offense: every attack starts from idle with a tell (an 'anticipate' command and a visible step in),
 *   mixes jab/cross/hook/uppercut with the odd kick and short combos, keeps stamina in reserve, waits between.
 * - Defense: guards, slips or ducks some swings it sees start (never all), covers up after getting hit.
 * - Reactions: what it does about a swing (counter the whiff, punish the recovery) comes a human 250–400 ms
 *   later on normal. A player standing still gets attacked sooner.
 *
 * It only reads the engine (state, distance, evading) and sends the same commands and stance a player would,
 * so it plays by the same rules. Deterministic: a seeded PRNG, so a fight with the same seed replays exactly.
 * Call think() once per 60 Hz tick, before engine.step().
 */

export type CpuLevel = 'easy' | 'normal' | 'hard';
export type CpuOutput = { commands: Command[]; stance: Stance };

type Span = readonly [number, number];
type LevelSpec = {
  /** Ticks from seeing a swing start to acting on how it went (counter a whiff, punish a recovery). */
  react: Span;
  /**
   * Ticks from seeing a swing start to guard/slip/duck. Every startup is 8–18 frames, so a defense on the full
   * reaction time could never land: this stands in for "half expecting it", and only fires on defendChance.
   */
  reflex: Span;
  defendChance: number;
  punishChance: number;
  /** Chance to cover up for a moment after taking a hit, or while backing off. */
  shellChance: number;
  /** Ticks of hovering between its own attacks. */
  cooldown: Span;
  /** Ticks of tell (anticipate + stepping in) before an attack. */
  telegraph: Span;
  /** Opponent idle this many ticks is "standing still": the next attack comes sooner. */
  still: number;
  comboChance: number;
  /** speed × windup on its attacks (damage scale). */
  power: number;
};

const LEVELS: Record<CpuLevel, LevelSpec> = {
  easy: { react: [27, 34], reflex: [8, 13], defendChance: 0.2, punishChance: 0.3, shellChance: 0.2, cooldown: [150, 240], telegraph: [26, 36], still: 120, comboChance: 0.12, power: 0.85 },
  normal: { react: [15, 24], reflex: [5, 10], defendChance: 0.42, punishChance: 0.6, shellChance: 0.4, cooldown: [96, 168], telegraph: [16, 24], still: 75, comboChance: 0.3, power: 1 },
  hard: { react: [10, 16], reflex: [3, 8], defendChance: 0.62, punishChance: 0.85, shellChance: 0.55, cooldown: [60, 120], telegraph: [11, 16], still: 50, comboChance: 0.45, power: 1 },
};

/** Where it hovers when not attacking (m): just outside an unlunged jab (0.85). */
const COMFORT = 1.0;
/** Farther out while getting its breath back. */
const REST_DISTANCE = 1.25;
/** Never start anything that would leave stamina below this (gassed is below FIGHT.gassedBelow). */
const STAMINA_FLOOR = 30;
const REST_BELOW = 35;
const REST_UNTIL = 70;
/** Most it steps in during a strike's startup (the resolver allows players 0.4). */
const MAX_LUNGE = 0.25;
/** Distance it walks in to before throwing each move: comfortably inside the move's range. */
/** Frames a fireball takes to cross a typical gap: the CPU holds its guard that much longer for one. */
const FIREBALL_FLIGHT = 36;
const IDEAL: Record<AttackMove, number> = { jab: 0.7, cross: 0.7, hook: 0.58, uppercut: 0.45, knee: 0.45, kick: 0.85, fireball: 1.1 };

const SINGLES: [AttackMove, number][] = [['jab', 4], ['cross', 3], ['hook', 2.5], ['uppercut', 1.5], ['kick', 1]];
/** Against a player standing still: heavier stuff. */
const SINGLES_VS_STILL: [AttackMove, number][] = [['jab', 2], ['cross', 3.5], ['hook', 3], ['uppercut', 1.5], ['kick', 1.5]];
const COMBOS: Record<CpuLevel, [AttackMove[], number][]> = {
  easy: [[['jab', 'cross'], 1]],
  normal: [[['jab', 'cross'], 3], [['jab', 'jab'], 1], [['cross', 'hook'], 1]],
  hard: [[['jab', 'cross'], 3], [['jab', 'jab'], 1], [['cross', 'hook'], 1], [['jab', 'cross', 'hook'], 1]],
};

type Mode = 'neutral' | 'windup' | 'attack' | 'retreat' | 'rest';
type Defense = 'block' | 'slip' | 'duck';
type Reaction = { at: number; kind: 'defend'; move: AttackMove; defense: Defense } | { at: number; kind: 'punish'; looks: number };

export class Cpu {
  private readonly opponent: PlayerId;
  private readonly spec: LevelSpec;
  private rng!: () => number;
  private mode: Mode = 'neutral';
  private plan: AttackMove[] = [];
  /** -1 until the first think(): timers count from whatever tick it starts on. */
  private nextAttack = -1;
  private windupUntil = 0;
  private giveUpAt = 0;
  private retreatUntil = 0;
  private guardUntil = 0;
  private holdGuard = false;
  private reactions: Reaction[] = [];
  private seen: FighterState | null = null;
  private selfPhase: FighterState['phase'] = 'idle';
  private oppIdle = 0;
  private thrown: AttackMove[] = [];

  constructor(
    readonly player: PlayerId,
    readonly level: CpuLevel = 'normal',
    private readonly seed = 1,
  ) {
    this.opponent = opponentOf(player);
    this.spec = LEVELS[level];
    this.reset();
  }

  /** Back to the start of a fight (same seed, so the same fight replays). */
  reset(): void {
    this.rng = mulberry32(this.seed * 2654435761 + (this.player === 'p1' ? 1 : 2));
    this.mode = 'neutral';
    this.plan = [];
    this.nextAttack = -1;
    this.windupUntil = this.giveUpAt = this.retreatUntil = this.guardUntil = 0;
    this.holdGuard = false;
    this.reactions = [];
    this.seen = null;
    this.selfPhase = 'idle';
    this.oppIdle = 0;
    this.thrown = [];
  }

  think(engine: FightEngine, tick: number): CpuOutput {
    const commands: Command[] = [];
    const me = engine.state(this.player);
    const opp = engine.state(this.opponent);
    const d = engine.distance();
    const t = (tick * 1000) / 60;
    if (me.phase === 'ko' || opp.phase === 'ko') return { commands, stance: this.stance(false, 0) };
    if (this.nextAttack < 0) this.nextAttack = tick + this.int([60, 120]);

    this.watch(engine, me, opp, d, tick);

    // Reactions that are due: a defense, or acting on how the opponent's swing went.
    let evaded = false;
    const due = this.reactions.filter((r) => r.at <= tick);
    this.reactions = this.reactions.filter((r) => r.at > tick);
    for (const r of due) {
      if (r.kind === 'defend') evaded = this.defend(r, me, opp, commands, tick, t) || evaded;
      else this.punish(r, me, opp, d, commands, tick, t);
    }

    let advance = 0;
    switch (this.mode) {
      case 'neutral': {
        advance = this.space(d, COMFORT + 0.06 * Math.sin(tick / 37 + (this.player === 'p1' ? 0 : 2)));
        if (me.stamina < REST_BELOW) {
          this.enter('rest', tick);
          break;
        }
        // Standing still invites an attack.
        if (this.oppIdle >= this.spec.still && this.nextAttack > tick + 24) this.nextAttack = tick + this.int([8, 24]);
        const oppSwinging = opp.phase === 'startup' || opp.phase === 'active';
        if (tick >= this.nextAttack && me.phase === 'idle' && !oppSwinging) {
          const plan = this.choosePlan(me.stamina);
          if (!plan.length) {
            this.enter('rest', tick);
            break;
          }
          this.plan = plan;
          this.mode = 'windup';
          this.windupUntil = tick + this.int(this.spec.telegraph);
          this.giveUpAt = this.windupUntil + 90;
          commands.push({ kind: 'anticipate', player: this.player, t, hand: handFor(plan[0]) });
        }
        break;
      }
      case 'windup': {
        const move = this.plan[0];
        advance = Math.max(0, this.space(d, IDEAL[move], 0.8)); // the tell: a visible step in
        const close = d <= IDEAL[move] + 0.1;
        const reachable = d <= reach(move) + MAX_LUNGE;
        if (tick >= this.windupUntil && me.phase === 'idle' && (close || (reachable && tick >= this.windupUntil + 20))) {
          commands.push(this.attack(this.plan.shift()!, d, t));
          this.mode = 'attack';
        } else if (tick >= this.giveUpAt) {
          this.plan = [];
          this.mode = 'neutral';
          this.nextAttack = tick + this.int([30, 60]);
        }
        break;
      }
      case 'attack':
        // Still swinging (or just threw this tick, e.g. a punish: the engine starts it on this step).
        if (me.phase !== 'idle' || commands.some((c) => c.kind === 'attack')) break;
        // Follow-ups come as soon as it's free again, if it can afford them and they can reach.
        if (this.plan.length && me.stamina - MOVES[this.plan[0]].stamina >= STAMINA_FLOOR && d <= reach(this.plan[0]) + MAX_LUNGE) {
          commands.push(this.attack(this.plan.shift()!, d, t));
        } else {
          this.plan = [];
          this.enter('retreat', tick);
          advance = -0.7;
        }
        break;
      case 'retreat':
        advance = -0.7;
        if (tick >= this.retreatUntil && (d >= COMFORT - 0.05 || tick >= this.retreatUntil + 40)) {
          this.mode = 'neutral';
          this.holdGuard = false;
          this.nextAttack = tick + this.int(this.spec.cooldown);
        }
        break;
      case 'rest':
        advance = this.space(d, REST_DISTANCE);
        if (me.stamina >= REST_UNTIL) {
          this.mode = 'neutral';
          this.holdGuard = false;
          this.nextAttack = tick + this.int([20, 50]);
        }
        break;
    }

    const attacking = this.mode === 'windup' || this.mode === 'attack';
    const guard = !attacking && !evaded && engine.evading(this.player) === null && (tick < this.guardUntil || this.holdGuard);
    return { commands, stance: this.stance(guard, advance) };
  }

  /** Notices what changed since last tick and schedules reactions. */
  private watch(engine: FightEngine, me: FighterState, opp: FighterState, d: number, tick: number) {
    const prev = this.seen;
    const swingStarted = opp.phase === 'startup' && (prev?.phase !== 'startup' || opp.frame < prev.frame);
    if (swingStarted && opp.move) {
      const move = opp.move as AttackMove;
      if (move === 'fireball') {
        // Seen from anywhere: put the guard up for it.
        if (this.rng() < this.spec.defendChance) this.reactions.push({ at: tick + this.int(this.spec.reflex), kind: 'defend', move, defense: 'block' });
      } else if (d <= MOVES[move].range + 0.45 && this.rng() < this.spec.defendChance) {
        this.reactions.push({ at: tick + this.int(this.spec.reflex), kind: 'defend', move, defense: this.pickDefense(move) });
      }
      this.reactions.push({ at: tick + this.int(this.spec.react), kind: 'punish', looks: 6 });
    }
    this.oppIdle = opp.phase === 'idle' && engine.evading(this.opponent) === null ? this.oppIdle + 1 : 0;

    // Got hit: drop the plan. Coming out of it: maybe cover up for a moment.
    if (me.phase === 'hitstun' && this.selfPhase !== 'hitstun') {
      this.plan = [];
      if (this.mode === 'windup' || this.mode === 'attack') this.mode = 'neutral';
      this.nextAttack = Math.max(this.nextAttack, tick + this.int([30, 60]));
    }
    if (me.phase === 'idle' && this.selfPhase === 'hitstun' && this.rng() < this.spec.shellChance) {
      this.guardUntil = Math.max(this.guardUntil, tick + this.int([30, 60]));
    }
    this.seen = { ...opp };
    this.selfPhase = me.phase;
  }

  /** Returns whether it evaded (so the guard stays down while slipping or ducking). */
  private defend(r: Extract<Reaction, { kind: 'defend' }>, me: FighterState, opp: FighterState, commands: Command[], tick: number, t: number): boolean {
    // Too late: it already landed or missed (a fireball is still on its way after the throw).
    if (r.move !== 'fireball' && opp.phase !== 'startup' && opp.phase !== 'active') return false;
    // It saw it coming: drop the tell and deal with the punch first.
    if (this.mode === 'windup') {
      this.plan = [];
      this.mode = 'neutral';
      this.nextAttack = tick + this.int([20, 40]);
    }
    if (r.defense === 'block') {
      if (me.phase !== 'idle' && me.phase !== 'blockstun') return false;
      const flight = r.move === 'fireball' ? FIREBALL_FLIGHT : 0;
      const left = Math.max(0, MOVES[r.move].startup - opp.frame) + MOVES[r.move].active + flight;
      this.guardUntil = Math.max(this.guardUntil, tick + left + this.int([6, 14]));
      return false;
    }
    if (me.phase !== 'idle' && me.phase !== 'recovery') return false;
    commands.push({ kind: 'defend', player: this.player, t, move: r.defense, ...(r.defense === 'slip' ? { dir: this.rng() < 0.5 ? 'L' : 'R' } : {}) });
    return true;
  }

  /** Acting on how the opponent's swing went: if they're stuck in recovery, hit them before they're free. */
  private punish(r: Extract<Reaction, { kind: 'punish' }>, me: FighterState, opp: FighterState, d: number, commands: Command[], tick: number, t: number) {
    // Still swinging: keep watching a moment to see how it goes.
    if ((opp.phase === 'startup' || opp.phase === 'active') && r.looks > 0) {
      this.reactions.push({ ...r, at: tick + 2, looks: r.looks - 1 });
      return;
    }
    if (me.phase !== 'idle' || opp.phase !== 'recovery' || !opp.move || this.mode === 'attack') return;
    if (this.rng() >= this.spec.punishChance) return;
    const left = MOVES[opp.move as AttackMove].recovery - opp.frame;
    const options: AttackMove[] = ['uppercut', 'cross', 'hook', 'jab'];
    const move = options.find((m) => MOVES[m].startup + 1 <= left && d <= reach(m) + MAX_LUNGE && me.stamina - MOVES[m].stamina >= STAMINA_FLOOR);
    if (!move) return;
    this.plan = [];
    this.mode = 'attack';
    this.reactions = this.reactions.filter((r) => r.kind !== 'punish');
    commands.push(this.attack(move, d, t));
  }

  private choosePlan(stamina: number): AttackMove[] {
    const affordable = (plan: AttackMove[]) => stamina - plan.reduce((sum, m) => sum + MOVES[m].stamina, 0) >= STAMINA_FLOOR;
    if (this.rng() < this.spec.comboChance) {
      const combo = this.weighted(COMBOS[this.level]);
      if (affordable(combo)) return [...combo];
    }
    const pool = (this.oppIdle >= this.spec.still ? SINGLES_VS_STILL : SINGLES)
      // Never the same move three times running.
      .filter(([m]) => !(this.thrown.length >= 2 && this.thrown.at(-1) === m && this.thrown.at(-2) === m));
    const move = this.weighted(pool);
    if (affordable([move])) return [move];
    return affordable(['jab']) ? ['jab'] : [];
  }

  private attack(move: AttackMove, d: number, t: number): Command {
    this.thrown = [...this.thrown.slice(-3), move];
    const lunge = move !== 'fireball' && d > reach(move) ? Math.min(MAX_LUNGE, d - reach(move)) : 0;
    const body = move === 'hook' ? this.rng() < 0.35 : move === 'jab' || move === 'cross' ? this.rng() < 0.15 : false;
    const power = this.spec.power;
    return { kind: 'attack', player: this.player, t, move, hand: handFor(move), height: body ? 'body' : 'head', speed: power, windup: 1, lunge };
  }

  private pickDefense(move: AttackMove): Defense {
    const spec = MOVES[move];
    // Easy sometimes just guesses.
    if (this.level === 'easy' && this.rng() < 0.2) return (['block', 'slip', 'duck'] as const)[Math.floor(this.rng() * 3)];
    const r = this.rng();
    // A guard doesn't stop a guard breaker (the kick): get out of its way instead.
    if (FIGHT.guardBreakers.includes(move)) return spec.beatsDuck || r < 0.6 ? 'slip' : 'duck';
    if (spec.straight) return r < 0.4 ? 'slip' : 'block';
    if (!spec.beatsDuck) return r < 0.25 ? 'duck' : 'block';
    return 'block';
  }

  private enter(mode: 'retreat' | 'rest', tick: number) {
    this.mode = mode;
    this.plan = [];
    if (mode === 'retreat') this.retreatUntil = tick + this.int([20, 40]);
    this.holdGuard = this.rng() < this.spec.shellChance;
  }

  /** Lean toward a target distance. Inside the engine's dead zone (|lean| ≤ 0.1) it drifts on its own. */
  private space(d: number, target: number, max = 1): number {
    return clamp((d - target) * 4, -1, max);
  }

  private stance(guard: boolean, advance: number): Stance {
    return { player: this.player, guard, advance, lean: { x: 0, y: 0 }, tracked: true };
  }

  private int([min, max]: Span): number {
    return min + Math.floor(this.rng() * (max - min + 1));
  }

  private weighted<T>(options: [T, number][]): T {
    let r = this.rng() * options.reduce((sum, [, w]) => sum + w, 0);
    for (const [option, w] of options) if ((r -= w) < 0) return option;
    return options[options.length - 1][0];
  }
}

const reach = (move: AttackMove) => MOVES[move].range * 0.9;
const handFor = (move: AttackMove): Hand => (move === 'jab' ? 'L' : 'R');
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Small seeded PRNG (mulberry32): the fight engine has no randomness, and the CPU's is replayable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
