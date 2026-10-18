import { Vector3 } from 'three';
import { GUARD_POSE, type Pose } from './pose';
import { crouch, highGuard, lean, solve, twist, type Motion } from './fightPose';
import { backOut, smoothstep, type EntranceKind } from './walkoutTiming';

/**
 * The walkout's entrance poses, layered on the stance (fighter space: +z toward the opponent, +x the fighter's left;
 * `lead` 1 = P1, -1 = P2, and -lead*x is the side the camera sees). Before the slam the fighter is crouched, head
 * down, fists low, powering up; on the slam they snap (a key frame) into a hero pose and hold it, breathing.
 */
const UPPER_ARM = GUARD_POSE.lShoulder.distanceTo(GUARD_POSE.lElbow);
const FOREARM = GUARD_POSE.lElbow.distanceTo(GUARD_POSE.lWrist);
const a = new Vector3();
const b = new Vector3();
const lateral = new Vector3();
const hint = new Vector3();
const UP = new Vector3(0, 1, 0);

type Side = 1 | -1;
const arm = (s: Side) => (s === 1 ? (['lShoulder', 'lElbow', 'lWrist'] as const) : (['rShoulder', 'rElbow', 'rWrist'] as const));

function reach(pose: Pose, s: Side, target: Vector3, pole: Vector3) {
  const [shoulder, elbow, wrist] = arm(s);
  solve(pose[shoulder], target, UPPER_ARM, FOREARM, pole, pose[elbow], pose[wrist]);
}

/**
 * `t`: seconds into this fighter's shot; `slam`: when their name slams (same clock); `clock`: a free-running time for
 * the breathing. Returns nothing: it writes `pose` and `motion`.
 */
export function entrancePose(pose: Pose, motion: Motion, kind: EntranceKind, t: number, slam: number, lead: Side, clock: number) {
  const camSide = -lead as Side; // the arm nearer the camera (the rear arm in the bladed stance)
  if (t < slam) {
    // Powering up: sink, hunch over, chin down, fists clenched low; a shiver, and a last dip right before the slam.
    const k = smoothstep(t / 0.2);
    const dip = smoothstep((t - (slam - 0.2)) / 0.2);
    crouch(pose, 0.05 * k + 0.035 * dip);
    lean(pose, 0.07 * k + 0.02 * dip);
    twist(pose, -lead * 0.25 * k);
    pose.head.z += 0.025 * k;
    pose.head.y -= 0.03 * k;
    pose.head.x += 0.004 * Math.sin(clock * 47) * k;
    for (const s of [1, -1] as const) {
      const [shoulder] = arm(s);
      a.set(pose[shoulder].x + s * 0.06, pose[shoulder].y - 0.27, pose[shoulder].z + 0.07 + 0.03 * dip);
      a.x += 0.003 * Math.sin(clock * 53 + s);
      reach(pose, s, a, hint.set(s, -0.2, -0.6));
    }
    return;
  }
  const u = t - slam;
  // The snap: limbs overshoot a little on the first frames, then settle.
  const pop = backOut(u / 0.14);
  const breathe = Math.sin(clock * 2 * Math.PI * 0.9);
  if (kind === 'point') {
    // Turn to the camera and point the near fist right down the lens; the other fist on the hip.
    twist(pose, -lead * 0.45);
    lean(pose, -0.03);
    crouch(pose, 0.02 + 0.006 * breathe);
    const [shoulder] = arm(camSide);
    a.set(-lead * 0.8, 0.14, 0.58).normalize().multiplyScalar((UPPER_ARM + FOREARM) * 0.97 * pop).add(pose[shoulder]);
    reach(pose, camSide, a, hint.set(0, -1, 0));
    const [hipShoulder] = arm(lead);
    b.set(pose[hipShoulder].x + lead * 0.07, pose[hipShoulder].y - 0.24, pose[hipShoulder].z + 0.02);
    reach(pose, lead, b, hint.set(lead, 0, -1));
    pose.head.x += -lead * 0.015;
    pose.head.y += 0.008;
  } else if (kind === 'flex') {
    // Double biceps to the camera: chest open, wide base, elbows out at shoulder height, fists up by the head.
    twist(pose, -lead * 0.7);
    crouch(pose, 0.035 + 0.006 * breathe);
    lean(pose, -0.015);
    lateral.copy(pose.lShoulder).sub(pose.rShoulder).setY(0).normalize();
    for (const s of [1, -1] as const) {
      const [shoulder] = arm(s);
      a.copy(pose[shoulder]).addScaledVector(lateral, s * 0.14 * pop).addScaledVector(UP, 0.17 * pop);
      reach(pose, s, a, hint.copy(lateral).multiplyScalar(s).addScaledVector(UP, -0.25));
    }
    pose.head.y -= 0.01; // chin tucked, glaring
    pose.head.z += 0.01;
  } else {
    // Fist to the sky: the near arm punched straight up, the other fist pulled to the hip, chin up.
    twist(pose, -lead * 0.4);
    lean(pose, -0.025);
    crouch(pose, 0.015 + 0.006 * breathe);
    const [shoulder] = arm(camSide);
    a.copy(pose[shoulder]).add(b.set(-lead * 0.04, (UPPER_ARM + FOREARM) * 0.96 * pop, 0.03));
    reach(pose, camSide, a, hint.set(-lead, 0, 1));
    const [hipShoulder] = arm(lead);
    b.set(pose[hipShoulder].x + lead * 0.06, pose[hipShoulder].y - 0.22, pose[hipShoulder].z + 0.05);
    reach(pose, lead, b, hint.set(lead, 0, -1));
    pose.head.y += 0.012;
    pose.head.z -= 0.012;
  }
  // A little hop off the slam.
  motion.lift += 0.025 * Math.max(0, 1 - u / 0.18) * Math.min(1, u / 0.05);
}

/** The VS face-off: back in the stance, guard up, leaning in at the other one. */
export function faceOffPose(pose: Pose, clock: number) {
  highGuard(pose, 0.55);
  lean(pose, 0.035 + 0.006 * Math.sin(clock * 2 * Math.PI * 1.6));
}
