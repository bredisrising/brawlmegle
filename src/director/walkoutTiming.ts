/**
 * The walkout: Street Fighter 6's in-stage character entrance, before round 1. Beats in seconds from its first frame,
 * cut to the walkout track (public/walkout/walkout.mp3, made with scripts/make-walkout-music.mjs: a dark intro, then a
 * 92 bpm groove, one bar per fighter, a snare roll and a hard stop):
 *
 *   0.00  the stage, dark: spotlights find both fighters walking up to their marks       (drone)
 *   1.71  fighter 1's shot: a slow low 3/4 push-in during their signature action          (the groove lands)
 *   4.32  fighter 2's shot, the same                                                       (next bar)
 *   6.93  the two-shot: they turn to face each other and drop into their stance            (next bar)
 *   8.25  white flash, fire VS in the stage                                               (the snare roll)
 *   9.55  the music stops: ROUND 1 (the countdown's next beat), then FIGHT
 *
 * A custom track (public/walkout/custom.json) can move the beats onto its own hits. Both laptops run the same beats
 * from the same moment (the host's countdown), so they see the same thing.
 */
export type Beats = { p1: number; p2: number; two: number; vs: number; end: number };

export const DEFAULT_BEATS: Beats = { p1: 1.71, p2: 4.32, two: 6.93, vs: 8.25, end: 9.55 };

/**
 * Beats for a track from its cue file: `beats` (any of p1/p2/two/vs/end, seconds after `start`) are taken as given;
 * otherwise `drop` (when fighter 1's shot should start) moves the whole default timing to it. Anything that doesn't
 * make sense (out of order, too short or long) falls back to the defaults.
 */
export function beatsFor(cue: { drop?: unknown; beats?: unknown } | null): Beats {
  if (!cue) return DEFAULT_BEATS;
  const shift = typeof cue.drop === 'number' && Number.isFinite(cue.drop) ? cue.drop - DEFAULT_BEATS.p1 : 0;
  const out = { ...DEFAULT_BEATS };
  for (const k of Object.keys(out) as (keyof Beats)[]) out[k] = Math.max(0.5, out[k] + shift);
  const given = cue.beats && typeof cue.beats === 'object' ? (cue.beats as Record<string, unknown>) : {};
  for (const k of Object.keys(out) as (keyof Beats)[]) {
    const v = given[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  const order = [out.p1, out.p2, out.two, out.vs, out.end];
  const sane = order.every((v, i) => i === 0 || v - order[i - 1] >= 0.4) && out.p1 >= 0.5 && out.end <= 14;
  return sane ? out : DEFAULT_BEATS;
}

/** ROUND 1 holds this long before FIGHT. */
export const ROUND_CALL_SECONDS = 1.15;

const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
/** `?walkout=0` skips the walkout (straight to ROUND 1). */
export const walkoutEnabled = params.get('walkout') !== '0';

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
/** Slow in and out, gentler than smoothstep at the ends (camera moves). */
export const easeInOut = (x: number) => {
  const k = clamp01(x);
  return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
};
export const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3;
export const easeIn = (x: number) => clamp01(x) ** 3;
export const linear = (x: number) => clamp01(x);
/** Overshoot then settle (a slam): 0 -> ~1.12 -> 1. */
export const backOut = (x: number) => {
  const k = clamp01(x) - 1;
  return 1 + k * k * (2.9 * k + 1.9);
};

/** A name as shown: "Avi (CPU hard)" -> { name: "Avi", tag: "CPU hard" }; "Training dummy" -> "Dummy" / "Training". */
export function splitName(full: string): { name: string; tag: string | null } {
  const cpu = full.match(/^(.*?)\s*\((CPU[^)]*)\)\s*$/i);
  if (cpu) return { name: cpu[1], tag: cpu[2] };
  if (/^training dummy$/i.test(full.trim())) return { name: 'Dummy', tag: 'Training' };
  return { name: full, tag: null };
}

/** The signature action each fighter does in their shot (walkoutPose.ts). */
export const SIGNATURES = ['shadowbox', 'knuckles', 'neckroll', 'beckon', 'chestpound', 'gloves', 'flex'] as const;
export type Signature = (typeof SIGNATURES)[number];

/** Each fighter's signature, picked from their name (both laptops agree), never the same one for both. */
export function signatures(p1: string, p2: string): { p1: Signature; p2: Signature } {
  const n = SIGNATURES.length;
  const a = hash(p1) % n;
  let b = hash(p2) % n;
  if (b === a) b = (b + 1) % n;
  return { p1: SIGNATURES[a], p2: SIGNATURES[b] };
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.toLowerCase().charCodeAt(i), 16777619);
  return h >>> 0;
}
