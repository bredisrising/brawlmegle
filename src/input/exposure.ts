/** The camera's exposure time range, as the browser gives it: units of 100 µs (40 = 1/250 s). */
export type ExposureCaps = { min: number; max: number; step?: number };

/** Never shorter than 1/1000 s: past that the picture only gets darker and noisier for little less blur. */
const SHORTEST = 10;
/** Where the search starts: 1/250 s, about a quarter of what a webcam picks on its own indoors. */
const START = 40;
/**
 * The picture may get darker than the camera's own exposure makes it, but not by more than this, and its median
 * brightness (luma, 0–255) never under LUMA_MIN. A room whose own exposure can't reach LUMA_MIN is left alone.
 */
const DARKER = 0.8;
const LUMA_FLOOR = 80;
const LUMA_MIN = 45;
/** Brightness grows with exposure about as luma ∝ time^(1/2.2) (the camera's gamma): used to aim each step. */
const GAMMA = 2.2;
/** Found when the best bright-enough time is within this factor of a too-dark one, or after this many tries. */
const CLOSE_ENOUGH = 1.25;
const MAX_STEPS = 8;
/** Holding: this far off the floor, this many checks in a row (the light changed), and it searches again. */
const TOO_DARK = 0.75;
const TOO_BRIGHT = 1.8;
const DRIFT_CHECKS = 3;

/**
 * Finds the shortest exposure time that keeps the picture bright enough: short exposure cuts the motion blur every
 * punch leaves (the wrist lands mid-streak), but in a dim room it makes the picture too dark to track. Fed the
 * picture's median brightness at each exposure it asks for; pure, so the camera side (ShortExposure) does the timing.
 */
export class ExposureTuner {
  /** The brightness to keep: a bit under what the camera's own exposure gave, within limits. */
  readonly floor: number;
  /** 'search' while trying times, 'hold' on the one found, 'auto' when no short one is bright enough. */
  phase: 'search' | 'hold' | 'auto' = 'search';
  /** The exposure time asked for last. */
  current: number;
  private readonly lo: number;
  private readonly hi: number;
  /** Longest time seen too dark, shortest seen bright enough. */
  private dark = 0;
  private bright = Infinity;
  private steps = 0;
  private drift = 0;

  /** `frameRate`: the camera's (the exposure can't be longer than a frame); `autoLuma`: brightness on its own exposure. */
  constructor(private readonly caps: ExposureCaps, frameRate: number, autoLuma: number) {
    this.floor = Math.max(LUMA_MIN, Math.min(LUMA_FLOOR, autoLuma * DARKER));
    this.lo = Math.max(caps.min, SHORTEST);
    this.hi = Math.min(caps.max, (0.9 * 10_000) / (frameRate > 0 ? frameRate : 30));
    this.current = this.round(Math.min(Math.max(START, this.lo), this.hi));
    if (autoLuma < LUMA_MIN || this.lo > this.hi) this.phase = 'auto';
  }

  /** The brightness measured at `current`: the next exposure time to set, 'auto' to give the camera its own back, or null. */
  measured(luma: number): number | 'auto' | null {
    if (this.phase === 'auto') return null;
    if (this.phase === 'hold') {
      const off = luma < this.floor * TOO_DARK ? -1 : luma > this.floor * TOO_BRIGHT ? 1 : 0;
      this.drift = off !== 0 && Math.sign(this.drift) === off ? this.drift + off : off;
      if (Math.abs(this.drift) < DRIFT_CHECKS) return null;
      // The light changed (a lamp switched on, the sun went in): search again from here.
      this.phase = 'search';
      this.dark = this.steps = this.drift = 0;
      this.bright = Infinity;
    }
    const time = this.current;
    if (luma >= this.floor) this.bright = Math.min(this.bright, time);
    else this.dark = Math.max(this.dark, time);
    this.steps++;
    if (this.bright === Infinity && (time >= this.hi || this.steps >= MAX_STEPS)) {
      this.phase = 'auto';
      return 'auto';
    }
    const found = this.bright <= this.lo || this.bright <= Math.max(this.dark, this.lo) * CLOSE_ENOUGH || this.steps >= MAX_STEPS;
    const next = found ? this.bright : this.aim(luma);
    if (found || next === this.bright) this.phase = 'hold';
    if (next === time) return null;
    this.current = next;
    return next;
  }

  /** The next time to try: where the gamma says the floor is, kept inside what's already known. */
  private aim(luma: number) {
    const ratio = Math.min(3, Math.max(1 / 3, ((this.floor * 1.1) / Math.max(luma, 1)) ** GAMMA));
    let next = Math.min(this.hi, Math.max(this.lo, this.current * ratio));
    if (next <= this.dark || next >= this.bright) next = Math.sqrt(Math.max(this.dark, this.lo) * Math.min(this.bright, this.hi));
    return Math.min(this.round(next), this.bright);
  }

  private round(time: number) {
    const step = this.caps.step && this.caps.step > 0 ? this.caps.step : 1;
    return Math.min(this.caps.max, Math.max(this.caps.min, Math.round(time / step) * step));
  }
}

/** Median luma (0–255) of RGBA pixels: the picture's brightness, not fooled by a lamp or a dark corner. */
export function medianLuma(rgba: ArrayLike<number>): number {
  const histogram = new Uint32Array(256);
  const n = Math.floor(rgba.length / 4);
  for (let i = 0; i < n; i++) histogram[Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2])]++;
  let seen = 0;
  for (let v = 0; v < 256; v++) if ((seen += histogram[v]) * 2 >= n) return v;
  return 0;
}

/** The parts of a camera track ShortExposure uses (a fake one in tests). */
type ExposureTrack = Pick<MediaStreamTrack, 'getCapabilities' | 'getSettings' | 'applyConstraints'>;

/**
 * The camera's exposure time range, if the page may set it and give it back: many Windows and Linux webcams allow
 * it, MacBook cameras and Chrome's fake camera don't.
 */
export function exposureCaps(track: ExposureTrack): ExposureCaps | null {
  try {
    const caps = (track.getCapabilities?.() ?? {}) as { exposureMode?: string[]; exposureTime?: ExposureCaps };
    const time = caps.exposureTime;
    if (!caps.exposureMode?.includes('manual') || !caps.exposureMode.includes('continuous') || !time || !(time.max > 0)) return null;
    return time;
  } catch {
    return null;
  }
}

/** How long the camera's own exposure gets to settle before it's measured, and a new time to show up. */
const AUTO_SETTLE_MS = 1000;
const SETTLE_MS = 400;
/** How often a held exposure is checked against the room's light. */
const CHECK_MS = 2000;
/** A camera that hasn't taken a setting by then is treated as refusing it. */
const APPLY_TIMEOUT_MS = 2000;

/**
 * Short exposure on a live camera: measures the picture on the camera's own exposure, runs ExposureTuner against it,
 * then keeps checking. release() gives the camera its own exposure back: CameraSource calls it when the tab hides or
 * closes and before the camera stops, since some webcams keep a manual exposure into the next app that opens them
 * (the player's next video call). Any failure gives it back too, and it doesn't try again on that camera.
 */
export class ShortExposure {
  state: 'off' | 'measuring' | 'search' | 'hold' | 'auto' | 'failed' = 'off';
  /** The exposure time on the camera now, while it's manual. */
  time: number | null = null;
  /** The camera's exposure is the page's (manual) right now: release() has something to give back. */
  manual = false;
  private run = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly track: ExposureTrack,
    private readonly caps: ExposureCaps,
    /** The picture's median brightness right now (null: no picture yet). */
    private readonly luma: () => number | null,
  ) {}

  /** Start (or start over, after release()). A no-op while running, or after a failure. */
  start() {
    if (this.state !== 'off') return;
    const run = ++this.run;
    this.state = 'measuring';
    this.after(run, AUTO_SETTLE_MS, () => this.begin(run));
  }

  /** The camera's own exposure back, and any search stopped. Resolves once the camera took it (or gave up trying). */
  async release() {
    this.run++;
    clearTimeout(this.timer);
    if (this.state !== 'failed') this.state = 'off';
    await this.restore();
  }

  private async begin(run: number): Promise<void> {
    const auto = this.luma();
    if (auto === null) return this.after(run, SETTLE_MS, () => this.begin(run));
    const tuner = new ExposureTuner(this.caps, this.track.getSettings().frameRate ?? 30, auto);
    if (tuner.phase === 'auto') return void (this.state = 'auto');
    this.manual = true;
    // Two steps: the exposure time is ignored until the camera is in manual mode.
    if (!(await this.apply(run, { exposureMode: 'manual' })) || !(await this.apply(run, { exposureTime: tuner.current }))) return;
    this.state = 'search';
    this.after(run, SETTLE_MS, () => this.check(run, tuner));
  }

  private async check(run: number, tuner: ExposureTuner) {
    const luma = this.luma();
    const next = luma === null ? null : tuner.measured(luma);
    if (next === 'auto') {
      // Even the longest time this frame rate allows is too dark: the camera's own exposure does better.
      this.state = 'auto';
      return this.restore();
    }
    if (next !== null && !(await this.apply(run, { exposureTime: next }))) return;
    this.state = tuner.phase === 'hold' ? 'hold' : 'search';
    this.after(run, tuner.phase === 'hold' ? CHECK_MS : SETTLE_MS, () => this.check(run, tuner));
  }

  /** One setting. False if this run was stopped meanwhile, or it failed (then the camera gets its own back). */
  private async apply(run: number, set: { exposureMode?: string; exposureTime?: number }) {
    if (run !== this.run) return false;
    try {
      await within(this.track.applyConstraints({ advanced: [set as MediaTrackConstraintSet] }), APPLY_TIMEOUT_MS);
      const now = this.track.getSettings() as { exposureMode?: string; exposureTime?: number };
      // Advanced constraints are only tried: a camera that ignored manual mode doesn't really allow it.
      if (set.exposureMode && now.exposureMode !== undefined && now.exposureMode !== set.exposureMode) throw new Error(`exposure mode stayed ${now.exposureMode}`);
      if (set.exposureTime !== undefined) this.time = now.exposureTime ?? set.exposureTime;
      return run === this.run;
    } catch (err) {
      if (run !== this.run) return false;
      console.warn('[camera] short exposure failed, the camera keeps its own', err);
      this.run++;
      this.state = 'failed';
      await this.restore();
      return false;
    }
  }

  private async restore() {
    if (!this.manual) return;
    this.manual = false;
    this.time = null;
    try {
      await within(this.track.applyConstraints({ advanced: [{ exposureMode: 'continuous' } as MediaTrackConstraintSet] }), APPLY_TIMEOUT_MS);
    } catch (err) {
      console.warn("[camera] couldn't give the camera its own exposure back", err);
    }
  }

  private after(run: number, ms: number, next: () => unknown) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => run === this.run && void next(), ms);
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
