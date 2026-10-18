// The reader on real recordings. Everything is opt-in by environment variable (the pose files are large and
// not in the repo):
//   POSE_CLIPS_DIR=dir   stock clips run through MediaPipe (36564.full.jsonl ...), scored against labels/*.json
//   GUIDED_CLIPS=a,b|dir guided-test sessions from the tuner (prompted moves, labels inside the file)
//   USER_CLIPS=a,b|dir   free-form tuner recordings: prints what the reader saw
//   REAL_OUT=file.json   saves the numbers for before/after comparisons
import fs from 'node:fs';
import { test } from 'vitest';
import { pct, quantile, summarize } from './eval';
import { anyArmHits, evaluate, labeledClips, listClips, scoreGuided, summarizeUnlabeled } from './real';

const out: Record<string, unknown> = {};

test.skipIf(!process.env.POSE_CLIPS_DIR)('hand-labeled stock clips', () => {
  for (const { file, frames } of labeledClips(process.env.POSE_CLIPS_DIR!)) {
    const r = evaluate(frames, file.labels);
    const s = summarize([r]);
    const any = anyArmHits(r);
    const lines = file.labels.filter((l) => l.kind !== 'negative').map((l) => {
      const m = r.intents.find((i) => i.kind === 'strike' && i.limb === l.limb && i.t >= l.start && i.t <= l.end + 250);
      return `  ${String(l.frames ?? '').padEnd(8)} ${l.name.padEnd(7)} ${m && m.kind === 'strike' ? `ok ${m.style} +${Math.round(m.t - l.start)} ms` : 'miss'}`;
    });
    const fps = r.falsePositives.map((f) => `${(f.t / 1000).toFixed(2)}s ${f.kind}`).join(', ');
    const strikeLabels = file.labels.filter((l) => l.kind === 'strike').length;
    console.log(`\n${file.clip}: strikes ${s.scores.reduce((a, x) => a + x.hits, 0)}/${strikeLabels} (any arm ${any.hits}/${any.labels}), style ${pct(s.styleAccuracy)}, ` +
      `false positives ${r.falsePositives.length}, latency ${Math.round(s.latency.median)}/${Math.round(quantile(s.scores.flatMap((x) => x.commit), 0.9))} ms\n${lines.join('\n')}${fps ? `\n  false positives: ${fps}` : ''}`);
    out[file.clip] = { strikes: s.scores.reduce((a, x) => a + x.hits, 0), labels: strikeLabels, anyArm: any.hits, style: s.styleAccuracy, falsePositives: r.falsePositives.length, latency: s.latency };
  }
});

test.skipIf(!process.env.GUIDED_CLIPS)('guided sessions', () => {
  for (const file of listClips(process.env.GUIDED_CLIPS)) {
    const s = scoreGuided(file);
    if (!s) continue;
    console.log(`\n${s.file} (${s.fps.toFixed(0)} fps): strikes caught ${s.caught}/${s.strikes}, style ${s.styled}/${s.caught}, ` +
      `guard/duck/lean ${s.otherOk}/${s.other}, fakes ${s.fakes}, doubles ${s.doubles}\n${s.lines.join('\n')}`);
    out[s.file] = { caught: s.caught, strikes: s.strikes, styled: s.styled, otherOk: s.otherOk, other: s.other, fakes: s.fakes, doubles: s.doubles };
  }
});

test.skipIf(!process.env.USER_CLIPS)('free-form recordings', () => {
  for (const file of listClips(process.env.USER_CLIPS)) {
    const s = summarizeUnlabeled(file);
    console.log(`${s.file} (${s.seconds.toFixed(0)} s): ${Object.entries(s.counts).map(([k, n]) => `${k}×${n}`).join(' ')}`);
    out[s.file] = s.counts;
  }
});

test.skipIf(!process.env.REAL_OUT)('save', () => {
  fs.writeFileSync(process.env.REAL_OUT!, JSON.stringify(out, null, 1));
});
