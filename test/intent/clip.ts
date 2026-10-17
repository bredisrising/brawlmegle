// Helpers for running the intent reader over recorded pose clips (JSONL from test/pose/extract.mjs or the tuner).
import fs from 'node:fs';
import type { PoseFrame } from '../../src/types';
import { IntentReader } from '../../src/intent/IntentReader';
import type { Intent, IntentConfig } from '../../src/intent/intents';
import { DEFAULT_INTENT } from '../../src/intent/intents';

export type ClipFrame = PoseFrame | { t: number; missing: true };
export type Clip = { header: Record<string, unknown>; frames: ClipFrame[] };

export function loadClip(path: string): Clip {
  const [header, ...frames] = fs.readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { header, frames };
}

/** Feeds a clip through a fresh reader at its own timestamps. Returns every intent plus per-frame debug. */
export function runClip(clip: Clip, config: IntentConfig = DEFAULT_INTENT) {
  const reader = new IntentReader('p1', config);
  const intents: Intent[] = [];
  const trace: { t: number; debug: unknown }[] = [];
  for (const frame of clip.frames) {
    if ('missing' in frame) {
      reader.update(null, frame.t);
      continue;
    }
    const out = reader.update(frame, frame.t);
    intents.push(...out.intents);
    trace.push({ t: frame.t, debug: out.debug });
  }
  return { intents, trace };
}
