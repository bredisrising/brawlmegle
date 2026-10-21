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
      speed: number; // 0.8–1.3: how fast (the same scale for everyone), a bit more with the other hand up in guard
      windup: number; // 0.8–1.3, how far they loaded up first
      /** Loaded up and held before throwing it: a heavy (slower, harder, parryable). */
      heavy?: boolean;
      reach: number; // peak displacement from rest, body units
      /** Peak outward speed in body units per second (raw, not relative). */
      rawSpeed: number;
      /** Thrown straight off this arm's last strike without getting back to guard first (a windmill, a flurry). */
      chained?: boolean;
      /** The other hand stayed up in guard as this one struck (form). */
      otherGuard?: boolean;
      /** Shape of the motion, for matching against a player's calibration examples (arms only). */
      features?: number[];
    }
  /** The last strike of this limb turned out to be another style at its peak (sent once, up to RESTYLE_MAX_MS after it). */
  | { kind: 'restyle'; limb: LimbName; t: number; onsetT: number; style: StrikeStyle; height: 'high' | 'mid' | 'low' }
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
  /**
   * Guard: both wrists within `radius` of the nose, or both no lower than `chestDrop` under the shoulders and within
   * `chestWidth` of the body's middle with the elbows bent under `maxElbow` degrees (a chest guard).
   */
  guard: { radius: number; holdMs: number; chestDrop: number; chestWidth: number; maxElbow: number };
  /** Torso size ratio beyond which the player counts as stepping in or backing off. */
  advance: { in: number; out: number };
  /** Ignore the same core move (jump, duck, dodge) again within this long. */
  coreCooldownMs: number;
  /**
   * A hand faster than `quiet` (body units/s, against its shoulder) blocks slips for `ms`, one faster than `swing` blocks
   * ducks too: swinging moves the head (real play: every fake dodge came within 600 ms of a fast hand).
   */
  handsCalm: { quiet: number; swing: number; ms: number };
  /** Overhand chops: from at least `start` against the shoulder (body units), coming down faster than `speed`. */
  overhand: { start: number; speed: number };
  /** A hand going over the head faster than this is a punch (a sky punch), slower it's fixing hair or waving. */
  overheadSpeed: number;
  /** A tuck into guard (the hand pulled in across the body, elbow low) travels less than this; farther, it's a hook. */
  tuckReach: number;
  /** A heavy: pulled back at least `windup` (0.8–1.3) from a hold that ended under `holdMs` before the swing. */
  heavy: { windup: number; holdMs: number };
  /** A strike's style gets one more look at its peak, at most this long after it was confirmed (see 'restyle'). */
  restyleMs: number;
  /**
   * The learned move model as a gate and rescue on arm strikes (IntentReader.secondOpinion), on with `gate` 1. A rule
   * strike needs the model's p(rise) to reach `keep`; the model adds its own strike at p(rise) `on` -> `confirm`, and
   * re-arms below `off`. `rescue` 0: no strikes of its own, 1: only where the rules saw a wind-up start, 2: any.
   * `needHips` 1: off unless the hips are in the shot. Held-out real players (nested leave-one-person-out): as many
   * strikes read as the rules alone or a few more, same precision, confirmed ~60 ms sooner (139 -> 76 ms); synthetic
   * suites: false positives 2.5 -> 0.9 a minute, confirm 238 -> 80 ms. Trained with the synthetic everyday motions
   * (waves, scratches, hands coming back up) as negatives; `?model=0` turns it off in the game.
   */
  model: { gate: number; keep: number; on: number; confirm: number; off: number; rescue: number; needHips: number };
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
  guard: { radius: 0.5, holdMs: 120, chestDrop: 0.6, chestWidth: 0.5, maxElbow: 150 },
  advance: { in: 0.08, out: 0.07 },
  coreCooldownMs: 450,
  handsCalm: { quiet: 2.6, swing: 4.5, ms: 600 },
  overhand: { start: -0.1, speed: 3.5 },
  overheadSpeed: 4,
  tuckReach: 0.5,
  heavy: { windup: 1.2, holdMs: 250 },
  restyleMs: 200,
  model: { gate: 1, keep: 0.25, on: 0.65, confirm: 0.9, off: 0.2, rescue: 2, needHips: 0 },
  staleMs: 300,
};

/** The reader's config for the game: the defaults, with the learned move model off if asked (`?model=0`). */
export function readingConfig(moveModel: boolean): IntentConfig {
  return { ...DEFAULT_INTENT, model: { ...DEFAULT_INTENT.model, gate: moveModel ? 1 : 0 } };
}
