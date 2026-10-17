// Calibrate on the first part of a synthetic session (prompted strikes), then score the rest with and
// without the calibration.
import { expect, test } from 'vitest';
import { calibrate, type CalibrationPrompt } from '../../src/intent/calibration';
import { DEFAULT_INTENT } from '../../src/intent/intents';
import type { PoseFrame } from '../../src/types';
import { evaluate } from './eval';
import { synthesize } from './synth';

const STYLE: Record<string, 'straight' | 'hook' | 'upper'> = { jab: 'straight', cross: 'straight', hookL: 'hook', hookR: 'hook', upperL: 'upper', upperR: 'upper' };

for (const cameraYaw of [0, 45]) {
  test(`calibration helps (camera ${cameraYaw}°)`, () => {
    const rows: string[] = [];
    let before = 0, after = 0;
    for (const seed of [11, 12, 13]) {
      const { frames, labels } = synthesize({ seconds: 150, seed, cameraYaw });
      const split = 45_000;
      const calFrames = frames.filter((f): f is PoseFrame => !('missing' in f) && f.t < split);
      const prompts: CalibrationPrompt[] = labels
        .filter((l) => l.start < split && STYLE[l.name] && l.limb)
        .map((l) => ({ limb: l.limb!, style: STYLE[l.name], start: l.start, end: l.end + 200 }));
      const cal = calibrate(calFrames, prompts, DEFAULT_INTENT);
      const testFrames = frames.filter((f) => f.t >= split);
      const testLabels = labels.filter((l) => l.start >= split);
      const base = evaluate(testFrames, testLabels);
      const tuned = evaluate(testFrames, testLabels, cal.config, cal.matcher);
      const arm = (r: typeof base) => r.scores.filter((s) => STYLE[s.name]);
      const sum = (r: typeof base, k: 'hits' | 'labels' | 'styleOk') => arm(r).reduce((a, s) => a + s[k], 0);
      before += sum(base, 'styleOk');
      after += sum(tuned, 'styleOk');
      rows.push(`seed ${seed}: examples ${cal.matcher.size}/${prompts.length}, strikeDist ${cal.config.arm.strikeDist.toFixed(2)}  ` +
        `base caught ${sum(base, 'hits')}/${sum(base, 'labels')} style ${sum(base, 'styleOk')}  ` +
        `calibrated caught ${sum(tuned, 'hits')}/${sum(tuned, 'labels')} style ${sum(tuned, 'styleOk')}  ` +
        `false positives ${base.falsePositives.length} -> ${tuned.falsePositives.length}`);
    }
    console.log(`\ncamera ${cameraYaw}°\n` + rows.join('\n'));
    expect(after).toBeGreaterThanOrEqual(before * 0.9);
  });
}
