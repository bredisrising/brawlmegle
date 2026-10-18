import { Vector3 } from 'three';
import { GUARD_POSE, copyPose, type Pose } from './pose';
import { crouch, lean, solve, twist } from './fightPose';
import { clamp01, smoothstep, type Signature } from './walkoutTiming';

/**
 * The walkout's body language, on the joint pose (fighter space: +z the way the fighter faces, +x their left, feet at
 * y = 0, ~1 m tall). During the walkout the fighters face the camera (the director turns them), so these are built
 * square to the front from a relaxed stand, not on the bladed fight stance: walking up to the mark, waiting with arms
 * folded, and one signature action each. `inner` is the hand on the opponent's side (1 = left, P1; -1 = right, P2).
 */
const UPPER_ARM = GUARD_POSE.lShoulder.distanceTo(GUARD_POSE.lElbow);
const FOREARM = GUARD_POSE.lElbow.distanceTo(GUARD_POSE.lWrist);
const ARM = UPPER_ARM + FOREARM;
const a = new Vector3();
const b = new Vector3();
const hint = new Vector3();
const lateral = new Vector3();

type Side = 1 | -1;
const arm = (s: Side) => (s === 1 ? (['lShoulder', 'lElbow', 'lWrist'] as const) : (['rShoulder', 'rElbow', 'rWrist'] as const));
const shoulder = (p: Pose, s: Side) => p[arm(s)[0]];

/** Put a hand at `target` (fighter space); the elbow bends toward `pole`. */
function reach(p: Pose, s: Side, target: Vector3, pole: Vector3) {
  const [sh, el, wr] = arm(s);
  solve(p[sh], target, UPPER_ARM, FOREARM, pole, p[el], p[wr]);
}

/** Put a hand at an offset from its own shoulder. */
function reachFrom(p: Pose, s: Side, dx: number, dy: number, dz: number, pole: Vector3) {
  reach(p, s, a.copy(shoulder(p, s)).add(b.set(dx, dy, dz)), pole);
}

/** 0 -> 1 -> 0 over [start, start + len]: a quick strike out and back. */
function strike(t: number, start: number, out = 0.08, hold = 0.06, back = 0.16) {
  const u = t - start;
  if (u < 0 || u > out + hold + back) return 0;
  if (u < out) return smoothstep(u / out);
  if (u < out + hold) return 1;
  return 1 - smoothstep((u - out - hold) / back);
}

/** 0 before `start`, easing to 1 over `len`. */
const ramp = (t: number, start: number, len: number) => smoothstep((t - start) / len);
/** 1 inside [from, to] (eased in and out over `edge`), else 0. */
const span = (t: number, from: number, to: number, edge = 0.25) => Math.min(ramp(t, from, edge), 1 - ramp(t, to - edge, edge));

/** A relaxed stand, square to the front: feet apart, arms hanging, breathing. */
export function stand(p: Pose, clock: number) {
  copyPose(p, GUARD_POSE);
  p.lAnkle.set(0.09, 0.03, 0.01);
  p.rAnkle.set(-0.09, 0.03, -0.01);
  crouch(p, 0.012);
  const breathe = Math.sin(clock * 2 * Math.PI * 0.32);
  for (const j of ['neck', 'head', 'lShoulder', 'rShoulder'] as const) p[j].y += 0.004 * breathe;
  for (const s of [1, -1] as const) reachFrom(p, s, s * 0.05, -0.27, 0.03, hint.set(s, 0, -1));
}

/** Walking forward (to the mark): `phase` in radians of the stride, `amount` 0..1 (0 = standing). */
export function walk(p: Pose, phase: number, amount: number) {
  if (amount <= 0) return;
  const s = Math.sin(phase);
  const lift = (v: number) => 0.045 * Math.max(0, v) * amount;
  p.lAnkle.z += 0.1 * s * amount;
  p.rAnkle.z -= 0.1 * s * amount;
  p.lAnkle.y += lift(Math.cos(phase));
  p.rAnkle.y += lift(-Math.cos(phase));
  crouch(p, 0.012 * amount * (1 - Math.cos(2 * phase)) * 0.5);
  twist(p, 0.08 * s * amount);
  // Arms swing against the legs.
  for (const sd of [1, -1] as const) reachFrom(p, sd, sd * 0.05, -0.26, 0.03 - 0.09 * s * sd * amount, hint.set(sd, 0, -1));
}

/** Waiting their turn: arms folded high across the chest, weight on one hip, chin up. */
export function folded(p: Pose, clock: number, inner: Side) {
  const sway = Math.sin(clock * 2 * Math.PI * 0.25);
  // Each hand tucks under the opposite upper arm; the elbows stick out a little in front.
  reach(p, 1, a.set(-0.075, 0.665 + 0.003 * sway, 0.1), hint.set(1, -0.4, 0.9));
  reach(p, -1, a.set(0.075, 0.69 + 0.003 * sway, 0.115), hint.set(-1, -0.4, 0.9));
  p.head.y += 0.008;
  p.head.z -= 0.01;
  p.head.x += inner * 0.01; // looking a touch toward the other one
  p.lHip.y += 0.006 * inner;
  p.rHip.y -= 0.006 * inner;
}

/**
 * A fighter's signature action, `t` seconds in (about 2.4 s; it holds the last position after). Big, clear shapes:
 * they're read from a medium shot on a forged model, so every move is a whole-arm move.
 */
export function signature(p: Pose, kind: Signature, t: number, inner: Side) {
  const outer = -inner as Side;
  switch (kind) {
    case 'shadowbox': {
      // Guard up, bouncing; then a combo thrown down the lens: jab, jab, cross, hook, cross.
      const g = ramp(t, 0, 0.3);
      crouch(p, (0.03 + 0.012 * Math.sin(t * 2 * Math.PI * 2.2)) * g);
      const throws: [Side, number, 'straight' | 'hook'][] = [
        [inner, 0.4, 'straight'], [inner, 0.66, 'straight'], [outer, 0.98, 'straight'], [inner, 1.45, 'hook'], [outer, 1.85, 'straight'],
      ];
      let turn = 0;
      for (const s of [1, -1] as const) {
        let out = 0;
        let hook = false;
        for (const [hand, at, style] of throws) {
          if (hand !== s) continue;
          const k = strike(t, at);
          if (k > out) {
            out = k;
            hook = style === 'hook';
          }
        }
        turn += -s * 0.32 * out;
        const guard = a.set(s * 0.06, 0.82, 0.15).lerp(b.copy(shoulder(p, s)).add(hint.set(s * 0.03, -0.27, 0.03)), 1 - g);
        if (hook) {
          b.copy(shoulder(p, s)).add(lateral.set(-s * 0.2, 0.02, 0.22));
          reach(p, s, guard.lerp(b, out), hint.set(s, 0.6, -0.2));
        } else {
          b.copy(shoulder(p, s)).add(lateral.set(-s * 0.02, 0.03, ARM * 0.95));
          reach(p, s, guard.lerp(b, out), hint.set(s, -1, 0));
        }
      }
      twist(p, turn);
      p.head.y -= 0.012 * g;
      p.head.z += 0.012 * g;
      return;
    }
    case 'knuckles': {
      // Hands meet in front, push out to crack the knuckles, then the fist pounds the palm twice; hands down, glare.
      const meet = span(t, 0.05, 2.05, 0.3);
      const push = span(t, 0.45, 0.85, 0.15);
      const crack = Math.sin(clamp01((t - 0.6) / 0.25) * Math.PI) * 0.01;
      const palm = a.set(inner * 0.025, 0.66, 0.21 + 0.1 * push);
      reach(p, inner, b.copy(shoulder(p, inner)).add(lateral.set(0, -0.27, 0.03)).lerp(palm, meet), hint.set(inner, -1, -0.3));
      // The pounding fist: up, then down onto the palm at 1.25 and 1.65 s.
      const lift = span(t, 1.0, 1.9, 0.12);
      const pound = 1 - Math.max(strike(t, 1.13, 0.07, 0.04, 0.12), strike(t, 1.53, 0.07, 0.04, 0.12));
      const fist = lateral.set(-inner * 0.03, 0.69 + 0.1 * lift * pound, 0.23 + 0.1 * push);
      reach(p, outer, b.copy(shoulder(p, outer)).add(hint.set(0, -0.27, 0.03)).lerp(fist, meet), hint.set(outer, -1, -0.3));
      lean(p, 0.025 * push + 0.015 * meet);
      p.head.x += crack;
      p.head.y -= 0.012 * ramp(t, 2.0, 0.3);
      return;
    }
    case 'neckroll': {
      // A slow circle of the head, a shrug that rolls the shoulders, then the fists clench and the chin drops.
      const roll = clamp01((t - 0.15) / 1.25);
      const ang = roll * Math.PI * 2;
      const on = Math.sin(roll * Math.PI);
      p.head.x += 0.04 * Math.sin(ang) * on;
      p.head.z += 0.025 * Math.cos(ang) * on - 0.01 * on;
      p.head.y -= 0.012 * on;
      p.neck.x += 0.015 * Math.sin(ang) * on;
      const shrug = Math.sin(clamp01((t - 1.4) / 0.5) * Math.PI);
      for (const j of ['lShoulder', 'rShoulder'] as const) {
        p[j].y += 0.035 * shrug;
        p[j].z -= 0.015 * shrug;
      }
      const clench = ramp(t, 1.95, 0.25);
      for (const s of [1, -1] as const) reachFrom(p, s, s * (0.05 + 0.06 * clench), -0.27 + 0.03 * clench, 0.03 + 0.04 * clench, hint.set(s, 0, -1));
      lean(p, 0.025 * clench);
      p.head.y -= 0.012 * clench;
      p.head.z += 0.01 * clench;
      return;
    }
    case 'beckon': {
      // Off hand on the hip, chin up; the near hand reaches out at the other one and waves them in: "come on".
      reach(p, outer, a.copy(shoulder(p, outer)).add(b.set(outer * 0.07, -0.25, -0.03)).lerp(lateral.copy(shoulder(p, outer)).add(hint.set(outer * 0.03, -0.27, 0.03)), 1 - ramp(t, 0, 0.3)), hint.set(outer, 0.2, -1));
      const out = span(t, 0.15, 2.3, 0.35);
      const flick = Math.max(strike(t, 0.85, 0.1, 0.03, 0.18), strike(t, 1.25, 0.1, 0.03, 0.18), strike(t, 1.65, 0.1, 0.03, 0.18));
      const extended = a.copy(shoulder(p, inner)).add(b.set(inner * 0.16, -0.02, 0.26));
      const curled = lateral.copy(shoulder(p, inner)).add(b.set(inner * 0.11, 0.06, 0.15));
      extended.lerp(curled, flick);
      reach(p, inner, b.copy(shoulder(p, inner)).add(hint.set(inner * 0.05, -0.27, 0.03)).lerp(extended, out), hint.set(inner, -1, -0.2));
      twist(p, inner * 0.18 * out);
      lean(p, -0.025 * out);
      p.head.y += 0.008 * out;
      p.head.z -= 0.012 * out;
      p.head.x += inner * 0.012 * out;
      return;
    }
    case 'chestpound': {
      // Right, right, left on the chest, then both arms flung up and out: a roar.
      const roar = ramp(t, 1.65, 0.3);
      for (const s of [1, -1] as const) {
        const hits = s === outer ? [0.55, 0.95] : [1.3];
        const raised = s === outer ? span(t, 0.2, 1.2, 0.2) : span(t, 0.95, 1.55, 0.2);
        let hit = 0;
        for (const at of hits) hit = Math.max(hit, strike(t, at, 0.07, 0.05, 0.15));
        const down = a.copy(shoulder(p, s)).add(b.set(s * 0.05, -0.27, 0.03));
        const cocked = lateral.set(s * 0.04, 0.75, 0.24);
        const chest = b.set(s * 0.045, 0.71, 0.1);
        const fist = down.lerp(cocked.lerp(chest, hit), raised);
        const up = hint.copy(shoulder(p, s)).add(b.set(s * 0.3, 0.17, 0.04));
        reach(p, s, fist.lerp(up, roar), b.set(s, -0.4 + 0.6 * roar, -0.5));
      }
      lean(p, 0.02 * span(t, 0.4, 1.5, 0.2) - 0.04 * roar);
      crouch(p, 0.025 * roar);
      p.head.y += 0.012 * roar;
      p.head.z -= 0.025 * roar;
      return;
    }
    case 'gloves': {
      // Tug the near glove tight (the other hand on its wrist), then knock the fists together twice.
      const tug = span(t, 0.1, 1.45, 0.25);
      const yank = Math.max(strike(t, 0.55, 0.08, 0.04, 0.16), strike(t, 0.9, 0.08, 0.04, 0.16));
      const knock = ramp(t, 1.45, 0.2);
      const tap = Math.max(strike(t, 1.75, 0.07, 0.03, 0.12), strike(t, 2.05, 0.07, 0.03, 0.12));
      for (const s of [1, -1] as const) {
        const down = a.copy(shoulder(p, s)).add(b.set(s * 0.05, -0.27, 0.03));
        // Tugging: the near hand held out at the chest, the far hand on its wrist pulling the cuff.
        const held = s === inner ? lateral.set(inner * 0.06, 0.66, 0.24 + 0.03 * yank) : lateral.set(inner * 0.0, 0.67, 0.2 - 0.04 * yank);
        const knocking = hint.set(s * (0.035 + 0.035 * (1 - tap)), 0.73, 0.2);
        const target = down.lerp(held, tug).lerp(knocking, knock);
        reach(p, s, target, b.set(s, -1, -0.3));
      }
      lean(p, 0.015 * Math.max(tug, knock));
      p.head.y -= 0.012 * tug;
      p.head.z += 0.015 * tug;
      return;
    }
    case 'flex': {
      // Arms come up into a double biceps and pulse; then down into a "most muscular", chin down.
      const up = span(t, 0.25, 1.75, 0.35);
      const crab = ramp(t, 1.75, 0.3);
      const pulse = Math.sin(clamp01((t - 0.8) / 0.9) * Math.PI * 3) ** 2 * up;
      lateral.copy(p.lShoulder).sub(p.rShoulder).setY(0).normalize();
      for (const s of [1, -1] as const) {
        const down = a.copy(shoulder(p, s)).add(b.set(s * 0.05, -0.27, 0.03));
        const biceps = b.copy(shoulder(p, s)).addScaledVector(lateral, s * (0.14 + 0.01 * pulse)).add(hint.set(0, 0.16 + 0.01 * pulse, 0.02));
        const target = down.lerp(biceps, up).lerp(hint.set(s * 0.045, 0.5, 0.15), crab);
        reach(p, s, target, b.copy(lateral).multiplyScalar(s).add(hint.set(0, crab > 0.5 ? 0.3 : -0.25, crab * 0.3)));
      }
      crouch(p, 0.02 * up + 0.04 * crab + 0.006 * pulse);
      lean(p, 0.045 * crab - 0.015 * up);
      p.head.y -= 0.015 * crab;
      p.head.z += 0.015 * crab;
      return;
    }
  }
}
