"""
Skin-weight sanity check for a Mixamo-rigged fighter. rig_blender.py runs it after skinning; on its own it checks
rigged GLBs:

    blender -b --factory-startup -P rig_check.py -- rigged.glb [more.glb ...]     (prints RIG_CHECK {json} per file)

Each vertex has a dominant bone (its biggest weight). The check compares that against plain geometry: the bone
segment nearest the vertex, which is where its weight should mostly come from on an A-pose body.

- shares: per chain (spine, head, both arms, both legs), the fraction of vertices whose dominant bone is in it,
  next to the fraction geometry gives it ("expected").
- coverage: per limb bone (Arm, ForeArm, Hand, UpLeg, Leg, Foot, Head), of the vertices clearly nearest that bone,
  the fraction whose dominant bone is it, its parent or its child. A limb that won't move with its bone scores ~0.
- top: the bone that dominates the most vertices, its share, and the share geometry gives it.

It fails (ok: false) when a limb bone's coverage is below MIN_COVERAGE, a chain gets less than MIN_SHARE of its
expected share, or one bone dominates more than MAX_TOP of the mesh and MAX_EXCESS more than geometry gives it (a
dense head can rightly hold most of the vertices).
"""
import numpy as np

P = "mixamorig:"
CHAINS = {
    "spine": ["Hips", "Spine", "Spine1", "Spine2"],
    "head": ["Neck", "Head"],
    "armL": ["LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand"],
    "armR": ["RightShoulder", "RightArm", "RightForeArm", "RightHand"],
    "legL": ["LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase"],
    "legR": ["RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"],
}
LIMBS = ["Head"] + [s + b for s in ("Left", "Right") for b in ("Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot")]
MIN_COVERAGE = 0.5
MIN_SHARE = 0.5
MAX_TOP = 0.4
MAX_EXCESS = 0.15


def seg_dist(pts, a, b):
    """Distance from each point (n x 3) to the segment a-b."""
    ab = b - a
    t = np.clip((pts - a) @ ab / max(float(ab @ ab), 1e-12), 0.0, 1.0)
    return np.linalg.norm(pts - (a + t[:, None] * ab), axis=1)


def rig_stats(pts, weights, bones):
    """
    pts: n x 3 vertex positions. weights: n x len(names) skin weights, columns in the order of `bones`.
    bones: list of (short name without "mixamorig:", head, tail, parent short name or None), same space as pts.
    """
    names = [b[0] for b in bones]
    idx = {n: i for i, n in enumerate(names)}
    parent = {b[0]: b[3] for b in bones}
    children = {}
    for n, p in parent.items():
        children.setdefault(p, []).append(n)
    pts = np.asarray(pts, dtype=np.float64)
    w = np.asarray(weights, dtype=np.float64)
    n = len(pts)
    dominant = np.where(w.max(axis=1) > 1e-4, w.argmax(axis=1), -1)
    # Geometry: the nearest bone segment (toes count as the foot: they're short and inside it).
    geo_bones = [b for b in bones if not b[0].endswith("ToeBase")]
    d = np.stack([seg_dist(pts, np.asarray(b[1], float), np.asarray(b[2], float)) for b in geo_bones], axis=1)
    order = np.argsort(d, axis=1)
    nearest = np.array([idx[geo_bones[i][0]] for i in order[:, 0]])
    chain_of = {b: c for c, bs in CHAINS.items() for b in bs}
    chain_idx = np.array([list(CHAINS).index(chain_of.get(nm, "spine")) for nm in names])
    geo_chain = chain_idx[nearest]
    dom_chain = np.where(dominant >= 0, chain_idx[np.maximum(dominant, 0)], -1)
    shares, expected = {}, {}
    for ci, c in enumerate(CHAINS):
        shares[c] = round(float((dom_chain == ci).sum()) / n, 4)
        expected[c] = round(float((geo_chain == ci).sum()) / n, 4)
    # "Clearly nearest": the nearest bone beats the nearest bone of any other chain by a margin.
    d_sorted = np.take_along_axis(d, order, axis=1)
    geo_chain_sorted = chain_idx[np.array([[idx[geo_bones[i][0]] for i in row] for row in order[:, :6]])]
    other = np.full(n, np.inf)
    for k in range(1, 6):
        m = (geo_chain_sorted[:, k] != geo_chain_sorted[:, 0]) & np.isinf(other)
        other[m] = d_sorted[m, k]
    clear = other > d_sorted[:, 0] + 0.015
    coverage = {}
    for limb in LIMBS:
        if limb not in idx:
            continue
        mine = (nearest == idx[limb]) & clear
        if mine.sum() < 20:
            continue
        ok_bones = {limb, parent.get(limb)} | set(children.get(limb, []))
        ok_idx = np.array([idx[b] for b in ok_bones if b in idx])
        coverage[limb] = round(float(np.isin(dominant[mine], ok_idx).sum()) / float(mine.sum()), 3)
    counts = np.bincount(dominant[dominant >= 0], minlength=len(names))
    top = int(counts.argmax())
    top_share = round(float(counts[top]) / n, 4)
    toe_to_foot = np.array([idx.get(nm.replace("ToeBase", "Foot"), i) for i, nm in enumerate(names)])
    top_expected = round(float((toe_to_foot[nearest] == toe_to_foot[top]).sum()) / n, 4)
    fails = []
    for limb, c in coverage.items():
        if c < MIN_COVERAGE:
            fails.append(f"{limb} coverage {c}")
    for c in CHAINS:
        if expected[c] > 0.03 and shares[c] < MIN_SHARE * expected[c]:
            fails.append(f"{c} share {shares[c]} (expected {expected[c]})")
    if top_share > MAX_TOP and top_share > top_expected + MAX_EXCESS:
        fails.append(f"{names[top]} dominates {top_share} (expected {top_expected})")
    missing = [l for l in LIMBS if l not in coverage]
    return {
        "ok": not fails,
        "fails": fails,
        "top": [names[top], top_share, top_expected],
        "coverage": coverage,
        "min_coverage": min(coverage.values()) if coverage else 0.0,
        "shares": shares,
        "expected": expected,
        "unweighted": int((dominant < 0).sum()),
        "no_coverage_data": missing,
        "dominant": {names[i]: int(c) for i, c in enumerate(counts) if c},
    }


def blender_stats(body, rig):
    """rig_stats for a Blender mesh object skinned to an armature object (world space)."""
    mw = body.matrix_world
    pts = np.array([tuple(mw @ v.co) for v in body.data.vertices])
    arm_bones = [b for b in rig.data.bones if b.name.startswith(P)]
    gi = {g.index: g.name for g in body.vertex_groups}
    col = {b.name: i for i, b in enumerate(arm_bones)}
    w = np.zeros((len(pts), len(arm_bones)))
    for v in body.data.vertices:
        for g in v.groups:
            c = col.get(gi.get(g.group))
            if c is not None:
                w[v.index, c] += g.weight
    rw = rig.matrix_world
    bones = []
    for b in arm_bones:
        head = rw @ b.head_local
        # The importer guesses leaf tails; for a bone with children the tail is the first child's head.
        kids = [c for c in b.children if c.name.startswith(P)]
        tail = rw @ (kids[0].head_local if len(kids) == 1 else b.tail_local)
        par = b.parent.name[len(P):] if b.parent and b.parent.name.startswith(P) else None
        bones.append((b.name[len(P):], tuple(head), tuple(tail), par))
    return rig_stats(pts, w, bones)


if __name__ == "__main__":
    import json
    import sys

    import bpy

    for path in sys.argv[sys.argv.index("--") + 1 :]:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=path)
        rig = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
        meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.vertex_groups]
        if not rig or not meshes:
            print("RIG_CHECK " + json.dumps({"file": path, "ok": False, "fails": ["no skinned mesh"]}))
            continue
        out = blender_stats(max(meshes, key=lambda o: len(o.data.vertices)), rig)
        print("RIG_CHECK " + json.dumps({"file": path, "verts": len(meshes[0].data.vertices)} | out))
