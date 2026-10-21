// Scoring the reader on real play: hackathon match sides labeled from their round video (509 real strikes, blocks,
// 0 real slips or ducks). The pose clips and labels name players, so they live outside the repo
// (HACKATHON_DIR, e.g. ~/dev/brawlegle-data/tracking-2026-10-20/moves/dataset with clips/ and labels/).
// Matching is the move audit's (research/tracking-overhaul.md): a read belongs to a label when its onset falls in
// [start − 250, peak + 150] ms or its confirm in [start, peak + 300] ms, same arm first, then the other arm.
import fs from 'node:fs';
import path from 'node:path';
import type { Intent, IntentConfig } from '../../src/intent/intents';
import { DEFAULT_INTENT } from '../../src/intent/intents';
import { defaultReader, loadClip, runClip, type ClipFrame, type ReaderFactory } from './clip';

export type HackLabel = {
  kind: 'strike' | 'block' | 'negative';
  limb?: string;
  style?: string;
  start: number;
  end: number;
  peak?: number;
  clean?: boolean;
  conf?: string;
};
export type HackSide = { id: string; until?: number; labels: HackLabel[]; frames: ClipFrame[] };

/** The one side that threw 147 tiny chain punches in 27 s: reported separately (is a roll a punch at all?). */
export const MASHER = '8782a6';

export function loadHackathon(dir: string): HackSide[] {
  const labelDir = path.join(dir, 'labels');
  if (!fs.existsSync(labelDir)) return [];
  return fs.readdirSync(labelDir).filter((f) => /^[0-9a-f]{6}\.json$/.test(f)).sort().map((f) => {
    const file = JSON.parse(fs.readFileSync(path.join(labelDir, f), 'utf8')) as { clip: string; until?: number; labels: HackLabel[] };
    const frames = loadClip(path.join(dir, 'clips', file.clip)).frames.filter((fr) => file.until === undefined || fr.t <= file.until);
    return { id: f.slice(0, 6), until: file.until, labels: file.labels, frames };
  });
}

type Strike = Extract<Intent, { kind: 'strike' }>;
export type Match = { label: HackLabel; read: Strike; armOk: boolean; styleOk: boolean; lenientOk: boolean; onset: number; confirm: number };
export type SideScore = {
  id: string;
  minutes: number;
  strikes: number;
  cleanStrikes: number;
  reads: number;
  matches: Match[];
  fakes: Strike[];
  dodges: number;
  ducks: number;
  blocks: number;
  blocksGuarded: number;
};

const LENIENT: Record<string, string> = { overhand: 'hook' };

export function scoreSide(side: HackSide, intents: Intent[]): SideScore {
  const labels = side.labels.filter((l) => l.kind === 'strike');
  const reads = intents.filter((i): i is Strike => i.kind === 'strike');
  const used = new Set<HackLabel>();
  const matched = new Set<Strike>();
  const matches: Match[] = [];
  for (const sameArm of [true, false]) {
    for (const s of reads) {
      if (matched.has(s)) continue;
      let best: { d: number; l: HackLabel } | null = null;
      for (const l of labels) {
        if (used.has(l) || sameArm !== (l.limb === s.limb)) continue;
        const peak = l.peak ?? l.start + 250;
        if (!((s.onsetT >= l.start - 250 && s.onsetT <= peak + 150) || (s.t >= l.start && s.t <= peak + 300))) continue;
        const d = Math.abs(s.onsetT - l.start);
        if (!best || d < best.d) best = { d, l };
      }
      if (!best) continue;
      const l = best.l;
      used.add(l);
      matched.add(s);
      const armOk = l.limb === s.limb;
      matches.push({
        label: l, read: s, armOk,
        styleOk: armOk && l.style === s.style,
        lenientOk: armOk && (LENIENT[l.style ?? ''] ?? l.style) === s.style,
        onset: s.onsetT - l.start, confirm: s.t - l.start,
      });
    }
  }
  // Guard state over time, for the blocks (both hands covering the face): counted when up for most of the block.
  const guardFlips = intents.filter((i): i is Extract<Intent, { kind: 'guard' }> => i.kind === 'guard');
  const guardUpAt = (t: number) => {
    let up = false;
    for (const g of guardFlips) if (g.t <= t) up = g.up;
    return up;
  };
  const blocks = side.labels.filter((l) => l.kind === 'block');
  const blocksGuarded = blocks.filter((b) => {
    let up = 0, n = 0;
    for (let t = b.start; t <= b.end; t += 33) (n++, guardUpAt(t) && up++);
    return n > 0 && up / n > 0.5;
  }).length;
  const t0 = side.frames[0]?.t ?? 0;
  const t1 = side.until ?? side.frames[side.frames.length - 1]?.t ?? t0;
  return {
    id: side.id,
    minutes: (t1 - t0) / 60000,
    strikes: labels.length,
    cleanStrikes: labels.filter((l) => l.clean).length,
    reads: reads.length,
    matches,
    fakes: reads.filter((s) => !matched.has(s)),
    dodges: intents.filter((i) => i.kind === 'dodge').length,
    ducks: intents.filter((i) => i.kind === 'duck').length,
    blocks: blocks.length,
    blocksGuarded,
  };
}

export function runHackathon(sides: HackSide[], config: IntentConfig = DEFAULT_INTENT, makeReader: ReaderFactory = defaultReader) {
  return sides.map((side) => scoreSide(side, runClip({ header: {}, frames: side.frames }, config, null, makeReader).intents));
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export type HackSummary = {
  sides: number; strikes: number; recall: number; arm: number; style: number; lenient: number; precision: number;
  fakesPerMin: number; dodgesPerMin: number; ducks: number; blocks: string; onsetMs: number; confirmMs: number; cleanRecall: number;
};

export function summarizeHackathon(scores: SideScore[]): HackSummary {
  const sum = (f: (s: SideScore) => number) => scores.reduce((a, s) => a + f(s), 0);
  const strikes = sum((s) => s.strikes);
  const all = scores.flatMap((s) => s.matches);
  const sameArm = all.filter((m) => m.armOk);
  const minutes = sum((s) => s.minutes);
  const clean = all.filter((m) => m.label.clean).length;
  const cleanLabels = sum((s) => s.cleanStrikes);
  return {
    sides: scores.length,
    strikes,
    recall: all.length / strikes,
    arm: sameArm.length / strikes,
    style: all.filter((m) => m.styleOk).length / strikes,
    lenient: all.filter((m) => m.lenientOk).length / strikes,
    precision: all.length / Math.max(1, sum((s) => s.reads)),
    fakesPerMin: sum((s) => s.fakes.length) / minutes,
    dodgesPerMin: sum((s) => s.dodges) / minutes,
    ducks: sum((s) => s.ducks),
    blocks: `${sum((s) => s.blocksGuarded)}/${sum((s) => s.blocks)}`,
    onsetMs: median(sameArm.map((m) => m.onset)),
    confirmMs: median(sameArm.map((m) => m.confirm)),
    cleanRecall: clean / Math.max(1, cleanLabels),
  };
}

export function formatSummary(name: string, s: HackSummary) {
  const p = (x: number) => `${(100 * x).toFixed(1)}%`;
  return `${name.padEnd(14)} recall ${p(s.recall)} arm ${p(s.arm)} style ${p(s.style)} (lenient ${p(s.lenient)}) precision ${p(s.precision)} ` +
    `fakes/min ${s.fakesPerMin.toFixed(1)} dodges/min ${s.dodgesPerMin.toFixed(1)} ducks ${s.ducks} blocks ${s.blocks} ` +
    `clean ${p(s.cleanRecall)} onset ${Math.round(s.onsetMs)} confirm ${Math.round(s.confirmMs)} ms (${s.sides} sides, ${s.strikes} strikes)`;
}
