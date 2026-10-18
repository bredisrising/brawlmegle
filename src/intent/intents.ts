import type { PreprocessConfig } from './preprocess';
import { DEFAULT_PREPROCESS } from './preprocess';

/**
 * What the player's body did, independent of fighting technique. The resolver (next stage) combines these
 * with the fight state to pick an actual move, so a wild swing and a textbook hook are the same intent.
 */
export type LimbName = 'armL' | 'armR' | 'legL' | 'legR';
export type StrikeStyle = 'straight' | 'hook' | 'upper' | 'knee' | 'kick';

export type Intent =
  /** A limb started moving fast: start a wind-up animation now, before the strike is confirmed. */
  | { kind: 'anticipate'; limb: LimbName; t: number }
  /** The wind-up didn't turn into a strike; blend back. */
  | { kind: 'cancel'; limb: LimbName; t: number; reason?: 'too small' | 'going down' | 'raising guard' | 'both hands up' | 'both hands moved' | 'not a punch' | 'support leg' }
  | {
      kind: 'strike';
      limb: LimbName;
      t: number; // when it was confirmed
      onsetT: number; // when the motion started
      style: StrikeStyle;
      height: 'high' | 'mid' | 'low';
      /** Unit direction of the strike in body space: x = outward from this limb's side, y = up, z = toward camera. */
      dir: { out: number; up: number; fwd: number };
      speed: number; // 0.8–1.3, relative to this player's own typical speed
      windup: number; // 0.8–1.3, how far they loaded up first
      reach: number; // peak displacement from rest, body units
      /** Peak outward speed in body units per second (raw, not relative). */
      rawSpeed: number;
      /** Shape of the motion, for matching against a player's calibration examples (arms only). */
      features?: number[];
    }
  | { kind: 'jump'; t: number; power: number }
  | { kind: 'duck'; t: number }
  | { kind: 'dodge'; t: number; dir: 'L' | 'R' } // the player's left or right
  | { kind: 'guard'; t: number; up: boolean };

export type LimbConfig = {
  /** Outward speed that starts a strike (body units per second). */
  onsetSpeed: number;
  /** Minimum distance from rest before onset counts. */
  onsetDist: number;
  /** Peak distance from rest needed to confirm a strike. */
  strikeDist: number;
  /** Back within this distance of rest = ready to strike again. */
  returnDist: number;
  /** Give up on a wind-up that hasn't peaked after this long. */
  maxWindupMs: number;
  /** Ready again after this long even if the limb never came back. */
  recoverMs: number;
  /** Below this speed the limb counts as resting, and its rest position recalibrates. */
  quietSpeed: number;
  /**
   * Arms: confirm a strike no sooner than this after its onset, so the style (straight, hook, uppercut) is read
   * from more of the motion. Free up to the engine's head start: the wind-up shown since the onset counts
   * toward the strike's startup.
   */
  confirmMs?: number;
};

export type IntentConfig = {
  preprocess: PreprocessConfig;
  arm: LimbConfig;
  leg: LimbConfig;
  /** Legs must also rise this much (body units) to count, so walking isn't kicking. */
  legRise: number;
  /** How much depth (z) counts versus image-plane motion. It's noisy, so less than 1. */
  depthWeight: number;
  /** Time constant for rest-position calibration (seconds). */
  restSeconds: number;
  jump: { rise: number; speed: number };
  duck: { drop: number; speed: number };
  dodge: { shift: number; speed: number };
  guard: { radius: number; holdMs: number };
  /** Torso size ratio beyond which the player counts as stepping in or backing off. */
  advance: { in: number; out: number };
  /** Ignore the same core move (jump, duck, dodge) again within this long. */
  coreCooldownMs: number;
  /** No new frames for this long (host clock) = player lost. */
  staleMs: number;
};

export const DEFAULT_INTENT: IntentConfig = {
  preprocess: DEFAULT_PREPROCESS,
  arm: { onsetSpeed: 2.2, onsetDist: 0.12, strikeDist: 0.24, returnDist: 0.22, maxWindupMs: 350, recoverMs: 600, quietSpeed: 0.8, confirmMs: 60 },
  leg: { onsetSpeed: 1.8, onsetDist: 0.12, strikeDist: 0.35, returnDist: 0.25, maxWindupMs: 450, recoverMs: 800, quietSpeed: 0.8 },
  legRise: 0.2,
  depthWeight: 0.5,
  restSeconds: 1.5,
  jump: { rise: 0.1, speed: 1.0 },
  duck: { drop: 0.28, speed: 1.0 },
  dodge: { shift: 0.13, speed: 0.6 },
  guard: { radius: 0.5, holdMs: 120 },
  advance: { in: 0.08, out: 0.07 },
  coreCooldownMs: 450,
  staleMs: 300,
};
