// Dumps what the intent reader sees and says, for offline experiments (research/move-research.md):
// per frame the preprocessed body (body units), per clip every intent from the default reader and from a
// sensitive one, plus the labels. Synthetic clips over every condition, and real clips when given.
// Usage: DUMP_OUT=dir [CLIPS_DIR=dir] [GUIDED=a.jsonl,b.jsonl] [EXTRA=c.jsonl,...] [SEEDS=4] npx vitest run test/research/dump.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { IntentReader } from '../../src/intent/IntentReader';
import { DEFAULT_INTENT, type Intent, type IntentConfig } from '../../src/intent/intents';
import type { Body } from '../../src/intent/preprocess';
import type { PoseFrame } from '../../src/types';
import { loadClip, type ClipFrame } from '../intent/clip';
import { CONDITIONS } from '../intent/conditions';
import { labeledClips, loadGuided } from '../intent/real';
import { synthesize } from '../intent/synth';

const OUT = process.env.DUMP_OUT;
/** Landmarks kept per frame: nose, ears, shoulders, elbows, wrists, pinkies, indexes, hips. */
const KEEP = [0, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24];
/** Per kept point: p.xyz, vf.xyz, visibility, ok. Then elbow L, R, vL, vR, scale, fullBody, root x, y. */
const PER_POINT = 8;
const EXTRA = 8;
const STRIDE = KEEP.length * PER_POINT + EXTRA + 1; // + t

const SENSITIVE: IntentConfig = {
  ...DEFAULT_INTENT,
  arm: { ...DEFAULT_INTENT.arm, onsetSpeed: DEFAULT_INTENT.arm.onsetSpeed * 0.6, onsetDist: DEFAULT_INTENT.arm.onsetDist * 0.6, strikeDist: DEFAULT_INTENT.arm.strikeDist * 0.5 },
};

function row(body: Body): number[] {
  const r = [body.t];
  for (const k of KEEP) {
    const q = body.points[k];
    r.push(q.p.x, q.p.y, q.p.z, q.vf.x, q.vf.y, q.vf.z, q.visibility, q.ok ? 1 : 0);
  }
  r.push(body.elbow.L, body.elbow.R, body.elbow.vL, body.elbow.vR, body.scale, body.fullBody ? 1 : 0, body.root.x, body.root.y);
  return r;
}

const slim = (i: Intent) => i;

function dump(name: string, frames: ClipFrame[], meta: Record<string, unknown>) {
  const run = (config: IntentConfig, keepBodies: boolean) => {
    const reader = new IntentReader('p1', config);
    reader.setMatcher(null);
    const intents: unknown[] = [];
    const rows: number[] = [];
    for (const f of frames) {
      if ('missing' in f) {
        reader.update(null, f.t);
        continue;
      }
      const out = reader.update(f as PoseFrame, f.t);
      for (const i of out.intents) intents.push(slim(i));
      if (keepBodies && out.body && out.body.t === f.t) rows.push(...row(out.body));
    }
    return { intents, rows };
  };
  const def = run(DEFAULT_INTENT, true);
  const sens = run(SENSITIVE, false);
  fs.writeFileSync(path.join(OUT!, `${name}.f32`), Buffer.from(new Float32Array(def.rows).buffer));
  fs.writeFileSync(path.join(OUT!, `${name}.json`), JSON.stringify({ name, stride: STRIDE, keep: KEEP, ...meta, intents: def.intents, sensitive: sens.intents }));
}

test.skipIf(!OUT)('dump clips', { timeout: 1_800_000 }, () => {
  fs.mkdirSync(OUT!, { recursive: true });
  const seeds = Number(process.env.SEEDS ?? 4);
  let n = 0;
  for (const [ci, c] of CONDITIONS.entries()) {
    for (let s = 1; s <= seeds; s++) {
      const seed = 1000 * (ci + 1) + s;
      const { frames, labels } = synthesize({ ...c.options, seed });
      dump(`synth-${String(ci).padStart(2, '0')}-${s}`, frames, { source: 'synth', condition: c.name, seed, labels });
      n++;
    }
  }
  const dir = process.env.CLIPS_DIR;
  if (dir) for (const { file, frames } of labeledClips(dir)) {
    dump(`stock-${file.clip.split('.')[0]}`, frames, { source: 'stock', labels: file.labels, until: file.until ?? null });
    n++;
  }
  for (const g of (process.env.GUIDED ?? '').split(',').filter(Boolean)) {
    const clip = loadGuided(g);
    if (!clip) continue;
    dump(`guided-${path.basename(g, '.jsonl')}`, clip.frames, { source: 'guided', labels: clip.labels });
    n++;
  }
  for (const e of (process.env.EXTRA ?? '').split(',').filter(Boolean)) {
    dump(`extra-${path.basename(e, '.jsonl')}`, loadClip(e).frames, { source: 'extra', labels: [] });
    n++;
  }
  console.log(`dumped ${n} clips to ${OUT}`);
});
