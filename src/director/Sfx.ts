/**
 * Fight sounds, synthesized with WebAudio (no files to load): thuds for hits, a crunch for counters, a click for
 * blocks, whooshes for strikes, a boom for the K.O., countdown beeps and a shimmer when a fighter materializes.
 * Browsers only allow audio after a user gesture; the context starts on the first click or key press.
 */
export type SfxKind = 'hit' | 'heavy' | 'counter' | 'blocked' | 'whoosh' | 'ko' | 'beep' | 'go' | 'spawn';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  constructor() {
    const unlock = () => {
      this.ensure();
      void this.ctx?.resume();
    };
    window.addEventListener('pointerdown', unlock, { once: false, passive: true });
    window.addEventListener('keydown', unlock, { once: false });
  }

  play(kind: SfxKind, strength = 1) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.005;
    switch (kind) {
      case 'hit':
        this.thump(t, 140, 55, 0.16, 0.7 * strength);
        this.crack(t, 2200, 0.05, 0.35 * strength);
        break;
      case 'heavy':
        this.thump(t, 120, 40, 0.24, 0.95 * strength);
        this.crack(t, 1600, 0.08, 0.5 * strength);
        break;
      case 'counter':
        this.thump(t, 110, 35, 0.3, 1);
        this.crack(t, 1200, 0.12, 0.6);
        this.tone(t + 0.01, 'square', 880, 1320, 0.12, 0.12);
        break;
      case 'blocked':
        this.crack(t, 3500, 0.04, 0.3);
        this.thump(t, 300, 180, 0.07, 0.3);
        break;
      case 'whoosh':
        this.sweep(t, 600, 2400, 0.13, 0.18 * strength);
        break;
      case 'ko':
        this.thump(t, 90, 28, 0.9, 1.1);
        this.crack(t, 900, 0.3, 0.7);
        this.sweep(t + 0.05, 3000, 200, 1.2, 0.25);
        break;
      case 'beep':
        this.tone(t, 'square', 660, 660, 0.12, 0.12);
        break;
      case 'go':
        this.tone(t, 'sawtooth', 523, 1046, 0.35, 0.14);
        this.tone(t, 'square', 784, 1568, 0.35, 0.08);
        break;
      case 'spawn':
        this.sweep(t, 300, 4000, 1.2, 0.12);
        this.tone(t, 'sine', 220, 880, 1.2, 0.1);
        break;
    }
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      return null;
    }
    // A compressor on the master glues the layers together and keeps big hits from clipping.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 6;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return this.ctx;
  }

  /** Low sine with a fast pitch drop: the body of a punch. */
  private thump(t: number, from: number, to: number, dur: number, gain: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    this.envelope(osc, t, dur, gain);
  }

  /** Band-passed noise burst: the slap on top. */
  private crack(t: number, freq: number, dur: number, gain: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 0.8;
    src.connect(filter);
    this.envelope(filter, t, dur, gain, src);
  }

  /** Noise through a moving band-pass: whooshes and sweeps. */
  private sweep(t: number, from: number, to: number, dur: number, gain: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.5;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + dur);
    src.connect(filter);
    this.envelope(filter, t, dur, gain, src, dur * 0.4);
  }

  private tone(t: number, type: OscillatorType, from: number, to: number, dur: number, gain: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + dur * 0.6);
    this.envelope(osc, t, dur, gain);
  }

  /** Attack fast, decay exponentially; starts and stops the source. */
  private envelope(node: AudioNode, t: number, dur: number, gain: number, source?: AudioScheduledSourceNode, attack = 0.004) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g).connect(this.master!);
    const src = source ?? (node as AudioScheduledSourceNode);
    src.start(t);
    src.stop(t + dur + 0.05);
  }
}
