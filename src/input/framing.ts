import type { PoseFrame } from '../types';

/**
 * Is the player framed so the camera can read them? At the hackathon most laptops sat low on a table: heads were cut
 * off in 11 of 162 recordings (garbage skeletons that change size 2–6x a frame), bodies sat too low in 8 and a wrist
 * was out of the shot over a quarter of the time in 26. This looks at the last few seconds of poses and says the one
 * thing to fix, or nothing.
 */
export type FramingHint = { kind: 'head' | 'close' | 'far' | 'hands' | 'side'; text: string };

/** Samples kept (the camera picture samples about 4 a second) and the share a problem must hold in to be said. */
const WINDOW = 12;
const MOST = 0.7;

const VIS = 0.4;

export class FramingCoach {
  private samples: (FramingHint | null)[] = [];
  private lastT = NaN;

  /** One sample: the newest pose (or null when nobody's tracked). Returns the hint to show, if any. */
  update(frame: PoseFrame | null | undefined): FramingHint | null {
    if (frame && frame.t === this.lastT) return this.current();
    this.lastT = frame?.t ?? NaN;
    this.samples.push(frame?.image.length ? framingOf(frame) : null);
    if (this.samples.length > WINDOW) this.samples.shift();
    return this.current();
  }

  private current(): FramingHint | null {
    if (this.samples.length < WINDOW / 2) return null;
    const counts = new Map<FramingHint['kind'], { n: number; hint: FramingHint }>();
    for (const h of this.samples) if (h) counts.set(h.kind, { n: (counts.get(h.kind)?.n ?? 0) + 1, hint: h });
    let best: { n: number; hint: FramingHint } | null = null;
    for (const c of counts.values()) if (!best || c.n > best.n) best = c;
    return best && best.n >= MOST * this.samples.length ? best.hint : null;
  }
}

/** What's wrong with one frame's framing, worst first (null: fine). */
export function framingOf(frame: PoseFrame): FramingHint | null {
  const p = frame.image;
  const ls = p[11], rs = p[12], nose = p[0], lw = p[15], rw = p[16];
  if (!ls || !rs || ls.visibility < VIS || rs.visibility < VIS) return null;
  const aspect = frame.aspect ?? 4 / 3;
  // Shoulder width as a share of the frame width (image x is 0..1 across the width).
  const shoulders = Math.hypot(ls.x - rs.x, (ls.y - rs.y) / aspect);
  const shoulderY = (ls.y + rs.y) / 2;
  // The top of the head sits about half the nose-to-shoulders drop above the nose.
  const headTop = nose ? nose.y - 0.55 * (shoulderY - nose.y) : -1;
  if (!nose || nose.visibility < VIS || headTop < -0.01) return { kind: 'head', text: 'Tilt your screen back: your head is cut off' };
  if (shoulders > 0.42) return { kind: 'close', text: 'Step back a little: you are too close' };
  if (shoulders < 0.13) return { kind: 'far', text: 'Come a bit closer to the camera' };
  const cx = (ls.x + rs.x) / 2;
  if (cx < 0.2 || cx > 0.8) return { kind: 'side', text: 'Move to the middle of the shot' };
  const handsOut = (lw?.visibility ?? 0) < VIS || (rw?.visibility ?? 0) < VIS;
  if (handsOut && shoulderY > 0.45) return { kind: 'hands', text: 'Tilt your screen down or step back: keep your hands in the shot' };
  return null;
}
