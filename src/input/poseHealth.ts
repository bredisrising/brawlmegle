import type { TrackerInfo } from '../types';

/** Something about this laptop's tracking bad enough to tell the player, and what they can do about it. */
export type PoseWarning = { kind: 'cpu' | 'camera' | 'slow'; text: string };

/** The tracking warning of an input source, if it's a camera with one (CameraSource.stats.warning). */
export function poseWarningOf(source: unknown): PoseWarning | null {
  return (source as { stats?: { warning?: PoseWarning | null } } | null)?.stats?.warning ?? null;
}

/** What an input source tracks with, if it's a camera (CameraSource.info). */
export function trackerInfoOf(source: unknown): TrackerInfo | null {
  return (source as { info?: () => TrackerInfo } | null)?.info?.() ?? null;
}

/**
 * Under this many poses a second the reader misses moves: hackathon rounds at 6–8 caught a third of the punches, and
 * 24 is plenty (QualityGovernor's target).
 */
export const SLOW_POSES = 18;
/** Rate windows (2 s each) in a row before a warning shows, and good ones (a little over SLOW_POSES) before it goes. */
const SHOW_AFTER = 3;
const CLEAR_AFTER = 2;
const CLEAR_MARGIN = 2;

/**
 * The camera tracker's rate windows -> a warning on screen, patiently: a slow stretch has to last a few windows (the
 * quality governor steps the render down first, and that usually fixes it), and the warning stays for a couple of
 * good ones. Tracking on the CPU is always said: about 9 poses a second, 127 ms late, and nothing the game can fix.
 */
export class PoseHealth {
  warning: PoseWarning | null = null;
  private bad = 0;
  private good = 0;

  /** One rate window's numbers (`rated`: the model has run for a whole window). */
  update(s: { rated: boolean; detectFps: number; cameraFps: number; delegate: 'GPU' | 'CPU' }): PoseWarning | null {
    if (!s.rated) return this.warning;
    if (s.delegate === 'CPU') {
      return (this.warning = { kind: 'cpu', text: "Tracking runs on the CPU, so moves lag: turn on graphics acceleration in your browser's settings" });
    }
    if (s.detectFps < SLOW_POSES) {
      this.bad++;
      this.good = 0;
    } else if (s.detectFps >= SLOW_POSES + CLEAR_MARGIN) {
      this.good++;
      this.bad = 0;
    }
    if (this.bad >= SHOW_AFTER) {
      // A camera that delivers few frames (it lengthens its exposure in a dim room) caps the poses: light helps there.
      this.warning = s.cameraFps < SLOW_POSES && s.detectFps >= s.cameraFps * 0.8
        ? { kind: 'camera', text: `Camera at ${Math.round(s.cameraFps)} fps: more light on you helps` }
        : { kind: 'slow', text: `Tracking only ${Math.round(s.detectFps)} poses a second: close other tabs and apps` };
    } else if (this.good >= CLEAR_AFTER) {
      this.warning = null;
    }
    return this.warning;
  }
}
