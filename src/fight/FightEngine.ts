import { PLAYER_IDS, opponentOf } from '../types';
import type { AttackMove, Command, FightEvent, FighterState, Hand, PlayerId, Stance } from '../types';
import { FIGHT, MOVES, hitstopFrames, hitstunFrames, type MoveSpec } from './moves';

/**
 * Pure TypeScript fight rules: no Three.js, no React, no randomness, fixed 60 Hz tick.
 * Same commands in -> same fight out, so it's testable and K.O. replays come free.
 *
 * The engine decides outcomes (range, timing, blocks, evasion, counters, damage). It never looks at
 * poses: the intent reader says what a player meant, the resolver picks the move, this decides what happens.
 */

type AttackCommand = Extract<Command, { kind: 'attack' }>;
type Attack = {
  move: AttackMove; hand: Hand; spec: MoveSpec; startup: number; scale: number; height: 'head' | 'body'; lunge: number;
  /** Resolved against the defender (hit, blocked or evaded). */
  done: boolean;
  /** Connected: hit or blocked. A punch that connected chains into the next one straight away. */
  landed: boolean;
};
type Fighter = {
  x: number;
  hp: number;
  stamina: number;
  phase: FighterState['phase'];
  frame: number;
  attack: Attack | null;
  /** Frames of hitstun/blockstun left. */
  stun: number;
  evade: { kind: 'slip' | 'duck'; frames: number; dir?: Hand } | null;
  /** Attacks thrown while busy, oldest first, each kept for FIGHT.bufferFrames: fast combos all come out. */
  queue: { command: AttackCommand; frames: number }[];
  /** Punches chained in a row (see chainable). */
  chain: number;
  sinceAttack: number; // seconds
};

const DT = 1 / 60;
const PUNCHES = new Set<AttackMove>(['jab', 'cross', 'hook', 'uppercut']);
/** Both fighters as they were when this tick's swings connected. */
type Moment = { distance: number } & Record<PlayerId, { phase: Fighter['phase']; attack: Attack | null; evade: 'slip' | 'duck' | undefined }>;

export class FightEngine {
  private fighters: Record<PlayerId, Fighter> = { p1: fresh(-0.5), p2: fresh(0.5) };
  /** Global freeze after a hit: both fighters stop for a few frames so the impact lands. */
  private hitstop = 0;
  private tick = 0;

  /** Advance one 60 Hz tick. */
  step(commands: Command[], stances: Record<PlayerId, Stance>): FightEvent[] {
    const events: FightEvent[] = [];
    this.tick++;
    for (const c of commands) this.command(c, events);
    if (this.hitstop > 0) {
      this.hitstop--;
      return events;
    }
    for (const id of PLAYER_IDS) this.advance(id, events);
    // Both swings resolve against the same moment, so a same-tick exchange is a trade, not a P1 win.
    const moment = this.snapshot();
    for (const id of PLAYER_IDS) this.resolve(id, stances, events, moment);
    this.move(stances);
    return events;
  }

  state(player: PlayerId): Readonly<FighterState> {
    const f = this.fighters[player];
    const a = f.attack;
    const length = f.phase === 'startup' ? a?.startup
      : f.phase === 'active' ? a?.spec.active
      : f.phase === 'recovery' ? a?.spec.recovery
      : f.phase === 'hitstun' || f.phase === 'blockstun' ? f.frame + f.stun
      : undefined;
    return {
      x: f.x, hp: f.hp, stamina: f.stamina, phase: f.phase, move: a?.move, frame: f.frame,
      hand: a?.hand, height: a?.height, length, evade: f.evade?.kind, evadeDir: f.evade?.dir,
    };
  }

  /** In hit-stop: the fight is frozen on the impact for a few frames (the director freezes the picture too). */
  get frozen(): boolean {
    return this.hitstop > 0;
  }

  /** Center-to-center distance on the fight line (m). */
  distance(): number {
    return Math.abs(this.fighters.p2.x - this.fighters.p1.x);
  }

  /** Whether a player is evading right now (for the resolver and the director). */
  evading(player: PlayerId): 'slip' | 'duck' | null {
    return this.fighters[player].evade?.kind ?? null;
  }

  reset(): void {
    this.fighters = { p1: fresh(-0.5), p2: fresh(0.5) };
    this.hitstop = 0;
    this.tick = 0;
  }

  private get now() {
    return (this.tick * 1000) / 60;
  }

  private command(c: Command, events: FightEvent[]) {
    const f = this.fighters[c.player];
    if (f.phase === 'ko') return;
    if (c.kind === 'attack') {
      if (f.phase === 'idle') this.start(c.player, c, events);
      else {
        f.queue.push({ command: c, frames: FIGHT.bufferFrames });
        if (f.queue.length > FIGHT.queueSize) f.queue.shift();
      }
    } else if (c.kind === 'defend' && (c.move === 'slip' || c.move === 'duck')) {
      if (f.phase === 'idle' || f.phase === 'recovery') f.evade = { kind: c.move, frames: FIGHT.evadeFrames, dir: c.dir };
    }
    // Blocking comes from Stance.guard every tick; 'anticipate' is for the director.
  }

  private start(id: PlayerId, c: AttackCommand, events: FightEvent[]) {
    const f = this.fighters[id];
    const spec = MOVES[c.move];
    const gassed = f.stamina < FIGHT.gassedBelow;
    // A NaN here would stick: HP that never reaches 0, a position that's always "in range".
    const speed = finiteOr(c.speed, 1);
    const windup = finiteOr(c.windup, 1);
    f.attack = {
      move: c.move,
      hand: c.hand,
      spec,
      startup: Math.max(
        Math.min(FIGHT.minStartup, spec.startup),
        spec.startup + (gassed ? FIGHT.gassedStartup : 0) - clamp(finiteOr(c.headStart ?? 0, 0), 0, FIGHT.maxHeadStart),
      ),
      scale: speed * windup * (gassed ? FIGHT.gassedDamage : 1),
      height: c.height,
      lunge: this.lungeFor(c, spec),
      done: false,
      landed: false,
    };
    f.phase = 'startup';
    f.frame = 0;
    f.evade = null;
    f.stamina = Math.max(0, f.stamina - spec.stamina);
    f.sinceAttack = 0;
    events.push({ t: this.now, type: 'startup', attacker: id, move: c.move });
  }

  private advance(id: PlayerId, events: FightEvent[]) {
    const f = this.fighters[id];
    if (f.phase === 'ko') return;
    f.sinceAttack += DT;
    if (f.sinceAttack > FIGHT.staminaRegenDelay) f.stamina = Math.min(FIGHT.maxStamina, f.stamina + FIGHT.staminaRegen * DT);
    if (f.evade && --f.evade.frames <= 0) f.evade = null;
    if (f.queue.length) {
      if (f.phase === 'idle' || this.chainable(f, f.queue[0].command)) {
        f.chain = f.phase === 'idle' ? 0 : f.chain + 1;
        this.start(id, f.queue.shift()!.command, events);
      }
      for (const q of f.queue) q.frames--;
      f.queue = f.queue.filter((q) => q.frames > 0);
    }
    f.frame++;

    switch (f.phase) {
      case 'hitstun':
      case 'blockstun':
        if (--f.stun <= 0) this.idle(f);
        break;
      case 'startup': {
        const a = f.attack!;
        // Lunge: step in over the startup so a punch thrown from too far still arrives.
        if (a.lunge > 0) this.shift(id, a.lunge / a.startup);
        if (f.frame >= a.startup) {
          f.phase = 'active';
          f.frame = 0;
        }
        break;
      }
      case 'active':
        if (f.frame >= f.attack!.spec.active) {
          if (!f.attack!.done) {
            f.stamina = Math.max(0, f.stamina - FIGHT.whiffCost);
            events.push({ t: this.now, type: 'whiff', attacker: id, move: f.attack!.move });
          }
          f.phase = 'recovery';
          f.frame = 0;
        }
        break;
      case 'recovery':
        if (f.frame >= f.attack!.spec.recovery) this.idle(f);
        break;
    }
  }

  private snapshot(): Moment {
    const of = (f: Fighter) => ({ phase: f.phase, attack: f.attack, evade: f.evade?.kind });
    return { distance: this.distance(), p1: of(this.fighters.p1), p2: of(this.fighters.p2) };
  }

  /**
   * How far a strike steps in. With autoLunge it's worked out here from the distance when the strike actually starts,
   * so a queued punch in a combo still reaches after the last one's knockback pushed the opponent back.
   */
  private lungeFor(c: AttackCommand, spec: MoveSpec) {
    if (c.autoLunge) return clamp(this.distance() - spec.range * 0.9, 0, FIGHT.maxLunge);
    return Math.max(0, finiteOr(c.lunge ?? 0, 0));
  }

  /**
   * Chains: a punch in recovery cancels into the next punch, so jab-cross-hook flows at the speed it's thrown. Right
   * away if the last one connected (hit or blocked), from halfway through recovery on a whiff (so whiffing still
   * leaves a window to punish), and up to FIGHT.maxChain in a row. Kicks and knees don't chain.
   */
  private chainable(f: Fighter, next: AttackCommand) {
    const a = f.attack;
    if (f.phase !== 'recovery' || !a || f.chain >= FIGHT.maxChain) return false;
    if (!PUNCHES.has(a.move) || !PUNCHES.has(next.move)) return false;
    return a.landed || f.frame >= a.spec.recovery * 0.5;
  }

  /** An active attack meets the defender: evaded, blocked, or a hit (maybe a counter). */
  private resolve(id: PlayerId, stances: Record<PlayerId, Stance>, events: FightEvent[], moment: Moment) {
    const f = this.fighters[id];
    // As things stood before either swing landed this tick (the other one may already have hit this fighter).
    const a = moment[id].attack;
    if (moment[id].phase !== 'active' || !a || a.done || f.phase === 'ko') return;
    if (moment.distance > a.spec.range) return; // may still come into range; otherwise it whiffs
    const defenderId = opponentOf(id);
    const g = this.fighters[defenderId];
    const before = moment[defenderId];
    if (g.phase === 'ko') return;
    a.done = true;

    const evade = before.evade;
    const ducked = evade === 'duck' && a.height === 'head' && !a.spec.beatsDuck;
    const slipped = evade === 'slip' && a.spec.straight;
    if (ducked || slipped) {
      // Missed clean: the attacker eats the whiff penalty and is open in recovery (a counter window).
      f.stamina = Math.max(0, f.stamina - FIGHT.whiffCost);
      events.push({ t: this.now, type: 'whiff', attacker: id, move: a.move });
      return;
    }

    // You can block while free or already blocking, not mid-attack or while reeling from a hit.
    const canBlock = before.phase === 'idle' || before.phase === 'blockstun';
    if (stances[defenderId]?.guard && canBlock) {
      const chip = Math.max(1, Math.round(a.spec.chip * a.scale));
      g.hp = Math.max(0, g.hp - chip);
      a.landed = true;
      g.phase = 'blockstun';
      g.stun = FIGHT.blockstun;
      g.frame = 0;
      this.hitstop = Math.max(this.hitstop, 3);
      events.push({ t: this.now, type: 'blocked', attacker: id, move: a.move, damage: chip, hitstopFrames: 3 });
      this.knockback(defenderId, chip);
      if (g.hp <= 0) this.ko(defenderId, id, a.move, events);
      return;
    }

    // Caught mid-attack, or ducking into an uppercut: counter hit.
    const counter = before.phase === 'startup' || before.phase === 'recovery' || (evade === 'duck' && a.spec.beatsDuck);
    const damage = Math.round(a.spec.damage * a.scale * (counter ? FIGHT.counterMultiplier : 1));
    g.hp = Math.max(0, g.hp - damage);
    a.landed = true;
    g.attack = null;
    g.queue = [];
    g.chain = 0;
    g.evade = null;
    g.phase = 'hitstun';
    g.stun = hitstunFrames(damage);
    g.frame = 0;
    const stop = hitstopFrames(damage);
    this.hitstop = Math.max(this.hitstop, stop);
    events.push({ t: this.now, type: counter ? 'counter' : 'hit', attacker: id, move: a.move, damage, hitstopFrames: stop });
    this.knockback(defenderId, damage);
    if (g.hp <= 0) this.ko(defenderId, id, a.move, events);
  }

  private ko(loser: PlayerId, winner: PlayerId, move: AttackMove, events: FightEvent[]) {
    const g = this.fighters[loser];
    g.phase = 'ko';
    g.attack = null;
    events.push({ t: this.now, type: 'ko', attacker: winner, move });
  }

  /**
   * Movement is semi-automatic: leaning in or out (Stance.advance) walks; with no lean, fighters drift to a
   * comfortable distance. Only free fighters move; attacks move through their lunge instead.
   */
  private move(stances: Record<PlayerId, Stance>) {
    for (const id of PLAYER_IDS) {
      const f = this.fighters[id];
      if (f.phase !== 'idle') continue;
      const stance = stances[id];
      const lean = stance?.tracked ? stance.advance : 0;
      const speed = Math.abs(lean) > 0.1
        ? FIGHT.walkSpeed * lean
        : clamp((this.distance() - FIGHT.preferredDistance) * 2, -1, 1) * FIGHT.driftSpeed;
      this.shift(id, speed * DT);
    }
  }

  /** Move a fighter toward (+) or away from (-) the opponent, keeping spacing and arena bounds. */
  private shift(id: PlayerId, amount: number) {
    const f = this.fighters[id];
    const other = this.fighters[opponentOf(id)];
    const toward = Math.sign(other.x - f.x) || (id === 'p1' ? 1 : -1);
    let x = f.x + toward * amount;
    // Don't walk through the opponent.
    if (Math.abs(other.x - x) < FIGHT.minDistance) x = other.x - toward * FIGHT.minDistance;
    f.x = clamp(x, -FIGHT.arenaHalfWidth, FIGHT.arenaHalfWidth);
  }

  private knockback(id: PlayerId, damage: number) {
    this.shift(id, -FIGHT.knockbackPerDamage * damage);
  }

  private idle(f: Fighter) {
    f.phase = 'idle';
    f.frame = 0;
    f.attack = null;
    f.stun = 0;
  }
}

function fresh(x: number): Fighter {
  return {
    x, hp: FIGHT.maxHp, stamina: FIGHT.maxStamina, phase: 'idle', frame: 0,
    attack: null, stun: 0, evade: null, queue: [], chain: 0, sinceAttack: 10,
  };
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const finiteOr = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
