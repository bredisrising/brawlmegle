// One compact table for the reader on real hackathon play (the 509 video-verified labels, see hackathon.ts):
//   npm run scoreboard                      HACKATHON_DIR defaults to ~/dev/brawlegle-data/tracking-2026-10-20/moves/dataset
//   npm run scoreboard -- --save before.json
//   npm run scoreboard -- --compare before.json   (adds a now − before table)
//   npm run scoreboard -- --folds [dir]           each side read with the move model trained without that person's group
//                                                 (dir: fold_<group>.json, default ~/dev/brawlegle-data/clever-2026-10-20/
//                                                 learned/ts/folds). The shipped model was trained on these very sides, so
//                                                 without --folds its part (and its style guesses) is in-sample.
//
// Rows: every side, the 19 without the masher, the two halves of those by person group (tune on one, check the other),
// then each labeled punch type (no masher). Columns:
//   recall     real strikes read (any arm)
//   prec       reads that were a real strike; per type: of the reads the engine played as that move
//   fakes/m    reads that weren't a real strike, a minute; per type: the ones the engine played as that move
//   style      right style after the peak restyle, of all real strikes (strict: an overhand must be an overhand)
//   move       caught ones (right arm, a clear type) the engine played as the right move at its first active frame (an
//              overhand plays as the hook; a restyle that comes after that is too late)
//   tell       labeled onset -> the fighter starts moving (the first 'anticipate' of that swing), median ms
//   conf       labeled onset -> confirmed strike, median ms
//   hit        estimated real onset -> hit on screen, median ms: FIXED_MS + conf + the engine's frames from the confirm
//              to the first active frame for that read (a fresh engine, so no mashing or tiredness), half a tick of wait
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_INTENT, type Intent, type IntentConfig } from '../../src/intent/intents';
import { IntentReader } from '../../src/intent/IntentReader';
import type { MoveModelWeights } from '../../src/intent/MoveModel';
import { FightEngine } from '../../src/fight/FightEngine';
import { Resolver } from '../../src/fight/Resolver';
import type { Stance } from '../../src/types';
import { runClip } from './clip';
import { MASHER, loadHackathon, scoreSide, type HackLabel, type Match, type SideScore } from './hackathon';

/**
 * Camera (photons -> frame, 35–70 ms at 30 fps), pose (frame -> landmarks, ~40 ms), render -> panel (25–50 ms):
 * none of it shows in the recordings' timestamps (research/tracking-overhaul.md, "Latency").
 */
const FIXED_MS = 50 + 40 + 35;
const TICK_MS = 1000 / 60;

/** Person groups (clothing tags merged wherever they could be the same person), as the move model's folds. */
const GROUPS: Record<string, string[]> = {
  olive: ['b48ee4', 'feaa56', 'fb2cf9', '8a6dba', 'ad4701'],
  pink: ['0ce573', '8195ba', '6541b3', 'e27e2b'],
  grayorange: ['348ab3', 'f9bebc', '44f750'],
  graypink: ['4dec66', 'f7782c'],
  tan: ['4bbc3e', 'f04c5b'],
  orange: ['319fec'],
  black: ['93e378'],
  masher: ['8782a6'],
  beige: ['0e5d1a'],
};
const groupOf = (id: string) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(id)) ?? '';
/** Halves of the 19 for tuning thresholds on one and checking them on the other, whole groups each. */
const TUNE = [...GROUPS.olive, ...GROUPS.grayorange, ...GROUPS.tan, ...GROUPS.orange];
const HELD = [...GROUPS.pink, ...GROUPS.graypink, ...GROUPS.black, ...GROUPS.beige];

type Strike = Extract<Intent, { kind: 'strike' }>;
type Restyle = Extract<Intent, { kind: 'restyle' }>;
type Side = { score: SideScore; intents: Intent[]; labels: HackLabel[] };
export type Row = { name: string; n: number; recall: number; prec: number; fakes: number; style: number; move: number; tell: number; conf: number; hit: number };

const PLAYED: Record<string, string> = { straight: 'straight', hook: 'hook', upper: 'upper', overhand: 'hook' };

/** When this swing first showed on the fighter: the first tell on that arm since its last strike or cancel. */
function tellAt(intents: Intent[], s: Strike) {
  let tell = s.t;
  for (const i of intents) {
    if (i.t > s.t) break;
    if (!('limb' in i) || i.limb !== s.limb) continue;
    if (i.kind === 'anticipate') tell = Math.min(tell, i.t);
    else if ((i.kind === 'strike' || i.kind === 'cancel') && i !== s) tell = s.t;
  }
  return tell;
}

/**
 * The strike through the real resolver and engine, alone, at the usual fighting distance: frames from the confirm to its
 * first active frame, and the move it is by then (a restyle that comes later is too late).
 */
const played = new WeakMap<Strike, { frames: number; move: string }>();
function throughEngine(intents: Intent[], s: Strike) {
  let p = played.get(s);
  if (!p) played.set(s, (p = runEngine(intents, s)));
  return p;
}
function runEngine(intents: Intent[], s: Strike) {
  const engine = new FightEngine();
  const resolver = new Resolver();
  const stance = (player: 'p1' | 'p2'): Stance => ({ player, guard: false, advance: 0, lean: { x: 0, y: 0 }, tracked: true });
  const stances = { p1: stance('p1'), p2: stance('p2') };
  // Let the fighters drift in to their usual distance first (FIGHT.preferredDistance).
  for (let k = 0; k < 90; k++) engine.step([], stances);
  const later = intents.filter((i): i is Restyle => i.kind === 'restyle' && i.limb === s.limb && i.onsetT === s.onsetT && i.t >= s.t);
  for (let k = 0; k < 60; k++) {
    const now = s.t + k * TICK_MS;
    const due: Intent[] = k === 0 ? [s] : [];
    for (const r of later) if (r.t > now - TICK_MS && r.t <= now) due.push(r);
    engine.step(resolver.resolve('p1', due, engine), stances);
    const st = engine.state('p1');
    if (st.phase === 'active') return { frames: k, move: st.move ?? '' };
  }
  return { frames: NaN, move: '' };
}
const MOVE_OF: Record<string, string> = { jab: 'straight', cross: 'straight', hook: 'hook', uppercut: 'upper' };

const median = (xs: number[]) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
};

function row(name: string, sides: Side[], type?: string): Row {
  const minutes = sides.reduce((a, s) => a + s.score.minutes, 0);
  const all: { m: Match; intents: Intent[] }[] = sides.flatMap((s) => s.score.matches.map((m) => ({ m, intents: s.intents })));
  const mine = type ? all.filter(({ m }) => m.label.style === type) : all;
  const n = sides.reduce((a, s) => a + s.labels.filter((l) => !type || l.style === type).length, 0);
  // Precision and fakes per type: of the reads the engine played as that move.
  const as = type ? PLAYED[type] : undefined;
  const isPlayed = (intents: Intent[], s: Strike) => as === undefined || MOVE_OF[throughEngine(intents, s).move] === as;
  let reads = 0, real = 0, fakes = 0;
  if (type !== 'overhand' && type !== 'unclear') {
    for (const s of sides) {
      for (const m of s.score.matches) if (isPlayed(s.intents, m.read)) (reads++, real++);
      for (const f of s.score.fakes) if (isPlayed(s.intents, f)) (reads++, fakes++);
    }
  }
  const sameArm = mine.filter(({ m }) => m.armOk);
  const lat = sameArm.map(({ m, intents }) => {
    const p = throughEngine(intents, m.read);
    const right = (PLAYED[m.label.style ?? ''] ?? m.label.style) === MOVE_OF[p.move];
    return { tell: tellAt(intents, m.read) - m.label.start, conf: m.confirm, hit: FIXED_MS + m.confirm + (p.frames + 0.5) * TICK_MS, right, typed: m.label.style !== 'unclear' };
  });
  return {
    name,
    n,
    recall: mine.length / Math.max(1, n),
    prec: reads ? real / reads : NaN,
    fakes: reads ? fakes / minutes : NaN,
    style: mine.filter(({ m }) => m.styleOk).length / Math.max(1, n),
    move: lat.some((l) => l.typed) ? lat.filter((l) => l.typed && l.right).length / lat.filter((l) => l.typed).length : NaN,
    tell: median(lat.map((l) => l.tell)),
    conf: median(lat.map((l) => l.conf)),
    hit: median(lat.map((l) => l.hit)),
  };
}

export function scoreboard(dir: string, folds?: string, config: IntentConfig = DEFAULT_INTENT): Row[] {
  const sides: Side[] = loadHackathon(dir).map((side) => {
    const weights = folds ? (JSON.parse(fs.readFileSync(path.join(folds, `fold_${groupOf(side.id)}.json`), 'utf8')) as MoveModelWeights) : undefined;
    const intents = runClip({ header: {}, frames: side.frames }, config, null, (c) => new IntentReader('p1', c, weights)).intents;
    return { score: scoreSide(side, intents), intents, labels: side.labels.filter((l) => l.kind === 'strike') };
  });
  const noMasher = sides.filter((s) => s.score.id !== MASHER);
  return [
    row('all', sides),
    row('no masher', noMasher),
    row('  tune half', noMasher.filter((s) => TUNE.includes(s.score.id))),
    row('  held-out half', noMasher.filter((s) => HELD.includes(s.score.id))),
    ...['straight', 'hook', 'upper', 'overhand', 'unclear'].map((t) => row(`  ${t}`, noMasher, t)),
  ];
}

const COLS: [keyof Row, string, (v: number) => string][] = [
  ['n', 'n', (v) => String(Math.round(v))],
  ['recall', 'recall', (v) => (100 * v).toFixed(1)],
  ['prec', 'prec', (v) => (100 * v).toFixed(1)],
  ['fakes', 'fakes/m', (v) => v.toFixed(2)],
  ['style', 'style', (v) => (100 * v).toFixed(1)],
  ['move', 'move', (v) => (100 * v).toFixed(1)],
  ['tell', 'tell', (v) => v.toFixed(0)],
  ['conf', 'conf', (v) => v.toFixed(0)],
  ['hit', 'hit', (v) => v.toFixed(0)],
];

export function format(rows: Row[], sign = false) {
  const cell = (f: (v: number) => string, v: number) => (Number.isFinite(v) ? (sign && v > 0 ? '+' : '') + f(v) : '-');
  const lines = [['', ...COLS.map(([, h]) => h)], ...rows.map((r) => [r.name, ...COLS.map(([k, , f]) => cell(f, r[k] as number))])];
  const widths = lines[0].map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  return lines.map((l) => l.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')).join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const arg = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dir = process.env.HACKATHON_DIR ?? path.join(os.homedir(), 'dev/brawlegle-data/tracking-2026-10-20/moves/dataset');
  if (!fs.existsSync(path.join(dir, 'labels'))) {
    console.error(`No labels in ${dir} (set HACKATHON_DIR to the dataset with clips/ and labels/).`);
    process.exit(1);
  }
  const i = args.indexOf('--folds');
  const folds = i < 0 ? undefined : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : path.join(os.homedir(), 'dev/brawlegle-data/clever-2026-10-20/learned/ts/folds');
  const rows = scoreboard(dir, folds);
  if (folds) console.log('held out: each side read with the move model trained without its person group\n');
  console.log(format(rows));
  console.log(`\npercent; ms from the labeled onset; hit = ${FIXED_MS} ms camera+pose+display + conf + engine frames to active`);
  const save = arg('--save');
  if (save) fs.writeFileSync(save, JSON.stringify(rows, null, 1));
  const before = arg('--compare');
  if (before) {
    const old = JSON.parse(fs.readFileSync(before, 'utf8')) as Row[];
    const diff = rows.map((r) => {
      const o = old.find((x) => x.name === r.name);
      const d = { ...r };
      for (const [k] of COLS) (d[k] as number) = o ? (r[k] as number) - (o[k] as number) : NaN;
      return d;
    });
    console.log(`\nnow − ${path.basename(before)}\n${format(diff, true)}`);
  }
}

if (process.argv[1]?.endsWith('scoreboard.ts')) main();
