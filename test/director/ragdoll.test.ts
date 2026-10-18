import * as THREE from 'three';
import { expect, test } from 'vitest';
import { GUARD_POSE, JOINTS, copyPose, createPose } from '../../src/director/pose';
import { Ragdoll, type KoBlow } from '../../src/director/ragdoll';

/** Run a K.O. fall for `seconds` at a frame rate; returns the root-space joints and the body group. */
function fall(blow: KoBlow | null, seconds = 3, fps = 60) {
  const r = new Ragdoll();
  r.start(copyPose(createPose(), GUARD_POSE), new THREE.Matrix4(), blow);
  let landedAt = -1;
  for (let f = 0; f < Math.round(seconds * fps); f++) if (r.step(1 / fps) && landedAt < 0) landedAt = f / fps;
  const body = new THREE.Object3D();
  const local = createPose();
  r.write(local, body);
  const world = Object.fromEntries(JOINTS.map((j) => [j, r.joint(j, new THREE.Vector3())]));
  return { r, world, local, body, landedAt };
}

test('a K.O. ends flat on the floor, thrown back off the blow, and lands once', () => {
  const { world, landedAt } = fall({ move: 'cross', strength: 1 });
  expect(landedAt).toBeGreaterThan(0.15);
  expect(landedAt).toBeLessThan(1.2);
  for (const j of ['head', 'neck', 'lShoulder', 'rShoulder', 'lHip', 'rHip'] as const) expect(world[j].y).toBeLessThan(0.12);
  const hipZ = (world.lHip.z + world.rHip.z) / 2;
  expect(hipZ).toBeLessThan(-0.1); // away from the opponent (+z)
  expect(world.head.z).toBeLessThan(hipZ); // fell onto its back, head away from the opponent
});

test('the skeleton holds together (bone lengths kept) and nothing goes through the floor', () => {
  const { world } = fall({ move: 'uppercut', strength: 1.4 }, 4);
  const len = (a: keyof typeof world, b: keyof typeof world) => world[a].distanceTo(world[b]);
  const rest = (a: keyof typeof world, b: keyof typeof world) => GUARD_POSE[a as 'head'].distanceTo(GUARD_POSE[b as 'head']);
  for (const [a, b] of [['lShoulder', 'lElbow'], ['lElbow', 'lWrist'], ['rHip', 'rKnee'], ['rKnee', 'rAnkle'], ['neck', 'head'], ['lShoulder', 'rHip']] as const) {
    expect(Math.abs(len(a, b) - rest(a, b))).toBeLessThan(0.02);
  }
  for (const j of JOINTS) expect(world[j].y).toBeGreaterThan(0.02);
});

test('the same blow falls the same way at any frame rate (both laptops, the slow-motion replay)', () => {
  const a = fall({ move: 'hook', hand: 'L', strength: 1 }, 2, 60);
  const b = fall({ move: 'hook', hand: 'L', strength: 1 }, 2, 144);
  for (const j of JOINTS) expect(a.world[j].distanceTo(b.world[j])).toBeLessThan(0.03);
});

test('a hook throws the head sideways; the torso pose written back stays upright in its own frame', () => {
  const left = fall({ move: 'hook', hand: 'L', strength: 1.2 }, 0.25);
  const right = fall({ move: 'hook', hand: 'R', strength: 1.2 }, 0.25);
  expect(left.world.head.x).toBeGreaterThan(right.world.head.x + 0.05);
  const { local } = fall({ move: 'cross', strength: 1 });
  expect((local.lHip.y + local.rHip.y) / 2).toBeCloseTo(GUARD_POSE.lHip.y, 3);
  expect((local.lShoulder.y + local.rShoulder.y) / 2).toBeGreaterThan(0.7);
});

