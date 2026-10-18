// Scores the intent reader against labeled clips: did each move register, how fast, and did anything
// register that shouldn't have.
import type { Intent, IntentConfig } from '../../src/intent/intents';
import { DEFAULT_INTENT } from '../../src/intent/intents';
import { runClip } from './clip';
import type { StyleMatcher } from '../../src/intent/StyleMatcher';
import { synthesize, type Label, type SynthOptions } from './synth';

export type Score = {
  name: string;
  labels: number;
  hits: number;
  styleOk: number;
  /** Motion start -> anticipate (strikes) or -> the intent (others), ms. */
  latency: number[];
  /** Motion start -> confirmed strike, ms. */
  commit: number[];
};
export type EvalResult = {
  scores: Score[];
  falsePositives: { kind: string; t: number; note: string }[];
  intents: Intent[];
  labels: Label[];
  /** Labels that were part of a fast combo: how many, how many caught. */
  combo: { labels: number; hits: number };
  /** Clip length (ms), for false positives per minute. */
  ms: number;
};

const MATCH_SLACK_MS = 250;

export function evaluate(frames: Parameters<typeof runClip>[0]['frames'], labels: Label[], config: IntentConfig = DEFAULT_INTENT, matcher: StyleMatcher | null = null): EvalResult {
  const { intents } = runClip({ header: {}, frames }, config, matcher);
  const used = new Set<Intent>();
  const scores = new Map<string, Score>();
  const combo = { labels: 0, hits: 0 };
  const score = (name: string) => {
    if (!scores.has(name)) scores.set(name, { name, labels: 0, hits: 0, styleOk: 0, latency: [], commit: [] });
    return scores.get(name)!;
  };

  const sorted = [...labels].sort((a, b) => a.start - b.start);
  for (const [n, label] of sorted.entries()) {
    if (label.kind === 'negative') continue;
    const s = score(label.name);
    s.labels++;
    if (label.combo) combo.labels++;
    // The next strike by the same limb: a strike that started after it belongs to it, not to this one.
    const next = label.limb ? sorted.slice(n + 1).find((l) => l.limb === label.limb) : undefined;
    const inWindow = (i: Intent) => i.t >= label.start && i.t <= label.end + MATCH_SLACK_MS && !used.has(i)
      && (i.kind !== 'strike' || !next || i.onsetT < next.start + 40);
    const match = intents.find((i) => inWindow(i) && i.kind === label.kind && (!('limb' in i) || i.limb === label.limb));
    if (!match) continue;
    used.add(match);
    s.hits++;
    if (label.combo) combo.hits++;
    if (match.kind === 'strike') {
      if (match.style === label.style) s.styleOk++;
      const anticipate = intents.find((i) => i.kind === 'anticipate' && i.limb === label.limb && i.t >= label.start - 50 && i.t <= match.t);
      s.latency.push((anticipate?.t ?? match.t) - label.start);
      s.commit.push(match.t - label.start);
    } else {
      s.styleOk++;
      s.latency.push(match.t - label.start);
    }
  }

  // Anything left over that is a real action (not anticipate/cancel/guard) is a false positive.
  const falsePositives = intents
    .filter((i) => !used.has(i) && (i.kind === 'strike' || i.kind === 'jump' || i.kind === 'duck' || i.kind === 'dodge'))
    .map((i) => {
      const during = labels.find((l) => i.t >= l.start && i.t <= l.end + MATCH_SLACK_MS);
      return { kind: i.kind === 'strike' ? `strike ${i.limb} ${i.style}` : i.kind, t: i.t, note: during ? `during ${during.name}` : 'idle' };
    });
  const ts = frames.map((f) => f.t);
  const ms = ts.length ? ts[ts.length - 1] - ts[0] : 0;
  return { scores: [...scores.values()].sort((a, b) => a.name.localeCompare(b.name)), falsePositives, intents, labels, combo, ms };
}

export type Summary = ReturnType<typeof summarize>;

/** Merge several evaluated clips into one set of numbers. */
export function summarize(all: EvalResult[]) {
  const merged = new Map<string, Score>();
  for (const r of all) for (const s of r.scores) {
    const m = merged.get(s.name) ?? { name: s.name, labels: 0, hits: 0, styleOk: 0, latency: [], commit: [] };
    m.labels += s.labels; m.hits += s.hits; m.styleOk += s.styleOk; m.latency.push(...s.latency); m.commit.push(...s.commit);
    merged.set(s.name, m);
  }
  const scores = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  const falsePositives = all.flatMap((r) => r.falsePositives);
  const negatives = all.flatMap((r) => r.labels).filter((l) => l.kind === 'negative').length;
  const totalLabels = scores.reduce((s, x) => s + x.labels, 0);
  const totalHits = scores.reduce((s, x) => s + x.hits, 0);
  const strikes = scores.filter((s) => s.commit.length || /jab|cross|hook|upper|knee|kick/.test(s.name));
  const strikeLabels = strikes.reduce((s, x) => s + x.labels, 0);
  // Latency is for punches: legs need their full rise to tell a knee from a kick, so they're slower by design.
  const commit = strikes.filter((s) => /jab|cross|hook|upper/.test(s.name)).flatMap((s) => s.commit);
  const minutes = all.reduce((s, r) => s + r.ms, 0) / 60000;
  const combo = all.reduce((c, r) => ({ labels: c.labels + r.combo.labels, hits: c.hits + r.combo.hits }), { labels: 0, hits: 0 });
  return {
    scores,
    falsePositives,
    recall: totalHits / Math.max(1, totalLabels),
    strikeRecall: strikes.reduce((s, x) => s + x.hits, 0) / Math.max(1, strikeLabels),
    comboRecall: combo.labels ? combo.hits / combo.labels : NaN,
    precision: totalHits / Math.max(1, totalHits + falsePositives.length),
    styleAccuracy: strikes.reduce((s, x) => s + x.styleOk, 0) / Math.max(1, strikes.reduce((s, x) => s + x.hits, 0)),
    fpPerMin: falsePositives.length / Math.max(1e-6, minutes),
    /** Motion start -> confirmed punch (ms), over every caught punch. */
    latency: { median: quantile(commit, 0.5), p90: quantile(commit, 0.9) },
    negatives,
  };
}

export function evaluateSynthetic(options: SynthOptions & { seeds?: number[] } = {}, config: IntentConfig = DEFAULT_INTENT) {
  const seeds = options.seeds ?? [1, 2, 3];
  return summarize(seeds.map((seed) => {
    const { frames, labels } = synthesize({ ...options, seed });
    return evaluate(frames, labels, config);
  }));
}

export function quantile(xs: number[], q: number) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export function report(result: Summary, title: string) {
  const med = (xs: number[]) => quantile(xs, 0.5);
  const rows = result.scores.map((s) =>
    `${s.name.padEnd(14)} ${`${s.hits}/${s.labels}`.padStart(6)}  style ${`${s.styleOk}/${s.hits}`.padStart(6)}  first ${String(Math.round(med(s.latency))).padStart(4)} ms  confirm ${s.commit.length ? `${String(Math.round(med(s.commit))).padStart(4)} ms (p90 ${Math.round(quantile(s.commit, 0.9))})` : '   -'}`);
  const fpByKind = new Map<string, number>();
  for (const fp of result.falsePositives) fpByKind.set(`${fp.kind} (${fp.note})`, (fpByKind.get(`${fp.kind} (${fp.note})`) ?? 0) + 1);
  return [
    `== ${title}: recall ${pct(result.recall)}  strikes ${pct(result.strikeRecall)}  combos ${pct(result.comboRecall)}  precision ${pct(result.precision)}  style ${pct(result.styleAccuracy)}  ` +
      `false positives ${result.falsePositives.length} (${result.fpPerMin.toFixed(1)}/min)  strike latency ${Math.round(result.latency.median)}/${Math.round(result.latency.p90)} ms (median/p90)`,
    ...rows,
    ...(fpByKind.size ? ['  false positives:', ...[...fpByKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `    ${n}× ${k}`)] : []),
  ].join('\n');
}

export const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '-');
