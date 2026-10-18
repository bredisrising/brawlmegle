// The reader across play conditions (camera placement, sitting/standing, fps, bodies, combos).
// Prints one row per condition; MATRIX_OUT=file.json also saves the numbers for before/after comparisons.
// VERBOSE=1 prints the per-move breakdown too.
import fs from 'node:fs';
import { expect, test } from 'vitest';
import { CONDITIONS } from './conditions';
import { evaluateSynthetic, pct, report, type Summary } from './eval';

const SEEDS = [1, 2];
const SECONDS = 90;

test('condition matrix', () => {
  const rows: { name: string; result: Summary }[] = [];
  for (const c of CONDITIONS.filter((c) => !process.env.ONLY || c.name.includes(process.env.ONLY))) {
    const result = evaluateSynthetic({ ...c.options, seconds: SECONDS, seeds: SEEDS });
    rows.push({ name: c.name, result });
    if (process.env.VERBOSE) console.log('\n' + report(result, c.name));
  }
  const head = `${'condition'.padEnd(30)} recall strikes combos  prec  style  FP/min  confirm   effective (ms, med/p90)`;
  const lines = rows.map(({ name, result: r }) =>
    `${name.padEnd(30)} ${pct(r.recall).padStart(6)} ${pct(r.strikeRecall).padStart(7)} ${pct(r.comboRecall).padStart(6)} ${pct(r.precision).padStart(5)} ${pct(r.styleAccuracy).padStart(6)} ${r.fpPerMin.toFixed(1).padStart(7)}  ${String(Math.round(r.latency.median)).padStart(4)}/${String(Math.round(r.latency.p90)).padEnd(4)} ${String(Math.round(r.effective.median)).padStart(4)}/${String(Math.round(r.effective.p90)).padEnd(4)}`);
  const all = rows.map((r) => r.result);
  const mean = (f: (s: Summary) => number) => all.map(f).filter(Number.isFinite).reduce((a, b) => a + b, 0) / all.filter((s) => Number.isFinite(f(s))).length;
  lines.push(`${'MEAN'.padEnd(30)} ${pct(mean((s) => s.recall)).padStart(6)} ${pct(mean((s) => s.strikeRecall)).padStart(7)} ${pct(mean((s) => s.comboRecall)).padStart(6)} ${pct(mean((s) => s.precision)).padStart(5)} ${pct(mean((s) => s.styleAccuracy)).padStart(6)} ${mean((s) => s.fpPerMin).toFixed(1).padStart(7)}  ${String(Math.round(mean((s) => s.latency.median))).padStart(4)}/${String(Math.round(mean((s) => s.latency.p90))).padEnd(4)} ${String(Math.round(mean((s) => s.effective.median))).padStart(4)}/${String(Math.round(mean((s) => s.effective.p90))).padEnd(4)}`);
  console.log('\n' + head + '\n' + lines.join('\n'));
  if (process.env.MATRIX_OUT) {
    fs.writeFileSync(process.env.MATRIX_OUT, JSON.stringify(rows.map(({ name, result: r }) => ({
      name, recall: r.recall, strikeRecall: r.strikeRecall, comboRecall: r.comboRecall, precision: r.precision, style: r.styleAccuracy,
      fpPerMin: r.fpPerMin, latency: r.latency, effective: r.effective, scores: r.scores.map((s) => ({ name: s.name, labels: s.labels, hits: s.hits, styleOk: s.styleOk })),
    })), null, 1));
  }
  // Floors a little under where the reader is now, so regressions fail. Raise them as it improves.
  for (const { name, result } of rows) {
    expect(result.recall, name).toBeGreaterThan(0.7);
    expect(result.precision, name).toBeGreaterThan(0.65);
  }
  if (rows.length === CONDITIONS.length) {
    expect(mean((s) => s.recall)).toBeGreaterThan(0.86);
    expect(mean((s) => s.precision)).toBeGreaterThan(0.8);
    expect(mean((s) => s.comboRecall)).toBeGreaterThan(0.7);
  }
}, 120_000);
