// Tiny synthetic forged fighters for the rig checker and the forge's rig gate: a 1 m tube figure in an A-pose,
// facing +x like every forged GLB, with the 22 Mixamo bones (each turned to an odd orientation, so the posing math
// can't get away with assuming identity bone axes) and skin weights that are good or broken on purpose.
//
//   makeRigGlb("good" | "collapsed" | "arm-on-spine")  -> GLB bytes (uncompressed)
//   node test/server/fixtures/rigFixtures.mjs            -> rewrites rig-good.glb and rig-collapsed.glb (meshopt, like
//                                                           the forge's optimized output)
import fs from "node:fs";
import { Document, NodeIO } from "@gltf-transform/core";

/** Joints in fighter space (+x the fighter's left, +z forward, y up), meters. */
const J = {
  Hips: [0, 0.5, 0],
  Spine: [0, 0.56, 0],
  Spine1: [0, 0.63, 0],
  Spine2: [0, 0.7, 0],
  Neck: [0, 0.8, 0],
  Head: [0, 0.86, 0],
};
for (const [side, s] of [["Left", 1], ["Right", -1]]) {
  Object.assign(J, {
    [`${side}Shoulder`]: [s * 0.03, 0.77, 0],
    [`${side}Arm`]: [s * 0.12, 0.77, 0],
    [`${side}ForeArm`]: [s * 0.2, 0.64, 0],
    [`${side}Hand`]: [s * 0.27, 0.52, 0],
    [`${side}UpLeg`]: [s * 0.07, 0.48, 0],
    [`${side}Leg`]: [s * 0.075, 0.27, 0.01],
    [`${side}Foot`]: [s * 0.075, 0.06, 0],
    [`${side}ToeBase`]: [s * 0.075, 0.03, 0.08],
  });
}
const PARENT = {
  Spine: "Hips", Spine1: "Spine", Spine2: "Spine1", Neck: "Spine2", Head: "Neck",
  LeftShoulder: "Spine2", LeftArm: "LeftShoulder", LeftForeArm: "LeftArm", LeftHand: "LeftForeArm",
  RightShoulder: "Spine2", RightArm: "RightShoulder", RightForeArm: "RightArm", RightHand: "RightForeArm",
  LeftUpLeg: "Hips", LeftLeg: "LeftUpLeg", LeftFoot: "LeftLeg", LeftToeBase: "LeftFoot",
  RightUpLeg: "Hips", RightLeg: "RightUpLeg", RightFoot: "RightLeg", RightToeBase: "RightFoot",
};
const BONES = Object.keys(J);

/** Fighter space -> the model's own (facing +x): the inverse of the game's -90 degree turn. */
const toModel = ([x, y, z]) => [z, y, -x];

// Quaternion helpers (x, y, z, w).
const qAxis = (axis, angle) => {
  const l = Math.hypot(...axis);
  const s = Math.sin(angle / 2) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
const qMul = (a, b) => [
  a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1],
  a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
  a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qInv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qRot = (q, v) => {
  const p = qMul(qMul(q, [v[0], v[1], v[2], 0]), qInv(q));
  return [p[0], p[1], p[2]];
};
/** Column-major inverse of a rigid transform (rotation q, translation t). */
const inverseRigid = (q, t) => {
  const qi = qInv(q);
  const ti = qRot(qi, t).map((v) => -v);
  const c = [qRot(qi, [1, 0, 0]), qRot(qi, [0, 1, 0]), qRot(qi, [0, 0, 1])];
  return [...c[0], 0, ...c[1], 0, ...c[2], 0, ...ti, 1];
};

/** A tube of `rings` x `sides` vertices around a-b; `weight(t)` gives each ring its [bone, weight] pairs. */
function tube(out, a, b, radius, rings, weight, sides = 10) {
  const axis = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...axis);
  const d = axis.map((v) => v / len);
  const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]];
  const ul = Math.hypot(...u);
  u = u.map((v) => v / ul);
  const w = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const base = out.positions.length / 3;
  for (let r = 0; r < rings; r++) {
    const t = r / (rings - 1);
    const c = a.map((v, i) => v + axis[i] * t);
    const pairs = weight(t);
    for (let s = 0; s < sides; s++) {
      const ang = (s / sides) * Math.PI * 2;
      out.positions.push(...[0, 1, 2].map((i) => c[i] + radius * (Math.cos(ang) * u[i] + Math.sin(ang) * w[i])));
      out.weights.push(pairs);
    }
  }
  for (let r = 0; r + 1 < rings; r++) {
    for (let s = 0; s < sides; s++) {
      const i0 = base + r * sides + s, i1 = base + r * sides + ((s + 1) % sides);
      const j0 = i0 + sides, j1 = i1 + sides;
      out.indices.push(i0, j0, i1, i1, j0, j1);
    }
  }
}

/** Blend into the parent bone over the first 20% of a segment, like any smooth rig. */
const blended = (bone, parent) => (t) => (t < 0.2 && parent ? [[parent, 0.5 * (1 - t / 0.2)], [bone, 0.5 + 0.5 * (t / 0.2)]] : [[bone, 1]]);

function figure() {
  const out = { positions: [], weights: [], indices: [] };
  const P = (b) => J[b];
  const ext = (a, b, k) => P(b).map((v, i) => v + (P(b)[i] - P(a)[i]) * k);
  // Torso: hips to neck, weighted up the spine.
  tube(out, [0, 0.44, 0], P("Neck"), 0.1, 14, (t) => {
    const y = 0.44 + t * (0.8 - 0.44);
    const chain = ["Hips", "Spine", "Spine1", "Spine2"];
    const at = [0.5, 0.56, 0.63, 0.7];
    let k = at.findLastIndex((v) => v <= y);
    if (k < 0) return [["Hips", 1]];
    if (k === chain.length - 1) return [["Spine2", 1]];
    const f = (y - at[k]) / (at[k + 1] - at[k]);
    return [[chain[k], 1 - f], [chain[k + 1], f]];
  });
  tube(out, P("Neck"), P("Head"), 0.04, 4, blended("Neck", "Spine2"));
  tube(out, P("Head"), [0, 1, 0], 0.07, 8, blended("Head", "Neck"));
  for (const side of ["Left", "Right"]) {
    const s = (b) => side + b;
    tube(out, P(s("Shoulder")), P(s("Arm")), 0.04, 4, blended(s("Shoulder"), "Spine2"));
    tube(out, P(s("Arm")), P(s("ForeArm")), 0.035, 8, blended(s("Arm"), s("Shoulder")));
    tube(out, P(s("ForeArm")), P(s("Hand")), 0.03, 8, blended(s("ForeArm"), s("Arm")));
    tube(out, P(s("Hand")), ext(s("ForeArm"), s("Hand"), 0.6), 0.03, 6, blended(s("Hand"), s("ForeArm")));
    tube(out, P(s("UpLeg")), P(s("Leg")), 0.05, 10, blended(s("UpLeg"), "Hips"));
    tube(out, P(s("Leg")), P(s("Foot")), 0.04, 10, blended(s("Leg"), s("UpLeg")));
    tube(out, P(s("Foot")), P(s("ToeBase")), 0.03, 5, blended(s("Foot"), s("Leg")));
    tube(out, P(s("ToeBase")), ext(s("Foot"), s("ToeBase"), 0.5), 0.03, 4, blended(s("ToeBase"), s("Foot")));
  }
  return out;
}

/**
 * @param {"good" | "collapsed" | "arm-on-spine"} kind  collapsed: every vertex on Spine1 (the broken dylan rig);
 *   arm-on-spine: only the left arm's vertices left on Spine2 (a partly broken rig)
 */
export async function makeRigGlb(kind = "good") {
  const fig = figure();
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene("Scene");
  const armature = doc.createNode("Armature");
  scene.addChild(armature);

  // Bones: world position from J, world rotation an arbitrary (but fixed) turn per bone.
  const worldQ = {};
  const worldT = {};
  const nodes = {};
  BONES.forEach((b, i) => {
    worldQ[b] = qAxis([1, (i % 3) - 1, 2], 0.4 + 0.37 * i);
    worldT[b] = toModel(J[b]);
  });
  for (const b of BONES) {
    const parent = PARENT[b];
    const node = doc.createNode(`mixamorig:${b}`);
    if (parent) {
      const pq = worldQ[parent];
      node.setRotation(qMul(qInv(pq), worldQ[b]));
      node.setTranslation(qRot(qInv(pq), worldT[b].map((v, k) => v - worldT[parent][k])));
      nodes[parent].addChild(node);
    } else {
      node.setRotation(worldQ[b]);
      node.setTranslation(worldT[b]);
      armature.addChild(node);
    }
    nodes[b] = node;
  }

  const n = fig.positions.length / 3;
  const pos = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) pos.set(toModel(fig.positions.slice(v * 3, v * 3 + 3)), v * 3);
  const joints = new Uint16Array(n * 4);
  const weights = new Float32Array(n * 4);
  const leftArm = new Set(["LeftArm", "LeftForeArm", "LeftHand"]);
  for (let v = 0; v < n; v++) {
    let pairs = fig.weights[v];
    if (kind === "collapsed") pairs = [["Spine1", 1]];
    if (kind === "arm-on-spine" && pairs.some(([b]) => leftArm.has(b))) pairs = [["Spine2", 1]];
    pairs.forEach(([b, w], k) => {
      joints[v * 4 + k] = BONES.indexOf(b);
      weights[v * 4 + k] = w;
    });
  }
  const buffer = doc.getRoot().listBuffers()[0];
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", accessor("VEC3", pos))
    .setAttribute("JOINTS_0", accessor("VEC4", joints))
    .setAttribute("WEIGHTS_0", accessor("VEC4", weights))
    .setIndices(accessor("SCALAR", new Uint32Array(fig.indices)))
    .setMaterial(doc.createMaterial("skin").setBaseColorFactor([0.7, 0.6, 0.5, 1]));
  const ibm = new Float32Array(BONES.length * 16);
  BONES.forEach((b, i) => ibm.set(inverseRigid(worldQ[b], worldT[b]), i * 16));
  const skin = doc.createSkin("Armature").setSkeleton(nodes.Hips).setInverseBindMatrices(accessor("MAT4", ibm));
  for (const b of BONES) skin.addJoint(nodes[b]);
  const body = doc.createNode("Body").setMesh(doc.createMesh("Body").addPrimitive(prim)).setSkin(skin);
  armature.addChild(body);
  return new NodeIO().writeBinary(doc);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const { optimizeGlb } = await import("../../../forge/optimize.js");
  for (const kind of ["good", "collapsed"]) {
    const raw = await makeRigGlb(kind);
    const out = (await optimizeGlb(raw)).glb;
    fs.writeFileSync(new URL(`./rig-${kind}.glb`, import.meta.url), out);
    console.log(`rig-${kind}.glb`, raw.length, "->", out.length, "bytes");
  }
}
