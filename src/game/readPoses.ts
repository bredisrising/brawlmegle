import type { IntentOutput } from '../intent/IntentReader';
import type { PoseFrame } from '../types';

/**
 * A tick's read of one player: every pose that arrived since the last tick through their reader, oldest first, as one
 * output (all their intents and commands, the newest stance). With none new, the newest pose again: a repeat reads as
 * nothing, but the reader notices a player who's gone.
 */
export function readPoses(reader: { update(frame: PoseFrame): IntentOutput }, frames: readonly PoseFrame[], latest: PoseFrame | null): IntentOutput | null {
  if (!frames.length) return latest ? reader.update(latest) : null;
  let out: IntentOutput | null = null;
  for (const frame of frames) {
    const next = reader.update(frame);
    out = out ? { ...next, commands: [...out.commands, ...next.commands], intents: [...out.intents, ...next.intents] } : next;
  }
  return out;
}
