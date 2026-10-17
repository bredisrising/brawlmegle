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
export type EvalResult = { scores: Score[]; falsePositives: { kind: string; t: number; note: string }[]; intents: Intent[]; labels: Label[] };

const MATCH_SLACK_MS = 250;

export function evaluate(frames: Parameters<typeof runClip>[0]['frames'], labels: Label[], config: IntentConfig = DEFAULT_INTENT, matcher: StyleMatcher | null = null): EvalResult {
  const { intents } = runClip({ header: {}, frames }, config, matcher);
  const used = new Set<Intent>();
  const scores = new Map<string, Score>();
  const score = (name: string) => {
    if (!scores.has(name)) scores.set(name, { name, labels: 0, hits: 0, styleOk: 0, latency: [], commit: [] });
    return scores.get(name)!;
  };

  for (const label of labels) {
    if (label.kind === 'negative') continue;
    const s = score(label.name);
    s.labels++;
    const inWindow = (i: Intent) => i.t >= label.start && i.t <= label.end + MATCH_SLACK_MS && !used.has(i);
    const match = intents.find((i) => inWindow(i) && i.kind === label.kind && (!('limb' in i) || i.limb === label.limb));
    if (!match) continue;
    used.add(match);
    s.hits++;
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
  return { scores: [...scores.values()].sort((a, b) => a.name.localeCompare(b.name)), falsePositives, intents, labels };
}

export function evaluateSynthetic(options: SynthOptions & { seeds?: number[] } = {}, config: IntentConfig = DEFAULT_INTENT) {
  const seeds = options.seeds ?? [1, 2, 3];
  const all: EvalResult[] = seeds.map((seed) => {
    const { frames, labels } = synthesize({ ...options, seed });
    return evaluate(frames, labels, config);
  });
  // Merge per-move scores across seeds.
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
  const strikes = scores.filter((s) => s.commit.length);
  return {
    scores,
    falsePositives,
    recall: totalHits / Math.max(1, totalLabels),
    precision: totalHits / Math.max(1, totalHits + falsePositives.length),
    styleAccuracy: strikes.reduce((s, x) => s + x.styleOk, 0) / Math.max(1, strikes.reduce((s, x) => s + x.hits, 0)),
    negatives,
  };
}

export function report(result: ReturnType<typeof evaluateSynthetic>, title: string) {
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
  const rows = result.scores.map((s) =>
    `${s.name.padEnd(14)} ${`${s.hits}/${s.labels}`.padStart(6)}  style ${`${s.styleOk}/${s.hits}`.padStart(6)}  first ${String(Math.round(med(s.latency))).padStart(4)} ms  confirm ${s.commit.length ? String(Math.round(med(s.commit))).padStart(4) + ' ms' : '   -'}`);
  const fpByKind = new Map<string, number>();
  for (const fp of result.falsePositives) fpByKind.set(`${fp.kind} (${fp.note})`, (fpByKind.get(`${fp.kind} (${fp.note})`) ?? 0) + 1);
  return [
    `== ${title}: recall ${(result.recall * 100).toFixed(0)}%  precision ${(result.precision * 100).toFixed(0)}%  style ${(result.styleAccuracy * 100).toFixed(0)}%  false positives ${result.falsePositives.length}`,
    ...rows,
    ...(fpByKind.size ? ['  false positives:', ...[...fpByKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `    ${n}× ${k}`)] : []),
  ].join('\n');
}
