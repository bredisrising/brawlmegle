import type { ForgedFighter } from '../types';
import type { ScanProgress } from './scanBuckets';

/** Player-facing text for scan and forge progress (statusDetail on the lobby / client screens). */

export const FORGE_STEPS: Record<NonNullable<ForgedFighter['step']>, string> = {
  brief: 'Sizing you up',
  sheet: 'Drawing your fighter',
  model: 'Building your 3D model',
  cleanup: 'Polishing',
  rig: 'Rigging your fighter',
};

const TICK = ['·', '½', '✓'] as const;

/** "Turn slowly to your left… front ✓ left · right ½" */
export function scanStatus(p: ScanProgress): string {
  const b = p.buckets;
  return `${p.hint}  front ${TICK[b.front.tier]} left ${TICK[b.left.tier]} right ${TICK[b.right.tier]}`;
}

export function forgeStatus(f: ForgedFighter): string {
  if (f.status === 'failed') return 'Forge failed, using a stock fighter';
  if (f.status === 'ready') return 'Fighter ready';
  return f.step ? FORGE_STEPS[f.step] : 'Forging your fighter';
}

/** Wraps a setter so it only fires when the text changes (scan progress arrives every camera frame). */
export function onChange(set: (text: string) => void): (text: string) => void {
  let last: string | null = null;
  return (text) => {
    if (text !== last) set((last = text));
  };
}
