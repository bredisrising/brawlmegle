import { createPose, JOINTS, type Pose } from './pose';
import type { PoseTracker } from './PoseTracker';

/** Rough standing guard pose (fighter-local, 1m tall). */
const STANDING: Pose = (() => {
  const p = createPose();
  p.head.set(0, 0.9, 0);
  p.neck.set(0, 0.82, 0);
  p.lShoulder.set(0.12, 0.78, 0); p.rShoulder.set(-0.12, 0.78, 0);
  p.lElbow.set(0.15, 0.66, 0.04); p.rElbow.set(-0.15, 0.66, 0.04);
  p.lWrist.set(0.07, 0.76, 0.15); p.rWrist.set(-0.07, 0.76, 0.12);
  p.lHip.set(0.07, 0.5, 0); p.rHip.set(-0.07, 0.5, 0);
  p.lKnee.set(0.075, 0.27, 0.05); p.rKnee.set(-0.075, 0.27, -0.03);
  p.lAnkle.set(0.07, 0.03, 0.08); p.rAnkle.set(-0.07, 0.03, -0.06);
  return p;
})();

/**
 * Stand-in for the vision model so the game can run without cameras.
 * Returns a standing pose with a little idle bob.
 *
 * TODO: keyboard-driven punches/blocks for testing combat without a camera.
 */
export class MockPoseTracker implements PoseTracker {
  readonly kind = 'mock';
  private readonly pose = createPose();

  async start() {}
  stop() {}

  getPose(): Pose {
    const bob = Math.sin(performance.now() / 250) * 0.008;
    for (const j of JOINTS) this.pose[j].copy(STANDING[j]).setY(STANDING[j].y + (j.includes('Ankle') ? 0 : bob));
    return this.pose;
  }
}
