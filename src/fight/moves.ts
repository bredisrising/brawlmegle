import type { AttackMove } from '../types';

/**
 * Frame data at 60 fps, fighters 1 m tall. Starting values to tune by playing.
 * The camera and the reader already cost ~100–150 ms before a strike reaches the engine (the director shows the
 * wind-up from the first sign of it), so startups are short enough to feel like yours and still long enough to read.
 */
export type MoveSpec = {
  startup: number;
  active: number;
  recovery: number;
  damage: number;
  /** Farthest center-to-center distance (m) at which it connects. */
  range: number;
  /** Damage that gets through a block. */
  chip: number;
  stamina: number;
  /** Straights can be slipped; everything aimed at the head can be ducked except uppercuts. */
  straight: boolean;
  beatsDuck: boolean;
};

export const MOVES: Record<AttackMove, MoveSpec> = {
  jab: { startup: 6, active: 3, recovery: 10, damage: 5, range: 0.85, chip: 1, stamina: 6, straight: true, beatsDuck: false },
  cross: { startup: 10, active: 3, recovery: 18, damage: 10, range: 0.85, chip: 2, stamina: 10, straight: true, beatsDuck: false },
  hook: { startup: 10, active: 4, recovery: 18, damage: 9, range: 0.7, chip: 2, stamina: 10, straight: false, beatsDuck: false },
  uppercut: { startup: 12, active: 3, recovery: 22, damage: 13, range: 0.55, chip: 3, stamina: 12, straight: false, beatsDuck: true },
  knee: { startup: 12, active: 4, recovery: 20, damage: 11, range: 0.55, chip: 2, stamina: 10, straight: false, beatsDuck: true },
  kick: { startup: 15, active: 4, recovery: 24, damage: 14, range: 1.0, chip: 3, stamina: 14, straight: true, beatsDuck: false },
  // The super: costs a full meter, never connects up close (range 0); it throws a projectile (FightEngine.fly).
  fireball: { startup: 16, active: 2, recovery: 24, damage: 16, range: 0, chip: 4, stamina: 0, straight: true, beatsDuck: false },
};

export const FIGHT = {
  maxHp: 100,
  maxStamina: 100,
  /** Below this, punches are slower and weaker. */
  gassedBelow: 20,
  gassedDamage: 0.6,
  gassedStartup: 4,
  /** Extra stamina cost for a miss. */
  whiffCost: 8,
  /**
   * Mashing: each attack thrown within mashWindow seconds of an earlier one that didn't connect adds a level (up to
   * mashMax); each level adds mashStartup frames and takes mashDamage off the damage. Landing a hit clears it.
   */
  mashWindow: 1.2,
  mashMax: 4,
  mashStartup: 2,
  mashDamage: 0.12,
  staminaRegen: 15, // per second
  staminaRegenDelay: 0.6, // seconds after the last attack
  counterMultiplier: 1.5,
  blockstun: 8,
  /**
   * Hitting a guard costs the attacker: no chaining off a blocked punch, this many extra recovery frames (so the
   * blocker is free first and can punish), extra stamina, and it counts as a miss for mashing. Spamming a blocker
   * gets slower and weaker, and letting go of the guard to swing back is the right answer, not a trap.
   */
  blockRecovery: 7,
  blockCost: 4,
  /**
   * Moves a guard can't stop: they hit the blocker for full damage ("guard break"). Leg strikes are the slowest moves,
   * so they're readable and can be punched out of: block beats punches, legs beat block, punches beat legs. Knee or
   * kick is only the distance (the resolver), so both break a guard: lifting a leg always does what the player meant.
   */
  guardBreakers: ['kick', 'knee'] as readonly string[],
  /**
   * The guard wears out, so nobody can turtle forever: every blocked hit takes a chunk (guardPerBlock). Empty: the guard
   * is crushed, a short stagger and no blocking for guardLockout seconds while it refills. Let go and it comes back
   * (guardRegen per second, after guardRegenDelay). Just holding it costs nothing (guardDrain 0): real players keep
   * their hands up between swings, and a drain crushed the only defense that worked at the hackathon (skill.test.ts).
   */
  guardMax: 100,
  guardDrain: 0,
  guardPerBlock: 10,
  guardRegen: 30,
  guardRegenDelay: 0.5,
  guardLockout: 2.5,
  guardCrushStun: 20,
  /** A punch loaded up at least this much (Command.windup) is a heavy: heavyStartup frames slower, heavyDamage x windup. */
  heavyWindup: 1.15,
  heavyStartup: 4,
  heavyDamage: 1.15,
  /** A guard raised within this many frames of a punch starting calls the punch off (FightEngine.guardFirst). */
  guardCancelFrames: 9,
  /** Slip and duck stay effective this many frames. */
  evadeFrames: 15,
  /** Attacks thrown while busy wait this long for the fighter to be free (or to chain), so none get lost. */
  bufferFrames: 24,
  /** How many attacks can wait at once (a fast three-punch combo: one swinging, two waiting). */
  queueSize: 2,
  /** Punches in a row that can cancel each other's recovery (see FightEngine.chainable). */
  maxChain: 4,
  /**
   * A strike's wind-up already shown on screen (from the reader's first sign of the motion) counts toward its
   * startup, up to this many frames, but never below minStartup: what you threw lands sooner, still readable.
   */
  maxHeadStart: 8,
  minStartup: 3,
  /** Super meter: filled by landing hits (and a little by taking them or blocking); a full one is a fireball. */
  maxMeter: 100,
  meterOnHit: 12,
  meterOnHurt: 7,
  meterOnBlock: 4,
  /** Fireball speed along the fight line (m/s), and how close it must get to the defender to connect. */
  fireballSpeed: 2.2,
  fireballReach: 0.12,
  /** Farthest a strike steps in to reach (m). Beyond that it whiffs: spacing still matters. */
  maxLunge: 0.4,
  /** Fighters can't get closer than this (m). */
  minDistance: 0.35,
  arenaHalfWidth: 1.6,
  /** Leaning fully in or out moves this fast (m/s). */
  walkSpeed: 0.9,
  /** With no lean input, fighters drift toward this distance (m) at driftSpeed. */
  preferredDistance: 0.75,
  driftSpeed: 0.25,
  knockbackPerDamage: 0.02,
} as const;

export const hitstopFrames = (damage: number) => Math.min(14, Math.round(4 + damage / 2));
export const hitstunFrames = (damage: number) => Math.round(10 + damage);
