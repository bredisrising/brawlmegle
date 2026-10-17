// Builds the shared style model (src/intent/styleModel.json) from everyone's guided-test sessions and checks
// how well it generalizes: each session is scored with a model built from all the *other* sessions.
// Usage: SAMPLES_DIR=path/to/samples npx vitest run test/intent/train.test.ts [WRITE_MODEL=1]
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { calibrate, type CalibrationPrompt } from '../../src/intent/calibration';
import { DEFAULT_INTENT, type LimbName, type StrikeStyle } from '../../src/intent/intents';
import { IntentReader } from '../../src/intent/IntentReader';
import { StyleMatcher } from '../../src/intent/StyleMatcher';
import type { PoseFrame } from '../../src/types';

type GuidedLabel = { say: string; expect: { kind: string; limb?: LimbName; style?: StrikeStyle; dir?: string }; start: number; end: number };
type Session = { file: string; frames: PoseFrame[]; labels: GuidedLabel[] };

const dir = process.env.SAMPLES_DIR;

function load(): Session[] {
  return fs.readdirSync(dir!).filter((f) => f.endsWith('.jsonl')).flatMap((file) => {
    const [header, ...rest] = fs.readFileSync(path.join(dir!, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const frames = rest.filter((f: PoseFrame & { missing?: boolean }) => !f.missing && f.image) as PoseFrame[];
    return Array.isArray(header.labels) && header.labels.length && frames.length > 60 ? [{ file, frames, labels: header.labels }] : [];
  });
}

const prompts = (s: Session): CalibrationPrompt[] => s.labels
  .filter((l) => l.expect.kind === 'strike' && l.expect.limb && l.expect.style)
  .map((l) => ({ limb: l.expect.limb!, style: l.expect.style!, start: l.start, end: l.end }));

/** Runs a reader over a session and scores every prompt: caught? right style? anything during "stay still"? */
function score(s: Session, matcher: StyleMatcher | null) {
  const reader = new IntentReader('p1', DEFAULT_INTENT);
  reader.setMatcher(matcher);
  const intents = s.frames.flatMap((f) => reader.update(f, f.t).intents);
  let strikes = 0, caught = 0, styled = 0, other = 0, otherOk = 0, quiet = 0, fakes = 0;
  for (const l of s.labels) {
    const during = intents.filter((i) => i.t >= l.start && i.t <= l.end);
    if (l.expect.kind === 'strike') {
      strikes++;
      const hit = during.find((i) => i.kind === 'strike' && i.limb === l.expect.limb);
      if (hit) caught++;
      if (hit && hit.kind === 'strike' && hit.style === l.expect.style) styled++;
    } else if (l.expect.kind === 'none') {
      quiet++;
      fakes += during.filter((i) => i.kind === 'strike').length;
    } else {
      other++;
      if (during.some((i) => i.kind === l.expect.kind && (i.kind !== 'guard' || i.up))) otherOk++;
    }
  }
  return { strikes, caught, styled, other, otherOk, quiet, fakes };
}

test.skipIf(!dir)('train shared style model', () => {
  const sessions = load();
  console.log(`${sessions.length} sessions, ${sessions.reduce((n, s) => n + prompts(s).length, 0)} strike prompts`);
  const total = { rules: { strikes: 0, caught: 0, styled: 0 }, pooled: { styled: 0 }, other: 0, otherOk: 0, quiet: 0, fakes: 0 };
  for (const held of sessions) {
    const pooled = new StyleMatcher();
    for (const s of sessions) if (s !== held) for (const t of calibrate(s.frames, prompts(s), DEFAULT_INTENT).matcher.templates) pooled.add(t.style, t.features);
    const rules = score(held, null);
    const withModel = score(held, pooled);
    total.rules.strikes += rules.strikes; total.rules.caught += rules.caught; total.rules.styled += rules.styled;
    total.pooled.styled += withModel.styled;
    total.other += rules.other; total.otherOk += rules.otherOk; total.quiet += rules.quiet; total.fakes += rules.fakes;
    console.log(`${held.file}: caught ${rules.caught}/${rules.strikes}, style rules ${rules.styled} vs shared model ${withModel.styled}, ` +
      `guard/duck/dodge ${rules.otherOk}/${rules.other}, fakes during stay-still ${rules.fakes}`);
  }
  console.log(`TOTAL caught ${total.rules.caught}/${total.rules.strikes}, style rules ${total.rules.styled} vs shared model ${total.pooled.styled}, ` +
    `guard/duck/dodge ${total.otherOk}/${total.other}, fakes ${total.fakes} in ${total.quiet} stay-still prompts`);

  if (process.env.WRITE_MODEL) {
    const all = new StyleMatcher();
    for (const s of sessions) for (const t of calibrate(s.frames, prompts(s), DEFAULT_INTENT).matcher.templates) all.add(t.style, t.features);
    fs.writeFileSync('src/intent/styleModel.json', JSON.stringify(all.toJSON()));
    console.log(`wrote src/intent/styleModel.json with ${all.size} examples`);
  }
});
