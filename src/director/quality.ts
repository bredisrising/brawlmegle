import { config } from '../config';

/**
 * Render quality, stepped down (and back up) by the QualityGovernor so the pose tracker keeps its frame rate: the
 * game shares the GPU with MediaPipe, and on an integrated GPU a full-quality fight starves it (6 poses/s instead
 * of the camera's 24–30, which reads as lag). Each level is the full setting list, cheapest-looking cuts first, by
 * what they bought on a Radeon 780M (research/perf-runtime.md).
 */
export type QualityLevel = {
  name: string;
  /** MSAA samples on the HDR scene target (the biggest per-pixel cost on an iGPU). */
  samples: number;
  /** Cap on the device pixel ratio. */
  maxPixelRatio: number;
  bloom: boolean;
  outlines: boolean;
  /** Frames drawn per second at most (the fight sim stays at 60 Hz either way). */
  maxFps: number;
  /** The pose tracker follows one person instead of re-detecting every frame (see poseWorker.ts). */
  singlePose: boolean;
};

const FULL: QualityLevel = { name: 'full', samples: 4, maxPixelRatio: 2, bloom: true, outlines: true, maxFps: 60, singlePose: false };

export const QUALITY_LEVELS: readonly QualityLevel[] = [
  FULL,
  { ...FULL, name: 'msaa2', samples: 2 },
  { ...FULL, name: 'px1', samples: 2, maxPixelRatio: 1 },
  { ...FULL, name: 'msaa0', samples: 0, maxPixelRatio: 1 },
  // The fighters animate on twos (12 fps) anyway: 30 fps halves the GPU's work and the picture barely changes.
  { ...FULL, name: '30fps', samples: 0, maxPixelRatio: 1, maxFps: 30 },
  // Not a render setting: the tracker itself gets cheaper (with MediaPipe's own smoothing, see poseWorker.ts). It comes
  // before the looks go: past this point render cuts barely bought poses on a 780M, and bloom and ink are the arcade look.
  { ...FULL, name: 'one pose', samples: 0, maxPixelRatio: 1, maxFps: 30, singlePose: true },
  { ...FULL, name: 'no bloom', samples: 0, maxPixelRatio: 1, maxFps: 30, singlePose: true, bloom: false },
  { ...FULL, name: 'px0.75', samples: 0, maxPixelRatio: 0.75, maxFps: 30, singlePose: true, bloom: false },
  { ...FULL, name: 'no outlines', samples: 0, maxPixelRatio: 0.75, maxFps: 30, singlePose: true, bloom: false, outlines: false },
];

/** Phones / `?quality=low` start where full quality was never going to fit (no bloom, shadows or outlines there). */
export const START_LEVEL = config.lowPower ? QUALITY_LEVELS.findIndex((l) => l.name === 'msaa0') : 0;

/** The level in effect, for whoever builds things later (a fighter loading in reads `outlines`). */
export const quality = { level: START_LEVEL, current: QUALITY_LEVELS[START_LEVEL] };
