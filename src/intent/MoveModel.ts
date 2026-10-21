// Learned per-frame move scores for the intent reader: a causal TCN (3-model int8 ensemble, 31k parameters each)
// that reads the reader's own preprocessed Body and says, per arm and per frame, how likely it is that a strike is
// rising (onset -> peak) or falling (peak -> back), which style it looks like, and whether the hands are up blocking.
//
// It reports scores only; the reader and the engine still decide (see GateRescue below for the recommended use:
// rules first, the model as a gate on rule strikes and a rescue for missed ones).
//
// Feed it every NEW Body, once (the IntentReader's `out.body` when `out.body.t === frame.t`). Cost: about 0.2 ms per
// frame per model in plain JS (both arms), so ~0.6 ms for the ensemble. No allocation per frame.
//
// Trained 2026-10-20 on the 19 labeled hackathon sides (masher excluded), see clever-2026-10-20/learned.md.
// Weights: moveModel.weights.json (int8 per output channel, ~130 KB).
import type { Body } from './preprocess';

export const MOVE_STYLES = ['straight', 'hook', 'upper', 'overhand'] as const;
export type MoveStyle = (typeof MOVE_STYLES)[number];
export type ArmScores = {
  /** p(no strike), p(strike rising: onset -> peak), p(strike falling: peak -> back). Sum to 1. */
  none: number;
  rise: number;
  fall: number;
  /** Style probabilities (sum to 1). Weak: close to a majority guess on real data; prefer the rules' style. */
  style: Record<MoveStyle, number>;
  /** p(both hands covering the face, deliberately), from this arm's stream. */
  block: number;
};
export type MoveScores = { t: number; armL: ArmScores; armR: ArmScores; /** mean of the two arms' block scores */ block: number };

type B64 = string;
type ModelJSON = { inpQ: B64; inpS: B64; inpB: B64; convQ: B64[]; convS: B64[]; convB: B64[]; headQ: B64; headS: B64; headB: B64 };
export type MoveModelWeights = {
  format: 'brawlmegle-move-tcn-int8-v1';
  styles: string[];
  nin: number;
  C: number;
  layers: number;
  k: number;
  dil: number[];
  mu: B64;
  sd: B64;
  models: ModelJSON[];
};

// MediaPipe indices used by the features.
const NOSE = 0, L_SH = 11, R_SH = 12, L_EL = 13, R_EL = 14, L_WR = 15, R_WR = 16, L_PI = 17, R_PI = 18, L_IX = 19, R_IX = 20;
const ARM = {
  l: { sh: L_SH, el: L_EL, wr: L_WR, pi: L_PI, ix: L_IX },
  r: { sh: R_SH, el: R_EL, wr: R_WR, pi: R_PI, ix: R_IX },
};
const NF = 61;
const NOUT = 8; // none, rise, fall, 4 styles, block

const B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64LUT = new Uint8Array(128);
for (let i = 0; i < 64; i++) B64LUT[B64CHARS.charCodeAt(i)] = i;
function bytes(s: B64): Uint8Array {
  const n = s.length, pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((n * 3) / 4 - pad);
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    const v = (B64LUT[s.charCodeAt(i)] << 18) | (B64LUT[s.charCodeAt(i + 1)] << 12) | (B64LUT[s.charCodeAt(i + 2)] << 6) | B64LUT[s.charCodeAt(i + 3)];
    if (o < out.length) out[o++] = (v >> 16) & 255;
    if (o < out.length) out[o++] = (v >> 8) & 255;
    if (o < out.length) out[o++] = v & 255;
  }
  return out;
}
const f32 = (s: B64) => { const b = bytes(s); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const i8 = (s: B64) => { const b = bytes(s); return new Int8Array(b.buffer, b.byteOffset, b.byteLength); };

/** int8 weights with one float scale per output row, dequantized once at load (the math runs in float32). */
function dequant(q: Int8Array, s: Float32Array, rows: number): Float32Array {
  const per = q.length / rows, out = new Float32Array(q.length);
  for (let r = 0; r < rows; r++) for (let j = 0; j < per; j++) out[r * per + j] = q[r * per + j] * s[r];
  return out;
}

type Net = { Win: Float32Array; bin: Float32Array; W: Float32Array[]; b: Float32Array[]; Wh: Float32Array; bh: Float32Array };

/** One arm of one network: ring buffers holding each layer's recent inputs. */
class ArmStream {
  private readonly buf: Float32Array[];
  private readonly pos: number[];
  private readonly n: number[];
  private filled = false;
  private readonly h: Float32Array;
  private readonly y: Float32Array;
  constructor(private readonly net: Net, private readonly C: number, private readonly k: number, private readonly dil: number[]) {
    this.n = dil.map((d) => (k - 1) * d + 1);
    this.buf = this.n.map((n) => new Float32Array(n * C));
    this.pos = dil.map(() => 0);
    this.h = new Float32Array(C);
    this.y = new Float32Array(C);
  }
  reset() { this.filled = false; }
  /** x: normalized features (NF). Writes NOUT raw outputs (logits) into out. */
  step(x: Float32Array, out: Float32Array) {
    const { C, k, dil, net, h, y } = this;
    const nin = x.length;
    for (let c = 0; c < C; c++) {
      let s = net.bin[c];
      const o = c * nin;
      for (let i = 0; i < nin; i++) s += net.Win[o + i] * x[i];
      h[c] = s > 0 ? s : 0;
    }
    const first = !this.filled;
    this.filled = true;
    for (let l = 0; l < dil.length; l++) {
      const b = this.buf[l], n = this.n[l], d = dil[l], w = net.W[l], bb = net.b[l];
      // push h: the very first frame fills the whole buffer (= replicate padding, as in training)
      if (first) { for (let j = 0; j < n; j++) b.set(h, j * C); this.pos[l] = n - 1; } else { this.pos[l] = (this.pos[l] + 1) % n; b.set(h, this.pos[l] * C); }
      const pos = this.pos[l];
      for (let co = 0; co < C; co++) {
        let s = bb[co];
        for (let j = 0; j < k; j++) {
          let slot = pos - (k - 1 - j) * d;
          if (slot < 0) slot += n;
          const src = slot * C, wo = (co * k + j) * C;
          for (let ci = 0; ci < C; ci++) s += w[wo + ci] * b[src + ci];
        }
        y[co] = s > 0 ? s : 0;
      }
      for (let c = 0; c < C; c++) h[c] += y[c];
    }
    for (let o = 0; o < NOUT; o++) {
      let s = net.bh[o];
      for (let c = 0; c < C; c++) s += net.Wh[o * C + c] * h[c];
      out[o] = s;
    }
  }
}

const clip = (v: number, a: number) => (v > a ? a : v < -a ? -a : v);
const fin = (v: number) => (Number.isFinite(v) ? v : 0);

export class MoveModel {
  private readonly mu: Float32Array;
  private readonly sd: Float32Array;
  private readonly streams: { L: ArmStream; R: ArmStream }[];
  private readonly fL = new Float32Array(NF);
  private readonly fR = new Float32Array(NF);
  private readonly xn = new Float32Array(NF);
  private readonly raw = new Float32Array(NOUT);
  private readonly acc = { L: new Float32Array(NOUT), R: new Float32Array(NOUT) };
  private started = false;
  private readonly tmpA = new Float32Array(24);
  private readonly tmpB = new Float32Array(24);

  constructor(w: MoveModelWeights) {
    if (w.format !== 'brawlmegle-move-tcn-int8-v1' || w.nin !== NF) throw new Error(`MoveModel: unsupported weights ${w.format}`);
    this.mu = f32(w.mu);
    this.sd = f32(w.sd);
    const { C, k, dil } = w;
    this.streams = w.models.map((m) => {
      const net: Net = {
        Win: dequant(i8(m.inpQ), f32(m.inpS), C), bin: f32(m.inpB),
        W: m.convQ.map((q, i) => dequant(i8(q), f32(m.convS[i]), C)), b: m.convB.map(f32),
        Wh: dequant(i8(m.headQ), f32(m.headS), NOUT), bh: f32(m.headB),
      };
      return { L: new ArmStream(net, C, k, dil), R: new ArmStream(net, C, k, dil) };
    });
  }

  /** Forget the history (new player, or the reader reset). */
  reset() {
    this.started = false;
    for (const s of this.streams) (s.L.reset(), s.R.reset());
  }

  /** Call once per new Body. */
  update(body: Body): MoveScores {
    this.features(body, this.fL, this.fR);
    this.started = true;
    this.acc.L.fill(0);
    this.acc.R.fill(0);
    for (const s of this.streams) {
      for (const side of ['L', 'R'] as const) {
        const f = side === 'L' ? this.fL : this.fR;
        for (let i = 0; i < NF; i++) this.xn[i] = (f[i] - this.mu[i]) / this.sd[i];
        (side === 'L' ? s.L : s.R).step(this.xn, this.raw);
        const a = this.acc[side];
        // average probabilities over the ensemble (as in training/evaluation), not logits
        const r = this.raw;
        const m3 = Math.max(r[0], r[1], r[2]);
        const e0 = Math.exp(r[0] - m3), e1 = Math.exp(r[1] - m3), e2 = Math.exp(r[2] - m3), z3 = e0 + e1 + e2;
        a[0] += e0 / z3; a[1] += e1 / z3; a[2] += e2 / z3;
        const m4 = Math.max(r[3], r[4], r[5], r[6]);
        const s0 = Math.exp(r[3] - m4), s1 = Math.exp(r[4] - m4), s2 = Math.exp(r[5] - m4), s3 = Math.exp(r[6] - m4), z4 = s0 + s1 + s2 + s3;
        a[3] += s0 / z4; a[4] += s1 / z4; a[5] += s2 / z4; a[6] += s3 / z4;
        a[7] += 1 / (1 + Math.exp(-r[7]));
      }
    }
    const n = this.streams.length;
    const arm = (a: Float32Array): ArmScores => ({
      none: a[0] / n, rise: a[1] / n, fall: a[2] / n,
      style: { straight: a[3] / n, hook: a[4] / n, upper: a[5] / n, overhand: a[6] / n },
      block: a[7] / n,
    });
    const armL = arm(this.acc.L), armR = arm(this.acc.R);
    return { t: body.t, armL, armR, block: (armL.block + armR.block) / 2 };
  }

  /** 61 features per arm, mirrored so "out" is away from that arm's side (port of learned/scripts/features.py). */
  private features(b: Body, FL: Float32Array, FR: Float32Array) {
    this.armBlock(b, 'l', 1, this.tmpA);
    this.armBlock(b, 'r', -1, this.tmpB);
    FL.set(this.tmpA, 0); FL.set(this.tmpB.subarray(0, 21), 24); this.bodyBlock(b, 1, FL, 45);
    FR.set(this.tmpB, 0); FR.set(this.tmpA.subarray(0, 21), 24); this.bodyBlock(b, -1, FR, 45);
    for (let i = 0; i < NF; i++) (FL[i] = fin(FL[i])), (FR[i] = fin(FR[i]));
  }

  private armBlock(b: Body, side: 'l' | 'r', m: number, o: Float32Array) {
    const J = ARM[side], P = b.points;
    const sh = P[J.sh].p, el = P[J.el].p, wr = P[J.wr].p, pi = P[J.pi].p, ix = P[J.ix].p, nose = P[NOSE].p;
    const shv = P[J.sh].vf, wrv = P[J.wr].vf, elv = P[J.el].vf;
    o[0] = (wr.x - sh.x) * m; o[1] = wr.y - sh.y; o[2] = wr.z - sh.z;
    o[3] = (el.x - sh.x) * m; o[4] = el.y - sh.y; o[5] = el.z - sh.z;
    o[6] = ((pi.x + ix.x) / 2 - wr.x) * m; o[7] = (pi.y + ix.y) / 2 - wr.y; o[8] = (pi.z + ix.z) / 2 - wr.z;
    const wvx = (wrv.x - shv.x) * m, wvy = wrv.y - shv.y, wvz = wrv.z - shv.z;
    o[9] = clip(wvx, 20); o[10] = clip(wvy, 20); o[11] = clip(wvz, 20);
    o[12] = clip((elv.x - shv.x) * m, 20); o[13] = clip(elv.y - shv.y, 20); o[14] = clip(elv.z - shv.z, 20);
    o[15] = (side === 'l' ? b.elbow.L : b.elbow.R) / 180;
    o[16] = clip((side === 'l' ? b.elbow.vL : b.elbow.vR) / 500, 5);
    o[17] = P[J.wr].visibility; o[18] = P[J.el].visibility; o[19] = P[J.wr].ok ? 1 : 0;
    o[20] = Math.min(25, Math.hypot(wvx, wvy)); // from the unclipped velocity
    const nx = (nose.x - wr.x) * m, ny = nose.y - wr.y;
    o[21] = nx; o[22] = ny; o[23] = Math.hypot(nx, ny);
  }

  private bodyBlock(b: Body, m: number, o: Float32Array, k: number) {
    const P = b.points, ls = P[L_SH], rs = P[R_SH], n = P[NOSE];
    const cx = (ls.p.x + rs.p.x) / 2, cy = (ls.p.y + rs.p.y) / 2;
    const vx = (ls.vf.x + rs.vf.x) / 2, vy = (ls.vf.y + rs.vf.y) / 2;
    o[k] = (n.p.x - cx) * m; o[k + 1] = n.p.y - cy;
    o[k + 2] = clip((n.vf.x - vx) * m, 20); o[k + 3] = clip(n.vf.y - vy, 20);
    const dx = ls.p.x - rs.p.x, dy = ls.p.y - rs.p.y, dz = ls.p.z - rs.p.z;
    o[k + 4] = Math.hypot(dx, dy); o[k + 5] = dy * m; o[k + 6] = clip(dz * m, 3);
    o[k + 7] = cx * m; o[k + 8] = cy;
    o[k + 9] = b.scale; o[k + 10] = b.fullBody ? 1 : 0;
    o[k + 11] = b.root.x * m; o[k + 12] = b.root.y; o[k + 13] = clip(b.root.vx * m, 10); o[k + 14] = clip(b.root.vy, 10);
    // the first frame after a reset has no dt (training: 0); otherwise log of the frame interval vs 30 fps
    o[k + 15] = this.started ? Math.log(Math.min(0.5, Math.max(0.008, b.dt)) / 0.033) : 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Recommended use: rules first, the model as a gate on rule strikes and a rescue for missed ones. Thresholds = the
// median of the per-fold picks of a nested leave-one-person-out CV (learned.md, "Recommended settings"). On the 19
// labeled sides vs the skill-branch rules: recall 57.5% -> 70.7% (nested) / 72.7% (these fixed values), precision
// 84.9% -> 83.1% / 86.5%, confirm median 133 -> 64-70 ms after the real onset.
export const GATE_RESCUE = {
  /** A rule strike is kept only if this arm's p(rise) reached `keep` between its onset - 100 ms and its confirm. */
  keep: 0.2,
  /** Rescue: a model strike starts (wind-up tell) at p(rise) >= on, confirms at >= confirm in the same run. */
  on: 0.6,
  confirm: 0.75,
  /** ...cancels / re-arms when p(rise) falls below this. */
  off: 0.2,
  /** A rule strike and a model strike on the same arm with onsets this close are the same swing. */
  sameSwingMs: 200,
  /** Fallback: if the rules confirmed this many strikes in the last `blindMs` while the model's p(rise) never passed
   * `aliveP` on either arm, the model is blind to this player (seen on the one seated player): stop gating. */
  blindStrikes: 3,
  blindMs: 10_000,
  aliveP: 0.3,
};

export type RuleStrike = { limb: 'armL' | 'armR'; t: number; onsetT: number; style: string };
export type GateDecision =
  | { kind: 'emit'; limb: 'armL' | 'armR'; t: number; onsetT: number; style: string; source: 'rules' | 'model' }
  | { kind: 'restyle'; limb: 'armL' | 'armR'; t: number; onsetT: number; style: string }
  | { kind: 'drop'; limb: 'armL' | 'armR'; t: number; reason: 'model says no strike' };

/**
 * The gate + rescue logic, causal (decides on the frame it's given). Per new Body: `scores()` first, then `rule()`
 * for every arm rule strike of that frame, then `ruleRestyle()` for every rule restyle. A rule strike that merges
 * into an earlier model strike becomes a restyle of it (the rules' style wins); rule strikes the model doesn't back
 * are dropped; model strikes the rules missed are emitted (the rescue). Legs, guard, dodges: pass the rules through.
 */
export class GateRescue {
  private hist: { t: number; L: number; R: number }[] = [];
  private cand: Record<'armL' | 'armR', { on: number; onsetT: number } | null> = { armL: null, armR: null };
  private armed: Record<'armL' | 'armR', boolean> = { armL: true, armR: true };
  private lastModel: Record<'armL' | 'armR', { onsetT: number; t: number } | null> = { armL: null, armR: null };
  private lastRule: Record<'armL' | 'armR', { onsetT: number; t: number } | null> = { armL: null, armR: null };
  private ruleTimes: number[] = [];
  /** Rule strike onset -> onset of the strike actually emitted for it (itself, or the model strike it merged into). */
  private emittedFor: Record<'armL' | 'armR', { rule: number; emitted: number } | null> = { armL: null, armR: null };
  constructor(private readonly cfg = GATE_RESCUE) {}

  /** A rule 'restyle' (the style re-read at the peak): re-target it to whatever strike was emitted for that swing. */
  ruleRestyle(r: { limb: 'armL' | 'armR'; t: number; onsetT: number; style: string }): GateDecision | null {
    const e = this.emittedFor[r.limb];
    if (!e || Math.abs(e.rule - r.onsetT) > 0.5) return null; // that rule strike was dropped
    return { kind: 'restyle', limb: r.limb, t: r.t, onsetT: e.emitted, style: r.style };
  }

  /** Model scores for a new frame. Returns rescue strikes (model-only), if any. */
  scores(s: MoveScores): GateDecision[] {
    const c = this.cfg, out: GateDecision[] = [];
    this.hist.push({ t: s.t, L: s.armL.rise, R: s.armR.rise });
    while (this.hist.length && s.t - this.hist[0].t > c.blindMs) this.hist.shift();
    for (const limb of ['armL', 'armR'] as const) {
      const p = (limb === 'armL' ? s.armL : s.armR).rise;
      const st = limb === 'armL' ? s.armL.style : s.armR.style;
      if (!this.armed[limb]) { if (p < c.off) this.armed[limb] = true; continue; }
      if (!this.cand[limb] && p >= c.on) this.cand[limb] = { on: s.t, onsetT: s.t };
      const cd = this.cand[limb];
      if (!cd) continue;
      if (p >= c.confirm) {
        this.cand[limb] = null; this.armed[limb] = false;
        const r = this.lastRule[limb];
        if (r && Math.abs(r.onsetT - cd.onsetT) <= c.sameSwingMs) continue; // the rules already threw this swing
        this.lastModel[limb] = { onsetT: cd.onsetT, t: s.t };
        // style: the rules' restyle/merge will correct it; the model's own guess is mostly "hook-ish"
        const style = st.straight > Math.max(st.hook, st.upper, st.overhand) ? 'straight' : st.upper > Math.max(st.hook, st.overhand) ? 'upper' : 'hook';
        out.push({ kind: 'emit', limb, t: s.t, onsetT: cd.onsetT, style, source: 'model' });
      } else if (p < c.off) {
        this.cand[limb] = null;
      }
    }
    return out;
  }

  /** A rule strike confirmed on this frame. */
  rule(r: RuleStrike): GateDecision {
    const c = this.cfg;
    this.ruleTimes.push(r.t);
    this.ruleTimes = this.ruleTimes.filter((t) => r.t - t <= c.blindMs);
    const m = this.lastModel[r.limb];
    if (m && Math.abs(m.onsetT - r.onsetT) <= c.sameSwingMs) {
      this.lastRule[r.limb] = { onsetT: r.onsetT, t: r.t };
      this.emittedFor[r.limb] = { rule: r.onsetT, emitted: m.onsetT };
      return { kind: 'restyle', limb: r.limb, t: r.t, onsetT: m.onsetT, style: r.style };
    }
    const key = r.limb === 'armL' ? 'L' : 'R';
    let peak = 0, alive = 0;
    for (const h of this.hist) {
      if (h.t >= r.onsetT - 100 && h.t <= r.t) peak = Math.max(peak, h[key]);
      alive = Math.max(alive, h.L, h.R);
    }
    const blind = alive < c.aliveP && this.ruleTimes.length >= c.blindStrikes;
    if (peak >= c.keep || blind) {
      // only an emitted rule strike blocks a later model strike of the same swing (a dropped one doesn't)
      this.lastRule[r.limb] = { onsetT: r.onsetT, t: r.t };
      this.emittedFor[r.limb] = { rule: r.onsetT, emitted: r.onsetT };
      return { kind: 'emit', limb: r.limb, t: r.t, onsetT: r.onsetT, style: r.style, source: 'rules' };
    }
    return { kind: 'drop', limb: r.limb, t: r.t, reason: 'model says no strike' };
  }
}
