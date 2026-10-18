// forge/rigcheck.js: the forge's rig QA. It ports SkeletonPose and three.js skinning to plain Node, so the first test
// holds the port to the real thing: the game's SkeletonPose on a three.js scene built the way FighterView builds it.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { SkeletonPose } from '../../src/director/skeletonPose';
import type { Pose } from '../../src/director/pose';
// @ts-expect-error plain JS module
import { checkRig, POSES, BONES } from '../../forge/rigcheck.js';
// @ts-expect-error plain JS module
import { makeRigGlb } from '../server/fixtures/rigFixtures.mjs';

type Report = {
  ok: boolean;
  score: number;
  problems: { level: string; code: string; message: string }[];
  stats: Record<string, unknown> & { ms: number };
  debug?: {
    rest: { vertices: Float64Array };
    posed: Record<string, { vertices: Float64Array; joints: Record<string, number[]> }>;
  };
};
const check = (glb: Uint8Array, keep = false): Promise<Report> => checkRig(glb, { keep });
const codes = (r: Report) => r.problems.filter((p) => p.level === 'fail').map((p) => p.code);

async function loadThree(glb: Uint8Array) {
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  // FighterView: body (the space) > modelHolder > model, the model turned to face +z.
  const body = new THREE.Group();
  const holder = new THREE.Group();
  const model = gltf.scene;
  model.rotation.y = -Math.PI / 2;
  body.add(holder);
  holder.add(model);
  body.updateMatrixWorld(true);
  return { body, holder, model };
}

describe('rigcheck', () => {
  it('poses and skins exactly like the game (SkeletonPose + three.js skinning)', async () => {
    const glb = await makeRigGlb('good');
    const report = await check(glb, true);
    const { body, holder, model } = await loadThree(glb);
    const skeleton = SkeletonPose.from(model, body)!;
    expect(skeleton).not.toBeNull();
    const mesh = model.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
    let compared = 0;
    let moved = 0;
    for (const [name, raw] of Object.entries(POSES as Record<string, Record<string, number[]>>)) {
      const pose = Object.fromEntries(Object.entries(raw).map(([j, v]) => [j, new THREE.Vector3(...v)])) as Pose;
      holder.position.set(0, 0, 0);
      skeleton.apply(pose);
      const hipY = (pose.lHip.y + pose.rHip.y) / 2;
      holder.position.y = (hipY - 0.5) * (skeleton.hipHeight / 0.5);
      body.updateMatrixWorld(true);
      const ours = report.debug!.posed[name];
      for (const b of BONES as string[]) {
        const bone = model.getObjectByName(`mixamorig${b}`) ?? model.getObjectByName(`mixamorig:${b}`);
        const p = bone!.getWorldPosition(new THREE.Vector3());
        expect(p.distanceTo(new THREE.Vector3(...ours.joints[b])), `${name} ${b}`).toBeLessThan(1e-4);
      }
      const v = new THREE.Vector3();
      const count = mesh.geometry.attributes.position.count;
      for (let i = 0; i < count; i += 11) {
        mesh.applyBoneTransform(i, v.fromBufferAttribute(mesh.geometry.attributes.position, i));
        mesh.localToWorld(v);
        expect(v.distanceTo(new THREE.Vector3(...ours.vertices.subarray(i * 3, i * 3 + 3))), `${name} vertex ${i}`).toBeLessThan(1e-4);
        compared++;
        if (name !== 'guard' && v.distanceTo(new THREE.Vector3(...report.debug!.rest.vertices.subarray(i * 3, i * 3 + 3))) > 0.05) moved++;
      }
    }
    expect(compared).toBeGreaterThan(400);
    expect(moved).toBeGreaterThan(100); // the poses really bend the figure
  });

  it('passes a good rig', async () => {
    const r = await check(await makeRigGlb('good'));
    expect(r.problems.filter((p) => p.level === 'fail')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThan(70);
  });

  it('fails weights collapsed onto one spine bone (the broken dylan rig), every way', async () => {
    const r = await check(await makeRigGlb('collapsed'));
    expect(r.ok).toBe(false);
    expect(r.score).toBeLessThan(10);
    expect(codes(r)).toEqual(expect.arrayContaining(['one-bone', 'weights-off-limb', 'hand-off-wrist', 'parts-dont-follow', 'detached']));
  });

  it('fails a rig with just one arm left on the chest', async () => {
    const r = await check(await makeRigGlb('arm-on-spine'));
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(expect.arrayContaining(['weights-off-limb', 'hand-off-wrist', 'parts-dont-follow']));
    const messages = r.problems.map((p) => p.message).join(' ');
    expect(messages).toMatch(/LeftForeArm/);
    expect(messages).not.toMatch(/RightForeArm/);
  });

  it('fails what is not a rig at all', async () => {
    expect(codes(await check(new TextEncoder().encode('glTF-local-rigged')))).toEqual(['unreadable']);
  });

  it('is fast enough to run inside every forge', async () => {
    const r = await check(await makeRigGlb('good'));
    expect(r.stats.ms).toBeLessThan(2000);
  });
});
