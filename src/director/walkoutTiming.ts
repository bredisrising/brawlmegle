/**
 * The walkout: a shot-for-shot copy of Street Fighter 6's walkout (Jamie's), before round 1. Beats in seconds from its
 * first frame, cut to the walkout track (public/walkout/walkout.mp3, made with scripts/make-walkout-music.mjs: a low
 * swell, then a 92 bpm trap groove in G that drops as the white clears, with the cuts on beat 3 of each bar):
 *
 *   0.00  white (the flash out of the menus), the stage under it                          (the swell)
 *   1.10  the club, wide and dark: both dance-walk up to their marks, fighter 1's arm up  (the drop)
 *   2.40  the camera's pushed in on fighter 1: arm swept down, rolling hands, the finger wag, hands up
 *   5.01  hard cut to fighter 2, low: arm up, a full spin, chin up                         (a stop, then back in)
 *   7.62  pulls back to the two of them: fighter 1 drops into a handstand freeze, fighter 2 hits a quick spin
 *  10.23  gold flash, the fire VS in the stage                                             (the big hit)
 *  11.10  the music stops: ROUND 1 (the countdown's next beat), then FIGHT
 *
 * A custom track (public/walkout/custom.json) can move the beats onto its own hits. Both laptops run the same beats
 * from the same moment (the host's countdown), so they see the same thing.
 */
export type Beats = { open: number; p1: number; p2: number; two: number; vs: number; end: number };

export const DEFAULT_BEATS: Beats = { open: 1.1, p1: 2.4, p2: 5.01, two: 7.62, vs: 10.23, end: 11.1 };
/** One beat of the walkout track (92 bpm): the dancing steps and the crowd bounce to it. */
export const BEAT = 60 / 92;

const ORDER = ['open', 'p1', 'p2', 'two', 'vs', 'end'] as const;

/**
 * Beats for a track from its cue file: `beats` (any of open/p1/p2/two/vs/end, seconds after `start`) are taken as
 * given; otherwise `drop` (when fighter 1's shot should start) moves the whole default timing to it. Anything that
 * doesn't make sense (out of order, too short or long) falls back to the defaults.
 */
export function beatsFor(cue: { drop?: unknown; beats?: unknown } | null): Beats {
  if (!cue) return DEFAULT_BEATS;
  const shift = typeof cue.drop === 'number' && Number.isFinite(cue.drop) ? cue.drop - DEFAULT_BEATS.p1 : 0;
  const out = { ...DEFAULT_BEATS };
  for (const k of ORDER) out[k] = Math.max(0.3, out[k] + shift);
  const given = cue.beats && typeof cue.beats === 'object' ? (cue.beats as Record<string, unknown>) : {};
  for (const k of ORDER) {
    const v = given[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  const order = ORDER.map((k) => out[k]);
  const sane = order.every((v, i) => i === 0 || v - order[i - 1] >= (i === 1 ? 0.3 : 0.4)) && out.open >= 0 && out.end <= 14;
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
