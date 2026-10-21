// Scoring on real recordings: hand-labeled stock clips (labels/*.json) and guided-test sessions (the tuner's
// prompted moves, labels inside the file).
import fs from 'node:fs';
import path from 'node:path';
import type { Intent, IntentConfig } from '../../src/intent/intents';
import { DEFAULT_INTENT } from '../../src/intent/intents';
import type { PoseFrame } from '../../src/types';
import { defaultReader, loadClip, runClip, type ClipFrame, type ReaderFactory } from './clip';
import { evaluate, type EvalResult } from './eval';
import type { Label } from './synth';

export type LabelFile = { clip: string; until?: number; labels: (Label & { frames?: string })[] };

export const LABELS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'labels');

/** Hand-labeled stock clips whose pose JSONL is in `dir`. */
export function labeledClips(dir: string): { file: LabelFile; frames: ClipFrame[] }[] {
  if (!fs.existsSync(LABELS_DIR)) return [];
  return fs.readdirSync(LABELS_DIR).filter((f) => f.endsWith('.json')).flatMap((f) => {
    const file = JSON.parse(fs.readFileSync(path.join(LABELS_DIR, f), 'utf8')) as LabelFile;
    const clipPath = path.join(dir, file.clip);
    if (!fs.existsSync(clipPath)) return [];
    const frames = loadClip(clipPath).frames.filter((fr) => file.until === undefined || fr.t <= file.until);
    return [{ file, frames }];
  });
}

/** Strike labels caught by any arm strike (limb-agnostic): MediaPipe swaps hands on hard clips. */
export function anyArmHits(result: EvalResult) {
  const strikes = result.intents.filter((i): i is Extract<Intent, { kind: 'strike' }> => i.kind === 'strike');
  const labels = result.labels.filter((l) => l.kind === 'strike');
  const used = new Set<Intent>();
  let hits = 0;
  for (const l of labels) {
    const arm = l.limb?.startsWith('arm');
    const m = strikes.find((s) => !used.has(s) && s.t >= l.start && s.t <= l.end + 250 && (arm ? s.limb.startsWith('arm') : s.limb.startsWith('leg')));
    if (m) (used.add(m), hits++);
  }
  return { hits, labels: labels.length, unmatched: strikes.length - used.size };
}

export type GuidedLabel = { say: string; expect: { kind: string; limb?: string; style?: string; dir?: string }; start: number; end: number };
export type GuidedScore = {
  file: string;
  lines: string[];
  rows: { t: number; say: string; verdict: string; seen: string }[];
  strikes: number; caught: number; styled: number;
  other: number; otherOk: number;
  /** Strikes (or dodges/ducks/jumps) where none was asked for: stay-still, wave, scratch, block, duck, lean, or the wrong arm. */
  fakes: number;
  /** Extra strikes by the asked-for arm after the first (people sometimes really do punch twice). */
  doubles: number;
  fps: number;
};

export function loadGuided(file: string): { labels: GuidedLabel[]; frames: PoseFrame[] } | null {
  const [header, ...rest] = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  if (!Array.isArray(header.labels)) return null;
  return { labels: header.labels, frames: rest.filter((f: { image?: unknown }) => f.image) as PoseFrame[] };
}

const describe = (i: Intent) => i.kind === 'strike' ? `${i.limb}:${i.style}` : i.kind === 'guard' ? `guard:${i.up ? 'up' : 'down'}`
  : i.kind === 'dodge' ? `dodge:${i.dir}` : i.kind === 'cancel' ? `(cancel ${i.limb}: ${i.reason})` : i.kind;

export function scoreGuided(file: string, config: IntentConfig = DEFAULT_INTENT, makeReader: ReaderFactory = defaultReader): GuidedScore | null {
  const g = loadGuided(file);
  if (!g) return null;
  const { intents } = runClip({ header: {}, frames: g.frames }, config, null, makeReader);
  const shown = intents.filter((i) => i.kind !== 'anticipate' && i.kind !== 'cancel');
  const t0 = g.frames[0].t;
  const dts = g.frames.slice(1).map((f, k) => f.t - g.frames[k].t).sort((a, b) => a - b);
  const s: GuidedScore = { file: path.basename(file), lines: [], rows: [], strikes: 0, caught: 0, styled: 0, other: 0, otherOk: 0, fakes: 0, doubles: 0, fps: 1000 / dts[Math.floor(dts.length / 2)] };
  const actions = (xs: Intent[]) => xs.filter((i) => i.kind === 'strike' || i.kind === 'dodge' || i.kind === 'duck' || i.kind === 'jump');
  for (const l of g.labels) {
    const during = shown.filter((i) => i.t >= l.start && i.t <= l.end);
    let verdict = '';
    if (l.expect.kind === 'strike') {
      s.strikes++;
      const mine = during.filter((i): i is Extract<Intent, { kind: 'strike' }> => i.kind === 'strike' && i.limb === l.expect.limb);
      if (mine.length) s.caught++;
      if (mine.length && mine[0].style === l.expect.style) s.styled++;
      s.doubles += Math.max(0, mine.length - 1);
      const wrong = actions(during).filter((i) => !(i.kind === 'strike' && i.limb === l.expect.limb));
      s.fakes += wrong.length;
      verdict = !mine.length ? 'MISS' : mine[0].style === l.expect.style ? 'ok' : `ok, style ${mine[0].style}`;
      if (wrong.length) verdict += `, +${wrong.length} fake`;
    } else if (l.expect.kind === 'none') {
      const fake = actions(during);
      s.fakes += fake.length;
      verdict = fake.length ? `${fake.length} FAKE` : 'ok';
    } else {
      s.other++;
      // A guard counts if it's up during the prompt, even when it went up before (a chest guard often already is).
      const guardUp = (t: number) => shown.filter((i): i is Extract<Intent, { kind: 'guard' }> => i.kind === 'guard' && i.t <= t).pop()?.up ?? false;
      const ok = l.expect.kind === 'guard'
        ? Array.from({ length: Math.max(1, Math.round((l.end - l.start) / 100)) }, (_, k) => l.start + k * 100).some(guardUp)
        : during.some((i) => i.kind === l.expect.kind && (i.kind !== 'dodge' || !l.expect.dir || i.dir === l.expect.dir));
      if (ok) s.otherOk++;
      const fake = actions(during).filter((i) => !(i.kind === l.expect.kind && (i.kind !== 'dodge' || !l.expect.dir || i.dir === l.expect.dir)));
      s.fakes += fake.length;
      verdict = (ok ? 'ok' : 'MISS') + (fake.length ? `, +${fake.length} fake` : '');
    }
    const seen = during.map(describe).join(', ') || '-';
    s.rows.push({ t: (l.start - t0) / 1000, say: l.say, verdict, seen });
    s.lines.push(`${((l.start - t0) / 1000).toFixed(1).padStart(5)}s  ${l.say.padEnd(18)} ${verdict.padEnd(22)} ${seen}`);
  }
  return s;
}

/** Comma-separated files, or a directory of .jsonl files. */
export function listClips(spec: string | undefined): string[] {
  if (!spec) return [];
  return spec.split(',').flatMap((p) => (fs.existsSync(p) && fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(p, f))
    : fs.existsSync(p) ? [p] : []));
}

/** Free-form clips with no labels: what the reader saw. */
export function summarizeUnlabeled(file: string, config: IntentConfig = DEFAULT_INTENT, makeReader: ReaderFactory = defaultReader) {
  const clip = loadClip(file);
  const { intents } = runClip(clip, config, null, makeReader);
  const counts = new Map<string, number>();
  for (const i of intents) {
    if (i.kind === 'anticipate' || i.kind === 'cancel' || (i.kind === 'guard' && !i.up)) continue;
    const k = i.kind === 'strike' ? `${i.limb}:${i.style}` : i.kind === 'dodge' ? `dodge:${i.dir}` : i.kind;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const ts = clip.frames.map((f) => f.t);
  return { file: path.basename(file), seconds: (ts[ts.length - 1] - ts[0]) / 1000, counts: Object.fromEntries([...counts.entries()].sort()), intents };
}

export { evaluate };
