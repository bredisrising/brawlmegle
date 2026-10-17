import type { AttackMove } from '../types';

/**
 * Frame data at 60 fps, fighters 1 m tall. Starting values to tune by playing.
 * Webcam input already costs ~100–150 ms, so startups are slow enough to see coming: a heavyweight
 * slugfest, not a twitch fighter.
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
  jab: { startup: 8, active: 3, recovery: 10, damage: 5, range: 0.85, chip: 1, stamina: 6, straight: true, beatsDuck: false },
  cross: { startup: 13, active: 3, recovery: 18, damage: 10, range: 0.85, chip: 2, stamina: 10, straight: true, beatsDuck: false },
  hook: { startup: 12, active: 4, recovery: 18, damage: 9, range: 0.7, chip: 2, stamina: 10, straight: false, beatsDuck: false },
  uppercut: { startup: 15, active: 3, recovery: 22, damage: 13, range: 0.55, chip: 3, stamina: 12, straight: false, beatsDuck: true },
  knee: { startup: 14, active: 4, recovery: 20, damage: 11, range: 0.55, chip: 2, stamina: 10, straight: false, beatsDuck: true },
  kick: { startup: 18, active: 4, recovery: 24, damage: 14, range: 1.0, chip: 3, stamina: 14, straight: true, beatsDuck: false },
};

export const FIGHT = {
  maxHp: 100,
  maxStamina: 100,
  /** Below this, punches are slower and weaker. */
  gassedBelow: 20,
  gassedDamage: 0.6,
  gassedStartup: 4,
  /** Extra stamina cost for a miss. */
  whiffCost: 5,
  staminaRegen: 15, // per second
  staminaRegenDelay: 0.6, // seconds after the last attack
  counterMultiplier: 1.5,
  blockstun: 8,
  /** Slip and duck stay effective this many frames. */
  evadeFrames: 15,
  /** Commands that arrive during recovery wait this long for the fighter to be free. */
  bufferFrames: 6,
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
