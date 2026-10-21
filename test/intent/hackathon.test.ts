// The reader on real hackathon play, scored against video-verified labels (see hackathon.ts). Opt-in, the data
// isn't in the repo:
//   HACKATHON_DIR=~/dev/brawlegle-data/tracking-2026-10-20/moves/dataset npx vitest run test/intent/hackathon.test.ts
//   VERBOSE=1 prints every side; HACK_OUT=file.json saves the numbers for before/after comparisons.
import fs from 'node:fs';
import { expect, test } from 'vitest';
import { MASHER, formatSummary, loadHackathon, runHackathon, summarizeHackathon } from './hackathon';

const dir = process.env.HACKATHON_DIR;

test.skipIf(!dir)('real hackathon play', () => {
  const sides = loadHackathon(dir!);
  expect(sides.length).toBeGreaterThan(0);
  const scores = runHackathon(sides);
  const all = summarizeHackathon(scores);
  const noMasher = summarizeHackathon(scores.filter((s) => s.id !== MASHER));
  console.log(`\n${formatSummary('all', all)}\n${formatSummary('no masher', noMasher)}`);
  if (process.env.VERBOSE) for (const s of scores) console.log(formatSummary(s.id, summarizeHackathon([s])));
  if (process.env.HACK_OUT) fs.writeFileSync(process.env.HACK_OUT, JSON.stringify({ all, noMasher, sides: scores.map((s) => ({ id: s.id, ...summarizeHackathon([s]) })) }, null, 1));
  // Floors a little under today's numbers, so a change that reads real play worse fails.
  expect(noMasher.recall).toBeGreaterThan(0.45);
  expect(noMasher.precision).toBeGreaterThan(0.75);
}, 120_000);
