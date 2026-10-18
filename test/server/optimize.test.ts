// forge/optimize.js on a small Mixamo-style skinned GLB: smaller, compressed, and the rig exactly as it was.
// Needs the forge's packages (cd forge && npm ci); skipped without them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const FORGE = path.resolve(__dirname, '../../forge');
const hasDeps = fs.existsSync(path.join(FORGE, 'node_modules/@gltf-transform/core'));
const forgeRequire = createRequire(path.join(FORGE, 'package.json'));
const load = (name: string) => import(forgeRequire.resolve(name));

/** Two bones (mixamorig:Hips -> mixamorig:Spine), a skinned quad strip, and a 512x512 PNG base color. */
async function skinnedGlb() {
  const { Document, NodeIO } = await load('@gltf-transform/core');
  const sharp = (await load('sharp')).default;
  const doc = new Document();
  const buffer = doc.createBuffer();
  const png = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#c86432' } }).png().toBuffer();
  const texture = doc.createTexture('base').setImage(new Uint8Array(png)).setMimeType('image/png');
  const material = doc.createMaterial('skin').setBaseColorTexture(texture);
  const rows = 8;
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], joints: number[] = [], weights: number[] = [], idx: number[] = [];
  for (let r = 0; r <= rows; r++) {
    for (const x of [-0.2, 0.2]) {
      const y = r / rows;
      pos.push(x, y, 0.01 * r);
      nrm.push(0, 0, 1);
      uv.push(x + 0.5, y);
      joints.push(0, 1, 0, 0);
      weights.push(1 - y, y, 0, 0);
    }
    if (r < rows) idx.push(2 * r, 2 * r + 1, 2 * r + 2, 2 * r + 1, 2 * r + 3, 2 * r + 2);
  }
  const acc = (type: string, array: ArrayLike<number> & { buffer: ArrayBuffer }) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array(pos)))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array(nrm)))
    .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(uv)))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint8Array(joints)))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array(weights)))
    .setIndices(acc('SCALAR', new Uint16Array(idx)))
    .setMaterial(material);
  const hips = doc.createNode('mixamorig:Hips').setTranslation([0, 0.5, 0]);
  const spine = doc.createNode('mixamorig:Spine').setTranslation([0, 0.3, 0]).setRotation([0, 0.3826834, 0, 0.9238795]);
  hips.addChild(spine);
  const ibm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.5, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.8, 0, 1]);
  const skin = doc.createSkin('Armature').addJoint(hips).addJoint(spine).setInverseBindMatrices(acc('MAT4', ibm));
  const body = doc.createNode('body').setMesh(doc.createMesh('body').addPrimitive(prim)).setSkin(skin);
  doc.createScene('Scene').addChild(doc.createNode('Armature').addChild(body).addChild(hips));
  return new NodeIO().writeBinary(doc) as Promise<Uint8Array>;
}

describe.skipIf(!hasDeps)('forge/optimize.js', () => {
  it('compresses a rigged GLB and keeps the skeleton, weights and names', async () => {
    const { optimizeGlb, FIGHTER } = await import(path.join(FORGE, 'optimize.js'));
    const { NodeIO } = await load('@gltf-transform/core');
    const { ALL_EXTENSIONS } = await load('@gltf-transform/extensions');
    const { MeshoptDecoder } = await load('meshoptimizer');
    await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

    const input = await skinnedGlb();
    const result = await optimizeGlb(input, { ...FIGHTER, textures: { default: { size: 256, quality: 85 } } });
    expect(result.bytesAfter).toBeLessThan(input.byteLength);
    expect(result.after[0]).toMatchObject({ mime: 'image/webp', width: 256, height: 256 });

    const [a, b] = [await io.readBinary(input), await io.readBinary(new Uint8Array(result.glb))];
    expect(b.getRoot().listExtensionsRequired().map((e: { extensionName: string }) => e.extensionName).sort()).toEqual(['EXT_meshopt_compression', 'EXT_texture_webp']);
    const names = (d: typeof a) => d.getRoot().listNodes().map((n: { getName(): string }) => n.getName()).sort();
    expect(names(b)).toEqual(names(a));
    const skinOf = (d: typeof a) => d.getRoot().listSkins()[0];
    expect(skinOf(b).listJoints().map((j: { getName(): string }) => j.getName())).toEqual(['mixamorig:Hips', 'mixamorig:Spine']);
    // Positions aren't quantized, so the inverse bind matrices (and the mesh's units) are untouched.
    expect(Array.from(skinOf(b).getInverseBindMatrices().getArray())).toEqual(Array.from(ibm(a)));
    const spine = (d: typeof a) => d.getRoot().listNodes().find((n: { getName(): string }) => n.getName() === 'mixamorig:Spine');
    expect(spine(b).getRotation()).toEqual(spine(a).getRotation());

    // Decoded vertices match: positions exactly, each joint's weight to 8 bits, UVs to 14 bits.
    const vertices = (d: typeof a) => {
      const p = d.getRoot().listMeshes()[0].listPrimitives()[0];
      const out = new Map<string, { weights: number[]; uv: number[] }>();
      for (let i = 0; i < p.getAttribute('POSITION').getCount(); i++) {
        const w = p.getAttribute('WEIGHTS_0').getElement(i, []);
        const j = p.getAttribute('JOINTS_0').getElement(i, []);
        // Influences can come back reordered (heaviest first): collect them by joint.
        const weights = [0, 0];
        for (let k = 0; k < 4; k++) if (w[k] > 0) weights[j[k]] += w[k];
        out.set(p.getAttribute('POSITION').getElement(i, []).join(), { weights, uv: p.getAttribute('TEXCOORD_0').getElement(i, []) });
      }
      return out;
    };
    const [va, vb] = [vertices(a), vertices(b)];
    expect([...vb.keys()].sort()).toEqual([...va.keys()].sort());
    for (const [key, v] of va) {
      v.weights.forEach((w, k) => expect(Math.abs(vb.get(key)!.weights[k] - w)).toBeLessThan(1 / 255));
      v.uv.forEach((u, k) => expect(Math.abs(vb.get(key)!.uv[k] - u)).toBeLessThan(1 / 16000));
    }
    expect(await optimizeGlb(new Uint8Array(result.glb))).toBeNull(); // already done: left alone
  });

  it('optimizes a fighter folder in place, keeping the original as a backup', async () => {
    const { optimizeFighter } = await import(path.join(FORGE, 'optimize.js'));
    const sharp = (await load('sharp')).default;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimize-test-'));
    const glb = await skinnedGlb();
    fs.writeFileSync(path.join(dir, 'rigged.glb'), glb);
    fs.writeFileSync(path.join(dir, 'card.png'), await sharp({ create: { width: 1024, height: 1536, channels: 3, background: '#333' } }).png().toBuffer());
    const report = await optimizeFighter(dir, { glbUrl: '/api/forge/x/rigged.glb' });
    expect(report.glb.after).toBeLessThan(report.glb.before);
    expect(fs.readFileSync(path.join(dir, 'rigged.orig.glb')).equals(Buffer.from(glb))).toBe(true);
    expect(fs.statSync(path.join(dir, 'rigged.glb')).size).toBe(report.glb.after);
    expect(fs.existsSync(path.join(dir, 'card.webp'))).toBe(true);
    // A second run skips it; a broken GLB is left alone without throwing.
    expect((await optimizeFighter(dir, { glbUrl: '/api/forge/x/rigged.glb' })).glb).toBeNull();
    fs.writeFileSync(path.join(dir, 'model.glb'), 'glTF');
    expect((await optimizeFighter(dir, { glbUrl: '/api/forge/x/model.glb' }, { log: () => {} })).glb).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'model.glb'), 'utf8')).toBe('glTF');
    fs.rmSync(dir, { recursive: true });
  });
});

function ibm(doc: { getRoot(): { listSkins(): { getInverseBindMatrices(): { getArray(): ArrayLike<number> } }[] } }) {
  return doc.getRoot().listSkins()[0].getInverseBindMatrices().getArray();
}
