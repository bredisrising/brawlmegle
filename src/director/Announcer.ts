/**
 * The announcer's barks and the crowd: pre-made clips in public/announcer/ (scripts/make-announcer.mjs), played
 * through an arena: a touch of reverb and a compressor so they sit on top of the fight like a broadcast. Silent
 * (no errors) when the clips haven't been generated. Both laptops play them from the same moments.
 */
export type Bark =
  | 'fight' | 'ko' | 'perfect' | 'counter' | 'combo' | 'great' | 'incredible' | 'fireball' | 'first'
  | 'time' | 'draw' | 'ready' | 'round' | 'win' | 'danger';
export type Crowd = 'cheer' | 'ooh' | 'roar' | 'murmur';

const BASE = `${import.meta.env.BASE_URL}announcer/`;

export class Announcer {
  private ctx: AudioContext | null = null;
  private out: AudioNode | null = null;
  private clips = new Map<string, AudioBuffer>();
  private available: Record<string, string> | null = null;
  private loading: Promise<void> | null = null;
  private lastBark = 0;
  muted = false;

  constructor() {
    // Audio can only start after a user gesture; load and decode then.
    const unlock = () => void this.load();
    window.addEventListener('pointerdown', unlock, { once: true, passive: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  /** A shout. Barks don't stack: a new one within 400 ms of the last is dropped (a K.O. still beats a combo). */
  bark(name: Bark, force = false) {
    const now = performance.now();
    if (!force && now - this.lastBark < 400) return;
    this.lastBark = now;
    this.play(name, 1, true);
  }

  crowd(name: Crowd, volume = 0.5) {
    this.play(`crowd-${name}`, volume, false);
  }

  /** Fetch and decode a music cue (a URL) once audio is unlocked, so it starts on time when it's needed. */
  preloadMusic(url: string) {
    if (!this.music.has(url)) {
      this.music.set(
        url,
        this.load().then(async () => {
          if (!this.ctx) return null;
          try {
            return await this.ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
          } catch {
            return null;
          }
        }),
      );
    }
    return this.music.get(url)!;
  }

  /**
   * Play a music cue from `offset` seconds into the file, `delay` seconds from now (dry, under the barks). The handle
   * fades it out (a skip, or the end of a cue that runs long). Silent when muted, not yet unlocked, or the file is missing.
   */
  playMusic(url: string, volume = 0.6, offset = 0, delay = 0) {
    let src: AudioBufferSourceNode | null = null;
    let gain: GainNode | null = null;
    let stopped = false;
    if (!this.muted) {
      void this.preloadMusic(url).then((buffer) => {
        if (stopped || !buffer || !this.ctx || !this.out || this.ctx.state !== 'running' || offset >= buffer.duration) return;
        src = this.ctx.createBufferSource();
        src.buffer = buffer;
        gain = this.ctx.createGain();
        gain.gain.value = volume;
        src.connect(gain).connect(this.out);
        src.start(this.ctx.currentTime + Math.max(0, delay), Math.max(0, offset));
      });
    }
    return {
      stop: (fade = 0.12) => {
        stopped = true;
        if (!src || !gain || !this.ctx) return;
        const now = this.ctx.currentTime;
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + fade);
        src.stop(now + fade + 0.02);
      },
    };
  }

  private readonly music = new Map<string, Promise<AudioBuffer | null>>();

  private play(name: string, volume: number, reverb: boolean) {
    if (this.muted) return;
    void this.load().then(() => {
      const buffer = this.clips.get(name);
      if (!buffer || !this.ctx || !this.out || this.ctx.state !== 'running') return;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      src.connect(gain);
      if (reverb && this.reverb) {
        gain.connect(this.out);
        const send = this.ctx.createGain();
        send.gain.value = 0.35;
        gain.connect(send).connect(this.reverb);
      } else {
        gain.connect(this.out);
      }
      src.start();
    });
  }

  private reverb: ConvolverNode | null = null;

  private load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const res = await fetch(`${BASE}manifest.json`);
        if (!res.ok) return; // not generated yet: stay silent
        this.available = ((await res.json()) as { clips: Record<string, string> }).clips;
      } catch {
        return;
      }
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      void ctx.resume();
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 4;
      const master = ctx.createGain();
      master.gain.value = 0.9;
      comp.connect(master).connect(ctx.destination);
      this.out = comp;
      // An arena: a short, bright tail of decaying noise.
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = arena(ctx, 1.4);
      this.reverb.connect(comp);
      await Promise.all(
        Object.entries(this.available ?? {}).map(async ([name, file]) => {
          try {
            // Low priority: 19 clips (~0.75 MB) load on the first click, next to the fighter and pose model downloads.
            const data = await (await fetch(BASE + file, { priority: 'low' })).arrayBuffer();
            this.clips.set(name, await ctx.decodeAudioData(data));
          } catch {
            // One bad clip doesn't silence the rest.
          }
        }),
      );
    })();
    return this.loading;
  }
}

function arena(ctx: AudioContext, seconds: number) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  return buf;
}
