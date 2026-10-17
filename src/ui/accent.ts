import type { PlayerId } from '../types';

/** Per-player Tailwind classes, spelled out in full so Tailwind can see them. */
export const ACCENT: Record<PlayerId, { text: string; bg: string; border: string; tag: string }> = {
  p1: { text: 'text-p1', bg: 'bg-p1', border: 'border-p1', tag: 'P1' },
  p2: { text: 'text-p2', bg: 'bg-p2', border: 'border-p2', tag: 'P2' },
};
