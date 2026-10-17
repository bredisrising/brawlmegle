import type { PoseFrame } from '../types';
import { IntentReader } from './IntentReader';
import type { Intent, IntentConfig, LimbName, StrikeStyle } from './intents';
import { StyleMatcher } from './StyleMatcher';

/**
 * Calibration: the player throws a few prompted moves ("right punch", "left hook"...), and we learn
 *  1. their thresholds: how far and fast their real strikes go, so small movers aren't missed and big
 *     movers don't trigger by accident, and
 *  2. their style examples, so straight / hook / uppercut is decided by matching their own motion.
 * Fits in the forge wait. Runs offline over the recorded frames in a few milliseconds.
 */
export type CalibrationPrompt = { limb: LimbName; style: StrikeStyle; start: number; end: number };
export type CalibrationResult = {
  config: IntentConfig;
  matcher: StyleMatcher;
  /** Per prompt: whether a strike was found, and its size. */
  found: { prompt: CalibrationPrompt; reach: number | null }[];
};

export function calibrate(frames: PoseFrame[], prompts: CalibrationPrompt[], base: IntentConfig): CalibrationResult {
  // Replay with a very sensitive reader so even the player's smallest real strikes show up as candidates.
  const sensitive: IntentConfig = {
    ...base,
    arm: { ...base.arm, onsetSpeed: base.arm.onsetSpeed * 0.6, onsetDist: base.arm.onsetDist * 0.6, strikeDist: base.arm.strikeDist * 0.5 },
  };
  const reader = new IntentReader('p1', sensitive);
  const strikes: Extract<Intent, { kind: 'strike' }>[] = [];
  for (const frame of frames) {
    for (const intent of reader.update(frame, frame.t).intents) if (intent.kind === 'strike') strikes.push(intent);
  }

  const matcher = new StyleMatcher();
  const found: CalibrationResult['found'] = [];
  const reaches: number[] = [];
  const speeds: number[] = [];
  for (const prompt of prompts) {
    // The biggest strike by that limb inside the prompt's window is the example.
    const best = strikes
      .filter((s) => s.limb === prompt.limb && s.t >= prompt.start && s.t <= prompt.end)
      .sort((a, b) => b.reach - a.reach)[0];
    found.push({ prompt, reach: best?.reach ?? null });
    if (!best) continue;
    reaches.push(best.reach);
    speeds.push(best.rawSpeed);
    if (best.features) matcher.add(prompt.style, best.features);
  }

  // Thresholds from the player's real strikes: confirm at 70% of a typical strike, start at 60% of typical speed.
  const config: IntentConfig = { ...base, arm: { ...base.arm } };
  // Only ever more sensitive (for small movers), and by at most 25%: missing punches is bad, phantom ones worse.
  if (reaches.length >= 3) {
    config.arm.strikeDist = clamp(0.7 * median(reaches), base.arm.strikeDist * 0.75, base.arm.strikeDist);
    config.arm.onsetDist = Math.min(base.arm.onsetDist, config.arm.strikeDist * 0.5);
    config.arm.onsetSpeed = clamp(0.6 * median(speeds), base.arm.onsetSpeed * 0.75, base.arm.onsetSpeed);
  }
  return { config, matcher, found };
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
