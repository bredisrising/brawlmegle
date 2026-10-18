// Rig QA for forged fighters: does this GLB's skeleton actually move its mesh the way the game will move it?
//
//   import { checkRig } from "./rigcheck.js";
//   const report = await checkRig(glbBytes);   // { ok, score, problems: [{ level, code, message }], stats }
//
//   node forge/rigcheck.js fighter.glb [...]  [--json]  [--sheet out.png]
//
// Static checks: the 22 Mixamo bones, their hierarchy and rest positions (head over hips, hands at the arm ends,
// feet on the floor, left on the left), the size (about 1 m, feet at y = 0), the skin weights (every vertex weighted,
// summing to 1, no bone owning most of the mesh, the vertices around each limb owned by that limb).
//
// Deformation checks (the real test): the skeleton is posed exactly the way the game poses it (a port of
// src/director/skeletonPose.ts, with the game's own poses baked into rigcheck-poses.json by
// test/forge/rigcheckPoses.test.ts: a cross, a hook, a knee, a kick, a head snap, the victory pose, the K.O. ragdoll),
// the mesh is skinned on the CPU (linear blend skinning, like three.js), and each body part's vertices must go where
// their bone went: hands with the wrist, limbs with their bones, the torso staying put, and no torn or collapsed
// stretches of surface.
//
// Independent of how the rig was made (Tripo, the GPU box's Blender rigger, anything else): it only reads the GLB.
// Its packages are the optimizer's (gltf-transform + meshoptimizer, `cd forge && npm ci`), loaded on first use.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const POSES = JSON.parse(fs.readFileSync(new URL("./rigcheck-poses.json", import.meta.url), "utf8"));

/** The 22 Mixamo bones the game drives or inherits from, and each one's parent. */
export const PARENT = {
  Hips: null,
  Spine: "Hips",
  Spine1: "Spine",
  Spine2: "Spine1",
  Neck: "Spine2",
  Head: "Neck",
  LeftShoulder: "Spine2",
  LeftArm: "LeftShoulder",
  LeftForeArm: "LeftArm",
  LeftHand: "LeftForeArm",
  RightShoulder: "Spine2",
  RightArm: "RightShoulder",
  RightForeArm: "RightArm",
  RightHand: "RightForeArm",
  LeftUpLeg: "Hips",
  LeftLeg: "LeftUpLeg",
  LeftFoot: "LeftLeg",
  LeftToeBase: "LeftFoot",
  RightUpLeg: "Hips",
  RightLeg: "RightUpLeg",
  RightFoot: "RightLeg",
  RightToeBase: "RightFoot",
};
export const BONES = Object.keys(PARENT);

/**
 * Pass/fail limits. Lengths are in meters on a ~1 m fighter (the game's fighter space). Picked on the live fighters
 * (see the report in the rig-qa branch): the good rigs sit far inside every one, a rig whose weights collapsed onto
 * the spine fails most of them by 5-10x.
 */
export const LIMITS = {
  /** Height of the mesh, and how far its lowest point may be off the floor. */
  height: [0.75, 1.3],
  floor: 0.06,
  /** Share of vertices whose weights don't sum to 1 (within 0.03) or that have no weight at all. */
  unweighted: 0.005,
  /** The most of the surface one bone may own (by dominant weight, area-weighted). */
  boneShare: 0.42,
  /** Mean weight a limb's vertices put on that limb's bones (the bone, its parent, its child). */
  owned: 0.6,
  /** Hand vertices' centroid, posed, must be this close to where the wrist took it (m). */
  hand: 0.04,
  /**
   * A body part follows its bone when its vertices' median miss is under this share of how far the bone moved them
   * (or of LAG_FLOOR m, for parts that hardly move, so a torso dragged along by an arm still counts).
   */
  lag: 0.35,
  /**
   * The same for the chest, shoulders and neck, which blend with the arms and the head by design. (The hips aren't judged:
   * they blend with both thighs, and a raised knee rightly pulls the pelvis along.)
   */
  torsoLag: 0.6,
  /** Share of the surface's edges stretched past 2.5x or squashed under 0.3x in the worst pose. */
  torn: 0.02,
  /** Share of vertices that end up more than DETACH m farther from the skeleton than they started. */
  detached: 0.02,
  /** Rest pose: skinned vs unskinned vertex positions (the inverse bind matrices match the bones). */
  bind: 0.01,
};
const LAG_FLOOR = 0.04;
const DETACH = 0.08;

// --- Math: column-major 4x4 matrices and (x, y, z, w) quaternions, like three.js and glTF -------------------------

const mat = () => new Float64Array(16);
const identity = (m = mat()) => (m.fill(0), (m[0] = m[5] = m[10] = m[15] = 1), m);

function compose(t, q, s, out = mat()) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx; out[2] = (xz - wy) * sx; out[3] = 0;
  out[4] = (xy - wz) * sy; out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy; out[7] = 0;
  out[8] = (xz + wy) * sz; out[9] = (yz - wx) * sz; out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
  out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
  return out;
}

function multiply(a, b, out = mat()) {
  const r = mat();
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      r[c * 4 + row] = a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
    }
  }
  out.set(r);
  return out;
}

function invert(m, out = mat()) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return identity(out);
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

const position = (m) => [m[12], m[13], m[14]];
const transform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
const normalize = (a) => {
  const l = length(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
};
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const dist = (a, b) => length(sub(a, b));

const qMul = (a, b) => [
  a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1],
  a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
  a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qInvert = (q) => [-q[0], -q[1], -q[2], q[3]];

/** three.js Quaternion.setFromUnitVectors. */
function qFromUnitVectors(from, to) {
  let r = dot(from, to) + 1;
  let x, y, z;
  if (r < 1e-8) {
    r = 0;
    if (Math.abs(from[0]) > Math.abs(from[2])) [x, y, z] = [-from[1], from[0], 0];
    else [x, y, z] = [0, -from[2], from[1]];
  } else [x, y, z] = cross(from, to);
  const l = Math.hypot(x, y, z, r);
  return [x / l, y / l, z / l, r / l];
}

/** three.js Quaternion.setFromRotationMatrix, on the rotation part of a column-major matrix. */
function qFromMatrix(m) {
  const m11 = m[0], m12 = m[4], m13 = m[8], m21 = m[1], m22 = m[5], m23 = m[9], m31 = m[2], m32 = m[6], m33 = m[10];
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

/** three.js Object3D.getWorldQuaternion: the rotation of the world matrix with its scale divided out. */
function worldQuat(m) {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (det < 0) sx = -sx;
  const r = new Float64Array(m);
  for (let i = 0; i < 3; i++) {
    r[i] /= sx || 1;
    r[4 + i] /= sy || 1;
    r[8 + i] /= sz || 1;
  }
  return qFromMatrix(r);
}

/** Rotation (as a quaternion) whose y axis is `up` and x axis `across` made perpendicular to it (skeletonPose.ts). */
function frame(up, across) {
  let fx = sub(across, scale(up, dot(across, up)));
  fx = dot(fx, fx) < 1e-8 ? [1, 0, 0] : normalize(fx);
  const fz = cross(fx, up);
  const m = identity();
  m.set([fx[0], fx[1], fx[2], 0, up[0], up[1], up[2], 0, fz[0], fz[1], fz[2], 0, 0, 0, 0, 1]);
  return qFromMatrix(m);
}

// --- Loading -------------------------------------------------------------------------------------------------------

let depsPromise;
function deps() {
  depsPromise ??= (async () => {
    const [core, extensions, meshopt] = await Promise.all([import("@gltf-transform/core"), import("@gltf-transform/extensions"), import("meshoptimizer")]);
    await meshopt.MeshoptDecoder.ready;
    const io = new core.NodeIO().registerExtensions(extensions.ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": meshopt.MeshoptDecoder });
    return { io };
  })();
  depsPromise.catch(() => (depsPromise = undefined));
  return depsPromise;
}

/** True when the checker's packages are installed (the forge skips the gate, loudly, when they aren't). */
export async function available() {
  try {
    await deps();
    return true;
  } catch {
    return false;
  }
}

/** The game's fighter space: forged models face +x and FighterView turns them -90 degrees about y to face +z. */
const GAME_TURN = compose([0, 0, 0], [0, Math.sin(-Math.PI / 4), 0, Math.cos(-Math.PI / 4)], [1, 1, 1]);

/** Strip three.js's sanitizing differences: "mixamorig:Hips" and "mixamorigHips" are the same bone to the game. */
const boneName = (name) => {
  const m = /^mixamorig:?(.+)$/.exec(name ?? "");
  return m ? m[1] : null;
};

/**
 * The scene as flat arrays: nodes (local TRS, parent), skinned triangles (positions, up to 8 influences per vertex,
 * indices). Unskinned meshes are only counted.
 */
async function load(input) {
  const { io } = await deps();
  const doc = await io.readBinary(new Uint8Array(input));
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error("no scene");
  const nodes = [];
  const index = new Map();
  const visit = (node, parent) => {
    const i = nodes.length;
    index.set(node, i);
    nodes.push({ name: node.getName(), parent, t: node.getTranslation(), r: node.getRotation(), s: node.getScale(), node });
    for (const child of node.listChildren()) visit(child, i);
  };
  for (const node of scene.listChildren()) visit(node, -1);

  const positions = [];
  const influences = []; // per vertex: [node, weight, node, weight, ...]
  const indices = [];
  const meshNode = [];
  let unskinned = 0;
  let skins = 0;
  let badJoints = 0;
  for (const [node, i] of index) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const skin = node.getSkin();
    if (!skin) {
      unskinned += mesh.listPrimitives().length;
      continue;
    }
    skins++;
    const joints = skin.listJoints().map((j) => index.get(j) ?? -1);
    const ibmAccessor = skin.getInverseBindMatrices();
    const ibms = joints.map((_, k) => (ibmAccessor ? Float64Array.from(ibmAccessor.getElement(k, [])) : identity()));
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue; // triangles only
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      const sets = [0, 1].map((k) => [prim.getAttribute(`JOINTS_${k}`), prim.getAttribute(`WEIGHTS_${k}`)]).filter(([j, w]) => j && w);
      const base = positions.length;
      const p = [];
      const j = [];
      const w = [];
      for (let v = 0; v < pos.getCount(); v++) {
        positions.push(pos.getElement(v, p).slice());
        const inf = [];
        for (const [ja, wa] of sets) {
          ja.getElement(v, j);
          wa.getElement(v, w);
          for (let k = 0; k < j.length; k++) {
            if (!(w[k] > 0)) continue;
            const n = joints[j[k]];
            if (n === undefined || n < 0) {
              badJoints++;
              continue;
            }
            inf.push(n, w[k], ibms[j[k]]);
          }
        }
        influences.push(inf);
        meshNode.push(i);
      }
      const idx = prim.getIndices();
      if (idx) for (let k = 0; k < idx.getCount(); k++) indices.push(base + idx.getScalar(k));
      else for (let k = 0; k < pos.getCount(); k++) indices.push(base + k);
    }
  }
  return { nodes, positions, influences, indices, meshNode, unskinned, skins, badJoints };
}

// --- Skeleton: world matrices, and the game's posing --------------------------------------------------------------

/** World matrices (in the game's fighter space) from local quaternions. */
function worlds(nodes, quats, rootOffset = 0) {
  const out = new Array(nodes.length);
  const top = rootOffset ? multiply(compose([0, rootOffset, 0], [0, 0, 0, 1], [1, 1, 1]), GAME_TURN) : GAME_TURN;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const local = compose(n.t, quats[i], n.s);
    out[i] = multiply(n.parent < 0 ? top : out[n.parent], local);
  }
  return out;
}

/** Parents come before children in `nodes`, so one pass from `from` on refreshes a subtree (and the rest). */
function refresh(nodes, quats, world, from) {
  for (let i = from; i < nodes.length; i++) {
    const n = nodes[i];
    if (i !== from && !isBelow(nodes, i, from)) continue;
    world[i] = multiply(n.parent < 0 ? GAME_TURN : world[n.parent], compose(n.t, quats[i], n.s));
  }
}
function isBelow(nodes, i, ancestor) {
  for (let p = nodes[i].parent; p >= 0; p = nodes[p].parent) if (p === ancestor) return true;
  return false;
}

/** src/director/skeletonPose.ts SEGMENTS. */
const SEGMENTS = [
  { bone: "Spine", child: "Neck", from: "hips", to: "neck", follow: 0.6, turn: true },
  { bone: "Neck", child: "Head", from: "neck", to: "head", follow: 0.6 },
  { bone: "LeftArm", child: "LeftForeArm", from: "lShoulder", to: "lElbow" },
  { bone: "LeftForeArm", child: "LeftHand", from: "lElbow", to: "lWrist" },
  { bone: "RightArm", child: "RightForeArm", from: "rShoulder", to: "rElbow" },
  { bone: "RightForeArm", child: "RightHand", from: "rElbow", to: "rWrist" },
  { bone: "LeftUpLeg", child: "LeftLeg", from: "lHip", to: "lKnee" },
  { bone: "LeftLeg", child: "LeftFoot", from: "lKnee", to: "lAnkle" },
  { bone: "RightUpLeg", child: "RightLeg", from: "rHip", to: "rKnee" },
  { bone: "RightLeg", child: "RightFoot", from: "rKnee", to: "rAnkle" },
];
/** fightPose.ts HIP_HEIGHT: the guard pose's hip height, which FighterView measures crouches from. */
const POSE_HIP = 0.5;

/** SkeletonPose.from: rest directions and rotations, in fighter space. */
function rigFor(nodes, bones, rest) {
  const restQuats = nodes.map((n) => n.r);
  const pos = (b) => position(rest[bones[b]]);
  const across = bones.LeftArm !== undefined && bones.RightArm !== undefined ? normalize(sub(pos("LeftArm"), pos("RightArm"))) : null;
  const rigs = [];
  for (const seg of SEGMENTS) {
    const b = bones[seg.bone];
    const c = bones[seg.child];
    if (b === undefined || c === undefined) continue;
    rigs.push({ seg, node: b, restDir: normalize(sub(pos(seg.child), pos(seg.bone))), restQuat: worldQuat(rest[b]), across: seg.turn ? across : null });
  }
  return { rigs, restQuats, hipHeight: bones.Hips !== undefined ? pos("Hips")[1] : POSE_HIP };
}

/** SkeletonPose.apply (+ FighterView's hip drop): local quaternions and world matrices for one pose. */
function applyPose(nodes, rig, pose) {
  const quats = rig.restQuats.slice();
  const world = worlds(nodes, quats);
  for (const r of rig.rigs) {
    const parent = nodes[r.node].parent;
    if (parent < 0) continue;
    const from = r.seg.from === "hips" ? scale(add(pose.lHip, pose.rHip), 0.5) : pose[r.seg.from];
    let dir = sub(pose[r.seg.to], from);
    if (dot(dir, dir) < 1e-8) continue;
    dir = normalize(dir);
    if (r.seg.follow !== undefined) dir = normalize(lerp(dir, r.restDir, 1 - r.seg.follow));
    const q = r.across
      ? qMul(frame(dir, sub(pose.lShoulder, pose.rShoulder)), qInvert(frame(r.restDir, r.across)))
      : qFromUnitVectors(r.restDir, dir);
    const worldQ = qMul(q, r.restQuat);
    quats[r.node] = qMul(qInvert(worldQuat(world[parent])), worldQ);
    refresh(nodes, quats, world, r.node);
  }
  // The hips bone isn't driven: the model drops by as much as the pose's hips dropped.
  const hipY = (pose.lHip[1] + pose.rHip[1]) / 2;
  const offset = (hipY - POSE_HIP) * (rig.hipHeight / POSE_HIP);
  return worlds(nodes, quats, offset);
}

/** Linear blend skinning (three.js: bone world x inverse bind x bind matrix). */
function skin(data, world, meshWorldRest) {
  const n = data.positions.length;
  const out = new Float64Array(n * 3);
  // Per joint (its inverse bind matrix stands for it) and mesh node: bone world x inverse bind x bind.
  const skinCache = new Map();
  for (let v = 0; v < n; v++) {
    const p = data.positions[v];
    const mesh = data.meshNode[v];
    const bind = meshWorldRest[mesh];
    const inf = data.influences[v];
    let x = 0, y = 0, z = 0, total = 0;
    for (let k = 0; k < inf.length; k += 3) {
      const node = inf[k];
      const w = inf[k + 1];
      const ibm = inf[k + 2];
      let byMesh = skinCache.get(ibm);
      if (!byMesh) skinCache.set(ibm, (byMesh = new Map()));
      let m = byMesh.get(mesh);
      if (!m) byMesh.set(mesh, (m = multiply(multiply(world[node], ibm), bind)));
      x += w * (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]);
      y += w * (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]);
      z += w * (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]);
      total += w;
    }
    // A vertex with no weight renders where its bind matrix puts it (three.js would collapse it to the origin).
    if (total <= 0) [x, y, z] = transform(multiply(GAME_TURN, bind), p);
    out[v * 3] = x;
    out[v * 3 + 1] = y;
    out[v * 3 + 2] = z;
  }
  return out;
}

// --- Body parts: segments of the rest skeleton, and the vertices clearly around each ----------------------------

/**
 * One segment per bone, from its joint to its child's (end bones get a tip: the head's top, the fingers, the toes),
 * plus the hip bar. `owners` are the bones a vertex here may reasonably be weighted to.
 */
function bodySegments(bones, rest, top) {
  const pos = (b) => position(rest[bones[b]]);
  const segs = [];
  const seg = (name, bone, a, b, owners, tip = false) => segs.push({ name, bone, a, b, owners, tip });
  seg("Hips", "Hips", pos("Hips"), pos("Spine"), ["Hips", "Spine", "LeftUpLeg", "RightUpLeg"]);
  seg("HipBar", "Hips", pos("LeftUpLeg"), pos("RightUpLeg"), ["Hips", "Spine", "LeftUpLeg", "RightUpLeg"]);
  seg("Spine", "Spine", pos("Spine"), pos("Spine1"), ["Hips", "Spine", "Spine1"]);
  seg("Spine1", "Spine1", pos("Spine1"), pos("Spine2"), ["Spine", "Spine1", "Spine2"]);
  seg("Spine2", "Spine2", pos("Spine2"), pos("Neck"), ["Spine1", "Spine2", "Neck", "LeftShoulder", "RightShoulder"]);
  seg("Neck", "Neck", pos("Neck"), pos("Head"), ["Spine2", "Neck", "Head"]);
  const head = pos("Head");
  seg("Head", "Head", head, [head[0], head[1] + Math.max(0.06, (top - head[1]) * 0.85), head[2]], ["Neck", "Head"], true);
  for (const side of ["Left", "Right"]) {
    const s = (b) => side + b;
    seg(s("Shoulder"), s("Shoulder"), pos(s("Shoulder")), pos(s("Arm")), ["Spine2", s("Shoulder"), s("Arm")]);
    seg(s("Arm"), s("Arm"), pos(s("Arm")), pos(s("ForeArm")), [s("Shoulder"), s("Arm"), s("ForeArm")]);
    seg(s("ForeArm"), s("ForeArm"), pos(s("ForeArm")), pos(s("Hand")), [s("Arm"), s("ForeArm"), s("Hand")]);
    const hand = pos(s("Hand"));
    seg(s("Hand"), s("Hand"), hand, add(hand, scale(sub(hand, pos(s("ForeArm"))), 0.6)), [s("ForeArm"), s("Hand")], true);
    seg(s("UpLeg"), s("UpLeg"), pos(s("UpLeg")), pos(s("Leg")), ["Hips", s("UpLeg"), s("Leg")]);
    seg(s("Leg"), s("Leg"), pos(s("Leg")), pos(s("Foot")), [s("UpLeg"), s("Leg"), s("Foot")]);
    seg(s("Foot"), s("Foot"), pos(s("Foot")), pos(s("ToeBase")), [s("Leg"), s("Foot"), s("ToeBase")]);
    const toe = pos(s("ToeBase"));
    seg(s("ToeBase"), s("ToeBase"), toe, add(toe, scale(sub(toe, pos(s("Foot"))), 0.6)), [s("Foot"), s("ToeBase")], true);
  }
  // Adjacent segments share a joint, so vertices near that joint may sit between them.
  const touches = (x, y) => x.owners.includes(y.bone) || y.owners.includes(x.bone);
  for (const s of segs) s.near = segs.map((o) => o === s || touches(s, o));
  return segs;
}

let segT = 0;
/** Distance from (x, y, z) to the segment a-b. Leaves how far along it the nearest point is in segT (unclamped). */
function segDist(x, y, z, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const t = ((x - a[0]) * abx + (y - a[1]) * aby + (z - a[2]) * abz) / (abx * abx + aby * aby + abz * abz || 1e-12);
  segT = t;
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = x - a[0] - abx * c, dy = y - a[1] - aby * c, dz = z - a[2] - abz * c;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Distance between vertex i of A and vertex j of B (flat xyz arrays). */
function vdist(A, i, B, j) {
  const dx = A[i * 3] - B[j * 3], dy = A[i * 3 + 1] - B[j * 3 + 1], dz = A[i * 3 + 2] - B[j * 3 + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** The mesh's unique edges as pairs of vertex indices, skipping ones too short to measure. */
function edgesOf(indices, rest) {
  const keys = new Float64Array(indices.length);
  let n = 0;
  for (let k = 0; k + 2 < indices.length; k += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[k + e];
      const b = indices[k + ((e + 1) % 3)];
      if (a !== b) keys[n++] = a < b ? a * 2 ** 26 + b : b * 2 ** 26 + a;
    }
  }
  const sorted = keys.subarray(0, n).sort();
  const pairs = [];
  const lens = [];
  for (let k = 0; k < n; k++) {
    if (k && sorted[k] === sorted[k - 1]) continue;
    const a = Math.floor(sorted[k] / 2 ** 26);
    const b = sorted[k] - a * 2 ** 26;
    const l = vdist(rest, a, rest, b);
    if (l < 1e-4) continue;
    pairs.push(a, b);
    lens.push(l);
  }
  return { pairs: Int32Array.from(pairs), lens: Float64Array.from(lens) };
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = Float64Array.from(xs).sort();
  return s[Math.floor(s.length / 2)];
};
const r3 = (x) => Math.round(x * 1000) / 1000;

// --- The check -----------------------------------------------------------------------------------------------------

/**
 * @param {Uint8Array | Buffer} input  a GLB
 * @param {{ keep?: boolean }} [options]  keep: also return the rest and posed vertices (`debug`, for contact sheets)
 * @returns {Promise<{ ok: boolean, score: number, problems: {level: "fail" | "warn", code: string, message: string}[], stats: object, debug?: object }>}
 */
export async function checkRig(input, { keep = false } = {}) {
  const started = performance.now();
  const problems = [];
  const fail = (code, message) => problems.push({ level: "fail", code, message });
  const warn = (code, message) => problems.push({ level: "warn", code, message });
  const stats = {};
  const done = (debug) => {
    stats.ms = Math.round(performance.now() - started);
    const fails = problems.filter((p) => p.level === "fail").length;
    const score = scoreOf(stats, fails);
    return { ok: fails === 0, score, problems, stats, ...(keep && debug ? { debug } : {}) };
  };

  let data;
  try {
    data = await load(input);
  } catch (err) {
    fail("unreadable", `not a readable GLB: ${err.message}`);
    return done();
  }
  stats.vertices = data.positions.length;
  stats.triangles = Math.floor(data.indices.length / 3);
  if (data.unskinned) warn("unskinned-mesh", `${data.unskinned} mesh part(s) without skin weights (they won't move with the skeleton)`);
  if (!data.skins || !data.positions.length) {
    fail("no-skin", "no skinned mesh: the model has no rig the game can drive");
    return done();
  }

  // Bones.
  const bones = {};
  for (let i = 0; i < data.nodes.length; i++) {
    const b = boneName(data.nodes[i].name);
    if (b && PARENT[b] !== undefined && bones[b] === undefined) bones[b] = i;
  }
  const missing = BONES.filter((b) => bones[b] === undefined);
  stats.bones = BONES.length - missing.length;
  if (missing.length) {
    fail("missing-bones", `missing Mixamo bones: ${missing.join(", ")}`);
    return done();
  }
  const wrongParent = BONES.filter((b) => PARENT[b] && boneName(data.nodes[data.nodes[bones[b]].parent]?.name) !== PARENT[b]);
  if (wrongParent.length) fail("hierarchy", `bones not under their Mixamo parent: ${wrongParent.map((b) => `${b} (want ${PARENT[b]})`).join(", ")}`);

  const rest = worlds(data.nodes, data.nodes.map((n) => n.r));
  // three.js binds each skinned mesh with its world matrix at load time (before the game turns the model).
  const meshWorldRest = worlds(data.nodes, data.nodes.map((n) => n.r)).map((m) => multiply(invert(GAME_TURN), m));
  const restSkinned = skin(data, rest, meshWorldRest);
  const N = data.positions.length;
  const vert = (arr, v) => [arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2]];

  // Size and floor (rest pose, fighter space).
  let minY = Infinity, maxY = -Infinity;
  for (let v = 0; v < N; v++) {
    const y = restSkinned[v * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const height = maxY - minY;
  stats.height = r3(height);
  stats.floor = r3(minY);
  if (height < LIMITS.height[0] || height > LIMITS.height[1]) fail("size", `the mesh is ${height.toFixed(2)} m tall (want about 1 m)`);
  if (Math.abs(minY) > LIMITS.floor) fail("floor", `the feet are at y = ${minY.toFixed(3)} (want 0)`);

  // Bind pose: the rest skin must leave the mesh where it is.
  let bindMoved = 0;
  const plainOf = meshWorldRest.map((m) => multiply(GAME_TURN, m));
  for (let v = 0; v < N; v++) {
    const plain = transform(plainOf[data.meshNode[v]], data.positions[v]);
    if (dist(plain, vert(restSkinned, v)) > LIMITS.bind) bindMoved++;
  }
  stats.bindMismatch = r3(bindMoved / N);
  if (bindMoved / N > 0.01) fail("bind-pose", `${pct(bindMoved / N)} of the mesh moves at rest (the inverse bind matrices don't match the bones)`);

  // Rest skeleton layout (fighter space: +x is the fighter's left, +z toward the opponent, y up).
  const P = Object.fromEntries(BONES.map((b) => [b, position(rest[bones[b]])]));
  stats.joints = Object.fromEntries(BONES.map((b) => [b, P[b].map(r3)]));
  const layout = [];
  if (!(P.Head[1] > P.Neck[1] && P.Neck[1] > P.Spine2[1] && P.Spine2[1] > P.Hips[1])) layout.push("the spine doesn't go up from the hips to the head");
  for (const [side, sign] of [["Left", 1], ["Right", -1]]) {
    const b = (n) => P[side + n];
    if (!(sign * b("Arm")[0] > 0 && sign * b("Hand")[0] > 0 && sign * b("UpLeg")[0] > 0 && sign * b("Foot")[0] > 0)) layout.push(`${side.toLowerCase()} bones on the wrong side`);
    // The hand hangs off the end of the arm: farther from the shoulder than the elbow, about a forearm past it.
    const upper = dist(b("Arm"), b("ForeArm"));
    const fore = dist(b("ForeArm"), b("Hand"));
    if (!(dist(b("Arm"), b("Hand")) > dist(b("Arm"), b("ForeArm")) && fore > 0.4 * upper && fore < 2 * upper)) layout.push(`the ${side.toLowerCase()} hand isn't at the end of the arm`);
    if (!(b("Foot")[1] < 0.15 * height + minY && b("ToeBase")[1] < 0.1 * height + minY)) layout.push(`the ${side.toLowerCase()} foot is off the floor`);
    if (!(b("Leg")[1] < b("UpLeg")[1] && b("Foot")[1] < b("Leg")[1])) layout.push(`the ${side.toLowerCase()} leg doesn't go down`);
  }
  if (!(P.Hips[1] - minY > 0.35 * height && P.Hips[1] - minY < 0.65 * height)) layout.push(`the hips are at ${((P.Hips[1] - minY) / height).toFixed(2)} of the height`);
  if (!(P.Head[1] - minY > 0.7 * height)) layout.push("the head bone is low");
  for (const l of layout) fail("skeleton", l);

  // Weights: every vertex weighted, summing to 1; which bone owns each vertex (its biggest weight).
  const boneOf = new Map(BONES.map((b) => [bones[b], b]));
  const dominant = new Int32Array(N);
  let unweighted = 0;
  // Ownership by surface area, not vertex count: generated meshes spend most of their vertices on faces and hair.
  const area = new Float64Array(N);
  let totalArea = 0;
  for (let k = 0; k + 2 < data.indices.length; k += 3) {
    const [a, b, c] = [data.indices[k], data.indices[k + 1], data.indices[k + 2]];
    const ab = [0, 1, 2].map((i) => restSkinned[b * 3 + i] - restSkinned[a * 3 + i]);
    const ac = [0, 1, 2].map((i) => restSkinned[c * 3 + i] - restSkinned[a * 3 + i]);
    const t = length(cross(ab, ac)) / 2;
    area[a] += t / 3;
    area[b] += t / 3;
    area[c] += t / 3;
    totalArea += t;
  }
  const share = {};
  for (let v = 0; v < N; v++) {
    const inf = data.influences[v];
    let total = 0, best = -1, bestW = 0;
    for (let k = 0; k < inf.length; k += 3) {
      total += inf[k + 1];
      if (inf[k + 1] > bestW) [best, bestW] = [inf[k], inf[k + 1]];
    }
    if (Math.abs(total - 1) > 0.03) unweighted++;
    dominant[v] = best;
    const name = boneOf.get(best) ?? data.nodes[best]?.name ?? "none";
    share[name] = (share[name] ?? 0) + area[v];
  }
  stats.unweighted = r3(unweighted / N);
  if (data.badJoints) fail("bad-joints", `${data.badJoints} weights point at joints that aren't in the scene`);
  if (unweighted / N > LIMITS.unweighted) fail("unweighted", `${pct(unweighted / N)} of the vertices have weights that don't sum to 1`);
  const shares = Object.entries(share).map(([b, n]) => [b, n / (totalArea || 1)]).sort((a, b) => b[1] - a[1]);
  stats.topBones = shares.slice(0, 4).map(([b, s]) => `${b} ${pct(s)}`);
  stats.boneShare = r3(shares[0][1]);
  if (shares[0][1] > LIMITS.boneShare) fail("one-bone", `${shares[0][0]} owns ${pct(shares[0][1])} of the surface`);
  const unowned = BONES.filter((b) => !["Hips", "LeftToeBase", "RightToeBase"].includes(b) && !share[b]);
  if (unowned.length) warn("idle-bones", `bones that own no vertices: ${unowned.join(", ")}`);

  // Body parts, by geometry alone: each vertex's nearest segment, kept only when it's clearly that part.
  const segs = bodySegments(bones, rest, maxY);
  const nearest = new Int32Array(N).fill(-1);
  const restDist = new Float64Array(N);
  const core = segs.map(() => []);
  const ds = new Float64Array(segs.length);
  for (let v = 0; v < N; v++) {
    const x = restSkinned[v * 3], y = restSkinned[v * 3 + 1], z = restSkinned[v * 3 + 2];
    let s1 = -1, d1 = Infinity, t1 = 0;
    for (let s = 0; s < segs.length; s++) {
      ds[s] = segDist(x, y, z, segs[s].a, segs[s].b);
      if (ds[s] < d1) [s1, d1, t1] = [s, ds[s], segT];
    }
    nearest[v] = s1;
    restDist[v] = d1;
    let d2 = Infinity;
    for (let s = 0; s < segs.length; s++) if (!segs[s1].near[s] && ds[s] < d2) d2 = ds[s];
    const along = segs[s1].tip ? t1 > 0.25 && t1 < 1.4 : t1 > 0.2 && t1 < 0.8;
    if (along && d1 < 0.55 * d2) core[s1].push(v);
  }

  // Weight sanity per part: its vertices mostly weighted to its own bones.
  stats.owned = {};
  const owners = segs.map((s) => new Set(s.owners.map((b) => bones[b])));
  for (let s = 0; s < segs.length; s++) {
    const vs = core[s];
    if (vs.length < 10) continue;
    let sum = 0;
    for (const v of vs) {
      const inf = data.influences[v];
      for (let k = 0; k < inf.length; k += 3) if (owners[s].has(inf[k])) sum += inf[k + 1];
    }
    stats.owned[segs[s].name] = r3(sum / vs.length);
  }
  const LIMB = /Arm|Hand|Leg|Foot|Head/;
  const badOwned = Object.entries(stats.owned).filter(([name, o]) => LIMB.test(name) && o < LIMITS.owned);
  if (badOwned.length) fail("weights-off-limb", `limb vertices weighted to other bones: ${badOwned.map(([n, o]) => `${n} ${pct(o)}`).join(", ")}`);

  // Deformation: pose like the game, skin, and see where each part went.
  const rig = rigFor(data.nodes, bones, rest);
  const edges = edgesOf(data.indices, restSkinned);
  stats.poses = {};
  const posed = {};
  const worst = { hand: [0, ""], lag: [0, ""], torsoLag: [0, ""], torn: [0, ""], detached: [0, ""] };
  const TORSO = /^(Spine\d?|Neck|.*Shoulder)$/;
  const groupOf = (part) => (part === "Hips" || part === "HipBar" ? null : TORSO.test(part) ? "torsoLag" : "lag");
  const note = (key, value, label) => value > worst[key][0] && (worst[key] = [value, label]);
  for (const [name, pose] of Object.entries(POSES)) {
    const world = applyPose(data.nodes, rig, pose);
    const out = skin(data, world, meshWorldRest);
    if (keep) posed[name] = { vertices: out, joints: Object.fromEntries(BONES.map((b) => [b, position(world[bones[b]])])) };
    const moveOf = BONES.map((b) => multiply(world[bones[b]], invert(rest[bones[b]])));
    const ps = { lag: {}, hand: {} };
    // Each part: the vertices against where its bone would carry them rigidly.
    for (let s = 0; s < segs.length; s++) {
      const vs = core[s];
      if (vs.length < 10) continue;
      const m = moveOf[BONES.indexOf(segs[s].bone)];
      const miss = [];
      const moved = [];
      let cx = 0, cy = 0, cz = 0, ex = 0, ey = 0, ez = 0;
      for (const v of vs) {
        const r = vert(restSkinned, v);
        const want = transform(m, r);
        const got = vert(out, v);
        miss.push(dist(got, want));
        moved.push(dist(want, r));
        cx += got[0]; cy += got[1]; cz += got[2];
        ex += want[0]; ey += want[1]; ez += want[2];
      }
      const lag = median(miss) / Math.max(median(moved), LAG_FLOOR);
      ps.lag[segs[s].name] = r3(lag);
      if (/Hand$/.test(segs[s].name)) {
        const off = dist([cx, cy, cz], [ex, ey, ez]) / vs.length;
        ps.hand[segs[s].name] = r3(off);
        note("hand", off, `${segs[s].name} in ${name}`);
      }
      const group = groupOf(segs[s].name);
      if (group) note(group, lag, `${segs[s].name} in ${name}`);
    }
    // Surface: stretched or collapsed edges.
    let torn = 0;
    for (let k = 0; k < edges.lens.length; k++) {
      const ratio = vdist(out, edges.pairs[2 * k], out, edges.pairs[2 * k + 1]) / edges.lens[k];
      if (ratio > 2.5 || ratio < 0.3) torn++;
    }
    ps.torn = r3(torn / Math.max(1, edges.lens.length));
    note("torn", ps.torn, name);
    // Detached: vertices flung away from the posed skeleton.
    const posedSegs = segs.map((sg) => {
      const m = moveOf[BONES.indexOf(sg.bone)];
      return [transform(m, sg.a), transform(m, sg.b)];
    });
    // The bar between the hips and segments that end on a child joint end where that child went.
    for (let s = 0; s < segs.length; s++) {
      const sg = segs[s];
      if (sg.tip) continue;
      const child = BONES.find((b) => b !== sg.bone && dist(P[b], sg.b) < 1e-6);
      if (child) posedSegs[s][1] = position(world[bones[child]]);
      const start = BONES.find((b) => dist(P[b], sg.a) < 1e-6);
      if (start) posedSegs[s][0] = position(world[bones[start]]);
    }
    let detached = 0;
    for (let v = 0; v < N; v++) {
      const x = out[v * 3], y = out[v * 3 + 1], z = out[v * 3 + 2];
      const limit = restDist[v] + DETACH;
      let near = false;
      for (let s = 0; s < posedSegs.length && !near; s++) near = segDist(x, y, z, posedSegs[s][0], posedSegs[s][1]) <= limit;
      if (!near) detached++;
    }
    ps.detached = r3(detached / N);
    note("detached", ps.detached, name);
    stats.poses[name] = ps;
  }
  stats.worst = Object.fromEntries(Object.entries(worst).map(([k, [v, where]]) => [k, { value: r3(v), where }]));
  if (worst.hand[0] > LIMITS.hand) fail("hand-off-wrist", `the ${worst.hand[1].replace(/Hand in/, "hand in the")} pose lands ${(worst.hand[0] * 100).toFixed(1)} cm from the wrist`);
  if (worst.lag[0] > LIMITS.lag || worst.torsoLag[0] > LIMITS.torsoLag) {
    const lagging = new Set();
    for (const ps of Object.values(stats.poses)) {
      for (const [part, l] of Object.entries(ps.lag)) if (groupOf(part) && l > LIMITS[groupOf(part)]) lagging.add(part);
    }
    const [value, where] = worst.lag[0] / LIMITS.lag > worst.torsoLag[0] / LIMITS.torsoLag ? worst.lag : worst.torsoLag;
    fail("parts-dont-follow", `parts that don't follow their bones: ${[...lagging].join(", ")} (worst ${where}: misses by ${value.toFixed(2)}x what the bone moved)`);
  }
  if (worst.torn[0] > LIMITS.torn) fail("torn", `${pct(worst.torn[0])} of the surface tears or collapses in the ${worst.torn[1]} pose`);
  if (worst.detached[0] > LIMITS.detached) fail("detached", `${pct(worst.detached[0])} of the mesh comes away from the skeleton in the ${worst.detached[1]} pose`);

  const debug = keep ? { rest: { vertices: restSkinned, joints: P }, posed, indices: data.indices, dominant, boneOf, parents: PARENT } : null;
  return done(debug);
}

const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

/**
 * 0-100: how far inside its limits the rig sits. Each measure scores 1 at zero and 0 at twice its limit; the score is
 * the worst of them (a rig is as good as its worst limb), and any failed check caps it at 49.
 */
function scoreOf(stats, fails) {
  const parts = [];
  const add = (value, limit) => value !== undefined && parts.push(Math.max(0, 1 - value / (2 * limit)));
  add(stats.boneShare, LIMITS.boneShare);
  add(stats.unweighted, LIMITS.unweighted);
  if (stats.owned) {
    const owned = Object.entries(stats.owned).filter(([n]) => /Arm|Hand|Leg|Foot|Head/.test(n)).map(([, o]) => o);
    if (owned.length) parts.push(Math.max(0, Math.min(1, (Math.min(...owned) - LIMITS.owned / 2) / (1 - LIMITS.owned / 2))));
  }
  if (stats.worst) for (const k of ["hand", "lag", "torsoLag", "torn", "detached"]) add(stats.worst[k].value, LIMITS[k]);
  let score = parts.length ? Math.round(100 * Math.min(...parts)) : 0;
  if (fails) score = Math.min(score, 49);
  return score;
}

// --- CLI -----------------------------------------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const sheetAt = args.indexOf("--sheet");
  const sheet = sheetAt >= 0 ? args[sheetAt + 1] : null;
  const files = args.filter((a, i) => !a.startsWith("--") && i !== sheetAt + 1);
  if (!files.length) {
    console.log("usage: node forge/rigcheck.js fighter.glb [...] [--json] [--sheet out.png]");
    process.exit(2);
  }
  let bad = 0;
  for (const file of files) {
    const report = await checkRig(fs.readFileSync(file), { keep: Boolean(sheet) });
    if (!report.ok) bad++;
    if (sheet) {
      const { contactSheet } = await import("./rigcheck-sheet.js");
      const out = files.length > 1 ? sheet.replace(/(\.png)?$/, `-${file.split("/").pop().replace(/\.glb$/, "")}.png`) : sheet;
      await contactSheet(report, out, file.split("/").pop());
      delete report.debug;
    }
    if (asJson) console.log(JSON.stringify({ file, ...report }));
    else {
      console.log(`${report.ok ? "ok  " : "FAIL"} ${String(report.score).padStart(3)}  ${file}  (${report.stats.ms} ms)`);
      for (const p of report.problems) console.log(`       ${p.level}: ${p.message}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
