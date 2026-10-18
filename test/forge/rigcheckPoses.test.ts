// The poses forge/rigcheck.js bends every forged fighter into come from the game's own director (fightPose.ts,
// ragdoll.ts), baked into forge/rigcheck-poses.json so the forge server (plain Node, no Three.js) can read them.
// This test fails when the director's poses drift from the baked ones; RIGCHECK_POSES=write rewrites the file.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { expect, test } from 'vitest';
import { applyAction, stance, type ActionInput, type Motion } from '../../src/director/fightPose';
import { GUARD_POSE, JOINTS, copyPose, createPose, type Pose } from '../../src/director/pose';
import { Ragdoll } from '../../src/director/ragdoll';
import type { FighterState } from '../../src/types';

const FILE = path.resolve(__dirname, '../../forge/rigcheck-poses.json');

const idle: FighterState = { x: 0, hp: 100, stamina: 100, phase: 'idle', frame: 0 };
const input = (state: Partial<FighterState>, extra: Partial<ActionInput> = {}): ActionInput => ({
  state: { ...idle, ...state },
  reach: 0.55,
  hit: null,
  won: 0,
  duck: 0,
  slip: 0,
  tell: 0,
  tellHand: 'R',
  intro: 0,
  hurt: 0,
  lead: 1,
  clock: 0,
  ...extra,
});

/** P1's stance (left side leads), then the engine's action on top, the way FighterView.update builds a frame. */
function action(state: Partial<FighterState>, extra: Partial<ActionInput> = {}): Pose {
  const pose = stance(createPose(), 0, 0, 0, 0, 1);
  const motion: Motion = { lunge: 0, tilt: 0, lift: 0 };
  return applyAction(pose, input(state, extra), motion);
}

/** A K.O.'d ragdoll after it settles, relative to its torso (what FighterView hands SkeletonPose). */
function ko(): Pose {
  const r = new Ragdoll();
  r.start(stance(createPose(), 0, 0, 0, 0, 1), new THREE.Matrix4(), { move: 'hook', hand: 'R', strength: 1.2 });
  for (let f = 0; f < 180; f++) r.step(1 / 60);
  const out = createPose();
  r.write(out, new THREE.Object3D());
  return out;
}

function poses(): Record<string, Pose> {
  return {
    guard: stance(createPose(), 0, 0, 0, 0, 1),
    // A straight right at full extension (the active frames).
    cross: action({ phase: 'active', move: 'cross', hand: 'R', height: 'head', frame: 1, length: 3 }),
    // A left hook at full extension: the elbow up and out, the torso turned through.
    hook: action({ phase: 'active', move: 'hook', hand: 'L', height: 'head', frame: 1, length: 3 }),
    // A left knee at the top: thigh up, the shin folded under it.
    knee: action({ phase: 'active', move: 'knee', hand: 'L', height: 'body', frame: 1, length: 3 }),
    // A right kick at full extension: the biggest stretch at the hip.
    kick: action({ phase: 'active', move: 'kick', hand: 'R', height: 'body', frame: 1, length: 3 }),
    // Rocked by a right hook: the head snapped to the side, the torso turned, arms loose.
    rocked: action(
      { phase: 'hitstun', frame: 1, length: 8 },
      { hit: { move: 'hook', hand: 'R', height: 'head', strength: 1.4 } },
    ),
    // Winning: the rear (right) fist straight up at the sky.
    victory: action({}, { won: 2 }),
    ko: ko(),
  };
}

const round = (p: Pose) => Object.fromEntries(JOINTS.map((j) => [j, p[j].toArray().map((v) => Math.round(v * 1e4) / 1e4)]));

test('the baked rig-check poses are the director poses', () => {
  const baked = Object.fromEntries(Object.entries(poses()).map(([k, p]) => [k, round(p)]));
  const text = JSON.stringify(baked, null, 0).replace(/\],"/g, '],\n"') + '\n';
  if (process.env.RIGCHECK_POSES === 'write') fs.writeFileSync(FILE, text);
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const [name, pose] of Object.entries(baked)) {
    for (const j of JOINTS) {
      for (let i = 0; i < 3; i++) expect(onDisk[name][j][i], `${name}.${j}`).toBeCloseTo(pose[j][i], 3);
    }
  }
});

test('the poses are big enough to show a bad rig', () => {
  const p = poses();
  const moved = (name: string, j: (typeof JOINTS)[number]) => p[name][j].distanceTo(GUARD_POSE[j]);
  expect(moved('cross', 'rWrist')).toBeGreaterThan(0.15);
  expect(moved('hook', 'lElbow')).toBeGreaterThan(0.08);
  expect(moved('knee', 'lKnee')).toBeGreaterThan(0.1);
  expect(moved('victory', 'rWrist')).toBeGreaterThan(0.3);
  expect(copyPose(createPose(), p.ko).head.y).toBeGreaterThan(0.6); // relative to the torso: still upright in its own frame
});
