import type { Landmark, PoseFrame } from '../types';

/**
 * One Euro filtering removes idle jitter while raising its cutoff as movement
 * accelerates. Fast punches therefore stay responsive instead of feeling
 * delayed by a fixed moving average.
 */
class OneEuro {
  private previousValue: number | null = null;
  private previousDerivative = 0;
  private previousTime = 0;

  constructor(private readonly minCutoff: number, private readonly beta: number, private readonly derivativeCutoff = 1) {}

  filter(value: number, timeMs: number) {
    if (this.previousValue === null) {
      this.previousValue = value;
      this.previousTime = timeMs;
      return value;
    }
    const dt = Math.max(1 / 240, Math.min(0.1, (timeMs - this.previousTime) / 1000));
    const derivative = (value - this.previousValue) / dt;
    this.previousDerivative += alpha(this.derivativeCutoff, dt) * (derivative - this.previousDerivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.previousDerivative);
    this.previousValue += alpha(cutoff, dt) * (value - this.previousValue);
    this.previousTime = timeMs;
    return this.previousValue;
  }
}

type LandmarkFilters = { x: OneEuro; y: OneEuro; z: OneEuro };

export class LandmarkFilter {
  private image: LandmarkFilters[] = [];
  private world: LandmarkFilters[] = [];

  reset() {
    this.image = [];
    this.world = [];
  }

  filter(frame: PoseFrame): PoseFrame {
    return {
      t: frame.t,
      image: this.filterLandmarks(frame.image, this.image, frame.t, 1.8, 0.08),
      // World depth is noisier, so it gets a little more idle smoothing while
      // beta keeps a fast limb extension responsive.
      world: this.filterLandmarks(frame.world, this.world, frame.t, 1.4, 0.16),
    };
  }

  private filterLandmarks(points: Landmark[], filters: LandmarkFilters[], timeMs: number, minCutoff: number, beta: number) {
    return points.map((point, index) => {
      const filter = filters[index] ??= {
        x: new OneEuro(minCutoff, beta), y: new OneEuro(minCutoff, beta), z: new OneEuro(minCutoff, beta),
      };
      return {
        x: filter.x.filter(point.x, timeMs),
        y: filter.y.filter(point.y, timeMs),
        z: filter.z.filter(point.z, timeMs),
        visibility: point.visibility,
      };
    });
  }
}

function alpha(cutoff: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
