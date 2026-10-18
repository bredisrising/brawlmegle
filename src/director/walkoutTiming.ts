/**
 * The walkout's beats, in seconds from its first frame, cut to the walkout track (public/walkout/walkout.mp3, made
 * with scripts/make-walkout-music.mjs). The hits were measured from the track: snare-roll build, the drop at 1.07,
 * a break at ~1.7, back in at 2.15, stabs at 3.21 / 3.86 / 4.07 / 4.50, and a hard stop at 5.5.
 *
 *   0.00  P1's shot: fire, materialize, crouched power-up       (snare roll)
 *   1.07  P1's name slams, hero pose, punch-in                   (the drop)
 *   1.72  flame wipe across                                      (the break)
 *   2.15  P2's shot (P2 materialized under the wipe)             (back in)
 *   3.21  P2's name slams                                        (stab)
 *   3.62  flame wipe back, "ARE YOU READY?"
 *   3.86  VS: both fighters, the split, VS slams                 (stab)
 *   4.50  READY? tag                                             (stab, on the bark's "READY")
 *   5.50  the music stops: ROUND 1 (the countdown's next beat), then FIGHT
 *
 * Both laptops run the same table from the same moment (the host's countdown), so they see the same thing.
 */
export const WALKOUT = {
  p1: 0,
  p1Slam: 1.07,
  p1Hit: 1.51,
  wipe1: 1.72,
  /** P2 starts materializing under the wipe, so they're up to the chest when the wipe clears. */
  p2Spawn: 1.98,
  p2: 2.15,
  p2Slam: 3.21,
  p2Hit: 3.86,
  wipe2: 3.6,
  readyBark: 3.62,
  vs: 3.86,
  ready: 4.5,
  flash: 5.38,
  end: 5.5,
  /** How long each flame wipe takes to cover the screen and burn away again. */
  wipeIn: 0.26,
  wipeOut: 0.3,
} as const;

/** ROUND 1 holds this long before FIGHT. */
export const ROUND_CALL_SECONDS = 1.15;

const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
/** `?walkout=0` skips the walkout (straight to ROUND 1). */
export const walkoutEnabled = params.get('walkout') !== '0';
/** How long the countdown's first beat (the walkout) lasts. */
export const WALKOUT_SECONDS = walkoutEnabled ? WALKOUT.end : 0;

/** Keyframes: value at time t from [time, value] pairs (sorted), eased between them; holds the ends. */
export function kf(t: number, keys: readonly (readonly [number, number])[], ease: (x: number) => number = smoothstep) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      return v0 + (v1 - v0) * ease((t - t0) / Math.max(1e-6, t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const smoothstep = (x: number) => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
export const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3;
export const easeIn = (x: number) => clamp01(x) ** 3;
export const linear = (x: number) => clamp01(x);
/** Overshoot then settle (a slam): 0 -> ~1.12 -> 1. */
export const backOut = (x: number) => {
  const k = clamp01(x) - 1;
  return 1 + k * k * (2.9 * k + 1.9);
};

/** A name as shown big: "Avi (CPU hard)" -> { name: "Avi", tag: "CPU hard" }; "Training dummy" -> "Dummy" / "Training". */
export function splitName(full: string): { name: string; tag: string | null } {
  const cpu = full.match(/^(.*?)\s*\((CPU[^)]*)\)\s*$/i);
  if (cpu) return { name: cpu[1], tag: cpu[2] };
  if (/^training dummy$/i.test(full.trim())) return { name: 'Dummy', tag: 'Training' };
  return { name: full, tag: null };
}

/** The entrance pose each fighter strikes on their slam: picked from the name, so both laptops agree. */
export type EntranceKind = 'point' | 'flex' | 'sky';
const KINDS: EntranceKind[] = ['point', 'flex', 'sky'];
export function entranceKinds(p1: string, p2: string): { p1: EntranceKind; p2: EntranceKind } {
  const a = hash(p1) % KINDS.length;
  let b = hash(p2) % KINDS.length;
  if (b === a) b = (b + 1) % KINDS.length;
  return { p1: KINDS[a], p2: KINDS[b] };
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.toLowerCase().charCodeAt(i), 16777619);
  return h >>> 0;
}
