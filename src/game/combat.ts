import type { Vector3 } from 'three';
import type { PlayerId } from '../types';
import type { Hand } from '../vision';
import type { Fighter } from '../player/Fighter';

export type HitZone = 'head' | 'body';
export type HitKind = 'light' | 'heavy' | 'blocked';

export interface HitEvent {
  attacker: PlayerId;
  defender: PlayerId;
  hand: Hand;
  zone: HitZone;
  kind: HitKind;
  damage: number;
  /** World-space impact point (for effects + UI popups). */
  point: Vector3;
}

/**
 * Hit detection between two fighters, run every sim tick.
 *
 * TODO:
 *  - wrist velocity from trackedPose deltas; ignore slow movement
 *  - fist sphere vs defender head/body spheres (worldJoint)
 *  - block = defender wrist near the incoming fist
 *  - per-hand cooldown / re-arm so one swing = one hit
 *  - damage from speed + wind-up distance (see computeDamage)
 */
export function detectHits(_attacker: Fighter, _defender: Fighter, _dt: number): HitEvent[] {
  return [];
}

/**
 * Damage scales with swing speed and how far the arm was pulled back.
 * TODO: tune once real pose data is flowing.
 */
export function computeDamage(speed: number, windup: number, zone: HitZone, blocked: boolean) {
  const base = 3 + speed * 1.5 + windup * 10;
  return base * (zone === 'head' ? 1.3 : 1) * (blocked ? 0.15 : 1);
}
