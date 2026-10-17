/**
 * One Euro filter (Casiez et al. 2012): heavy smoothing when a value is still, light smoothing when it moves
 * fast. That kills tracking jitter at rest without adding lag to punches.
 *   minCutoff: lower = smoother at rest (Hz)
 *   beta:      higher = less lag when moving (scales with speed in units per second)
 */
export type OneEuroParams = { minCutoff: number; beta: number; dCutoff: number };

export class OneEuro {
  private x: number | null = null;
  private dx = 0;

  constructor(public params: OneEuroParams) {}

  reset() {
    this.x = null;
    this.dx = 0;
  }

  get value() {
    return this.x;
  }

  /** dt in seconds. */
  filter(value: number, dt: number): number {
    if (this.x === null || dt <= 0) {
      this.x = value;
      this.dx = 0;
      return value;
    }
    const { minCutoff, beta, dCutoff } = this.params;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(dCutoff, dt) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

function alpha(cutoff: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
