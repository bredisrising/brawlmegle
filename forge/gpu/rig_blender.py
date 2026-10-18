"""
Rigs a textured character GLB with a Mixamo skeleton, headless in Blender:

    blender -b --factory-startup -P rig_blender.py -- in.glb landmarks.json out.glb

The input faces +x with +y up (glTF axes, like Tripo's models). landmarks.json holds the 2D body joints found on the
model sheet (landmarks.py). The sheet is a straight-on front A-pose, so the sheet's image plane lines up with the
mesh's front view: each joint lands on the mesh by matching the two bounding boxes, then gets its depth from the mesh
(halfway between the front and back surface there).

Skin weights come from Blender's bone heat, run on a watertight solid proxy of the mesh (bone heat often fails on
generated meshes with holes and loose bits) and copied back to the real mesh. Every result is checked (rig_check.py:
each limb owned by its bones, no bone owning the mesh); a failed check moves on to the next way of weighting it:

1. "bone-heat": bone heat on an 8 mm voxel remesh of the mesh.
2. "bone-heat-retry": bone heat on a solid made by voxel flood fill. TRELLIS.2's meshes are hollow (a 2-3 mm
   double-walled shell), and when the remesh doesn't fill the inside it comes out as ~1,000 sub-voxel blobs, of which
   path 1 would keep one chest- or leg-sized patch (dylan, lamdestroyer, lampham). The flood fill closes small openings
   and fills whatever the outside can't reach, so it doesn't depend on that.
3. "envelope": distance to the fitted bone segments with a smooth falloff, each vertex limited to the bones of its
   own body part (and the joints next to it), then smoothed over the surface.

`--attempt 2` (the forge's re-rig after its own rig check turned the first rig down) goes straight to the envelope.
The result reports the path, every attempt and the check's numbers; `rig_ok: false` means even the last path failed.
The output is about 1 m tall, feet at y=0, with the "mixamorig:" bone names the game looks up
(src/director/skeletonPose.ts).
"""
import json
import math
import os
import sys
import time

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector, kdtree
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rig_check import CHAINS, blender_stats, seg_dist  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1 :]
IN_GLB, LANDMARKS, OUT_GLB = argv[:3]
opts = dict(zip(argv[3::2], argv[4::2]))
VOXEL = float(opts.get("--voxel", 0.008))  # proxy voxel size for a 1 m tall model
DEBUG_BLEND = opts.get("--debug")
STATIC_GLB = opts.get("--static")  # also write the oriented, normalized model without a skeleton
YAW = float(opts.get("--yaw", 0))  # degrees about +y (glTF up) that turn the generator's front to +x
ATTEMPT = int(opts.get("--attempt", 1))  # 2+: the forge's re-rig after its rig check failed: use the envelope
PROXY_FACES = 40000
t0 = time.time()
marks = {}


def mark(name):
    marks[name] = round(time.time() - t0, 2)


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=IN_GLB)
mark("import")

# --- one mesh, transforms applied, any old skeleton removed ---------------------------------------------------
for o in list(bpy.data.objects):
    if o.type not in {"MESH"}:
        continue
    if o.parent:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
for o in list(bpy.data.objects):
    if o.type != "MESH":
        bpy.data.objects.remove(o, do_unlink=True)
meshes = [o for o in bpy.data.objects if o.type == "MESH" and len(o.data.vertices) > 0]
if not meshes:
    raise SystemExit("no mesh in the input")
for o in meshes:
    o.modifiers.clear()
    o.vertex_groups.clear()
    if o.data.shape_keys:
        o.shape_key_clear()
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
if len(meshes) > 1:
    bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = "Body"
# Fighters are opaque: a generator's opacity channel would make the game sort them as glass (and break the outline).
for mat in body.data.materials:
    if not mat or not mat.node_tree:
        continue
    for node in mat.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            for link in list(node.inputs["Alpha"].links):
                mat.node_tree.links.remove(link)
            node.inputs["Alpha"].default_value = 1.0
    if hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "DITHERED"
    if hasattr(mat, "blend_method"):
        mat.blend_method = "OPAQUE"

# --- face +x ----------------------------------------------------------------------------------------------------
# Blender axes after the glTF import: +x should be the character's front, +y its left, +z up. YAW turns a generator's
# own convention into that; then two checks catch a model that still faces the wrong way: in an A-pose the arm
# span is wider than the body is deep, and the feet stick out in front of the shins.
def turn(deg):
    if deg % 360:
        body.data.transform(Matrix.Rotation(math.radians(deg), 4, "Z"))
        body.data.update()


turn(YAW)
co = [v.co.copy() for v in body.data.vertices]
span = lambda axis: max(c[axis] for c in co) - min(c[axis] for c in co)
turned = 0
if span(0) > span(1) * 1.15:
    turn(90)
    turned += 90
    co = [v.co.copy() for v in body.data.vertices]
zmin = min(c.z for c in co)
h = max(c.z for c in co) - zmin
feet = [c.x for c in co if c.z < zmin + 0.04 * h]
shins = [c.x for c in co if zmin + 0.12 * h < c.z < zmin + 0.2 * h]
toe_lead = (max(feet) - sum(shins) / len(shins)) - (sum(shins) / len(shins) - min(feet)) if feet and shins else 0.0
if toe_lead < -0.02 * h:
    turn(180)
    turned += 180
    co = [v.co.copy() for v in body.data.vertices]
mark("orient")

# --- normalize: 1 m tall, feet on the ground, centered ----------------------------------------------------------
lo = Vector((min(c.x for c in co), min(c.y for c in co), min(c.z for c in co)))
hi = Vector((max(c.x for c in co), max(c.y for c in co), max(c.z for c in co)))
height = hi.z - lo.z
scale = 1.0 / height
shift = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
for v in body.data.vertices:
    v.co = (v.co - shift) * scale
body.data.update()
co = [v.co.copy() for v in body.data.vertices]
mark("normalize")
if STATIC_GLB:
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.ops.export_scene.gltf(filepath=STATIC_GLB, export_format="GLB", use_selection=True, export_animations=False, export_yup=True)
    mark("static")

# --- joints: sheet landmarks -> mesh space ----------------------------------------------------------------------
with open(LANDMARKS) as f:
    lm = json.load(f)
x0, y0, x1, y1 = lm["bbox"]
px = 1.0 / (y1 - y0)  # meters per sheet pixel
cx = (x0 + x1) / 2
min_y = min(c.y for c in co)
max_y = max(c.y for c in co)
# The mesh's lateral center can differ from the sheet's when one arm is posed a little wider: match centers.
mesh_cy = (min_y + max_y) / 2

tree2d = kdtree.KDTree(len(co))
for i, c in enumerate(co):
    tree2d.insert((0.0, c.y, c.z), i)
tree2d.balance()


def depth_at(y, z, r=0.02):
    """Front-to-back middle of the mesh around (y, z) in the front view."""
    for radius in (r, r * 2, r * 4, r * 8):
        hits = tree2d.find_range((0.0, y, z), radius)
        if len(hits) >= 6:
            xs = [co[i].x for _, i, _ in hits]
            return (min(xs) + max(xs)) / 2
    return 0.0


def landmark(name):
    p = lm["points"][name]
    y = (p[0] - cx) * px + mesh_cy
    z = (y1 - p[1]) * px
    return Vector((depth_at(y, z), y, z))


J = {k: landmark(k) for k in ["lS", "rS", "lE", "rE", "lW", "rW", "lH", "rH", "lK", "rK", "lA", "rA", "nose", "lEar", "rEar"]}


def at(y, z, r=0.02):
    return Vector((depth_at(y, z, r), y, z))


hip_c = (J["lH"] + J["rH"]) / 2
sh_c = (J["lS"] + J["rS"]) / 2
ear_c = (J["lEar"] + J["rEar"]) / 2
neck = at(sh_c.y, sh_c.z + 0.01)
hips = at(hip_c.y, hip_c.z)
spine = [at(hips.y + (neck.y - hips.y) * t, hips.z + (neck.z - hips.z) * t, 0.03) for t in (0.12, 0.42, 0.72)]
head = at(neck.y + (ear_c.y - neck.y) * 0.45, neck.z + (ear_c.z - neck.z) * 0.45)
top_z = max(c.z for c in co)
head_top = Vector((head.x, head.y, top_z))


def foot(side):
    a = J[side + "A"]
    near = [c for c in co if c.z < a.z + 0.02 and abs(c.y - a.y) < 0.07]
    toe_x = max((c.x for c in near), default=a.x + 0.08)
    ball = Vector((a.x + (toe_x - a.x) * 0.65, a.y, max(0.015, a.z * 0.3)))
    tip = Vector((toe_x, a.y, max(0.01, a.z * 0.2)))
    return ball, tip


def hand_end(side):
    e, w = J[side + "E"], J[side + "W"]
    return w + (w - e).normalized() * max(0.04, (w - e).length * 0.45)


mark("joints")

# --- armature (Mixamo names and hierarchy) ----------------------------------------------------------------------
arm_data = bpy.data.armatures.new("Armature")
rig = bpy.data.objects.new("Armature", arm_data)
bpy.context.scene.collection.objects.link(rig)
bpy.ops.object.select_all(action="DESELECT")
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
eb = arm_data.edit_bones
P = "mixamorig:"


def bone(name, head_pt, tail_pt, parent=None, connect=False):
    b = eb.new(P + name)
    b.head = head_pt
    b.tail = tail_pt if (tail_pt - head_pt).length > 1e-4 else head_pt + Vector((0, 0, 0.02))
    if parent:
        b.parent = eb[P + parent]
        b.use_connect = connect
    return b


bone("Hips", hips, spine[0])
bone("Spine", spine[0], spine[1], "Hips", True)
bone("Spine1", spine[1], spine[2], "Spine", True)
bone("Spine2", spine[2], neck, "Spine1", True)
bone("Neck", neck, head, "Spine2", True)
bone("Head", head, head_top, "Neck", True)
for side, s in (("Left", "l"), ("Right", "r")):
    sh = J[s + "S"]
    clav = neck + Vector((0, (sh.y - neck.y) * 0.25, -0.005))
    bone(side + "Shoulder", clav, sh, "Spine2")
    bone(side + "Arm", sh, J[s + "E"], side + "Shoulder", True)
    bone(side + "ForeArm", J[s + "E"], J[s + "W"], side + "Arm", True)
    bone(side + "Hand", J[s + "W"], hand_end(s), side + "ForeArm", True)
    ball, tip = foot(s)
    bone(side + "UpLeg", J[s + "H"], J[s + "K"], "Hips")
    bone(side + "Leg", J[s + "K"], J[s + "A"], side + "UpLeg", True)
    bone(side + "Foot", J[s + "A"], ball, side + "Leg", True)
    bone(side + "ToeBase", ball, tip, side + "Foot", True)
# Rolls: every bone's local z points forward (+x), like a front-facing T/A-pose rig.
for b in eb:
    b.align_roll(Vector((1, 0, 0)) if abs((b.tail - b.head).normalized().x) < 0.9 else Vector((0, 0, 1)))
bpy.ops.object.mode_set(mode="OBJECT")
mark("armature")

# --- skin weights: bone heat on a solid proxy, checked, with fallbacks (see the top) ------------------------------
BONES = [b.name for b in arm_data.bones]
SEGMENTS = [(b.name, b.head_local.copy(), b.tail_local.copy()) for b in arm_data.bones]


def body_points():
    pts = np.empty(len(body.data.vertices) * 3)
    body.data.vertices.foreach_get("co", pts)
    return pts.reshape(-1, 3)


def link_new(name, mesh):
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def apply_modifier(obj, mod):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)


def keep_largest(obj):
    """Bone heat's solver fails for every bone if the mesh has degenerate faces, loose verts or extra pieces (the
    remesh leaves small floaters): clean up and keep only the biggest piece. Returns (pieces, share of faces kept)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-5)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.verts.ensure_lookup_table()
    seen = set()
    pieces = []
    for v in bm.verts:
        if v.index in seen:
            continue
        seen.add(v.index)
        stack, piece = [v], []
        while stack:
            x = stack.pop()
            piece.append(x)
            for e in x.link_edges:
                o = e.other_vert(x)
                if o.index not in seen:
                    seen.add(o.index)
                    stack.append(o)
        pieces.append(piece)
    pieces.sort(key=len, reverse=True)
    total_faces = len(bm.faces)
    bmesh.ops.delete(bm, geom=[v for piece in pieces[1:] for v in piece], context="VERTS")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    kept = len(bm.faces) / max(1, total_faces)
    bm.to_mesh(obj.data)
    bm.free()
    return len(pieces), round(kept, 3)


def remesh_proxy(src_mesh, voxel):
    """A watertight voxel remesh of src_mesh, decimated for bone heat, biggest piece only."""
    proxy = link_new("Proxy", src_mesh.copy())
    proxy.data.materials.clear()
    rm = proxy.modifiers.new("remesh", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = voxel
    rm.adaptivity = 0.0
    apply_modifier(proxy, rm)
    remeshed = len(proxy.data.polygons)
    if remeshed > PROXY_FACES:
        dec = proxy.modifiers.new("dec", "DECIMATE")
        dec.ratio = PROXY_FACES / remeshed
        apply_modifier(proxy, dec)
    pieces, kept = keep_largest(proxy)
    return proxy, {"voxel": voxel, "proxy_faces": len(proxy.data.polygons), "pieces": pieces, "kept": kept}


def dilate(a, n):
    for _ in range(n):
        b = a.copy()
        for ax in range(3):
            b |= np.roll(a, 1, ax) | np.roll(a, -1, ax)
        a = b
    return a


def erode(a, n):
    for _ in range(n):
        b = a.copy()
        for ax in range(3):
            b &= np.roll(a, 1, ax) & np.roll(a, -1, ax)
        a = b
    return a


def solid_mesh(voxel, close):
    """The body as a solid, independent of whether the shell is hollow or open: the surface goes into a voxel grid,
    thickened by `close` voxels to seal openings up to ~2 * close voxels wide, then everything the outside can't
    reach is solid; the thickening comes off again. Returns the solid's voxel faces as a closed mesh."""
    pts = body_points()
    me = body.data
    me.calc_loop_triangles()
    tri = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
    me.loop_triangles.foreach_get("vertices", tri)
    tri = tri.reshape(-1, 3)
    a, b, c = pts[tri[:, 0]], pts[tri[:, 1]], pts[tri[:, 2]]
    # Surface samples no more than half a voxel apart, so every voxel the surface passes through gets one.
    longest = np.maximum(np.maximum(np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1)), np.linalg.norm(a - c, axis=1))
    steps = np.clip(np.ceil(longest / (voxel * 0.5)).astype(int), 1, 64)
    samples = [pts]
    for n in np.unique(steps):
        m = steps == n
        A, AB, AC = a[m], b[m] - a[m], c[m] - a[m]
        for i in range(n + 1):
            for j in range(n + 1 - i):
                samples.append(A + AB * (i / n) + AC * (j / n))
    samples = np.concatenate(samples)
    pad = close + 2
    lo = samples.min(axis=0) - pad * voxel
    ijk = np.floor((samples - lo) / voxel).astype(int)
    shape = tuple(ijk.max(axis=0) + pad + 1)
    occ = np.zeros(shape, dtype=bool)
    occ[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True
    wall = dilate(occ, close)
    outside = np.zeros(shape, dtype=bool)
    outside[0], outside[-1], outside[:, 0], outside[:, -1], outside[:, :, 0], outside[:, :, -1] = True, True, True, True, True, True
    outside &= ~wall
    while True:
        grown = dilate(outside, 1) & ~wall
        if grown.sum() == outside.sum():
            break
        outside = grown
    solid = erode(~outside, close) | occ
    # Voxel faces between solid and empty, wound outward (corners on the voxel grid, shared).
    S = np.pad(solid, 1)
    ny, nz = S.shape[1] + 1, S.shape[2] + 1
    quads = []
    for ax, (bx, cx) in ((0, (1, 2)), (1, (2, 0)), (2, (0, 1))):
        e_a, e_b, e_c = np.eye(3, dtype=np.int64)[ax], np.eye(3, dtype=np.int64)[bx], np.eye(3, dtype=np.int64)[cx]
        for sign in (1, -1):
            v = np.argwhere(S & ~np.roll(S, -sign, ax))
            if sign > 0:
                base = v + e_a
                corners = [base, base + e_b, base + e_b + e_c, base + e_c]
            else:
                corners = [v, v + e_c, v + e_b + e_c, v + e_b]
            quads.append(np.stack([(q[:, 0] * ny + q[:, 1]) * nz + q[:, 2] for q in corners], axis=1))
    quads = np.concatenate(quads)
    ids, inverse = np.unique(quads, return_inverse=True)
    corner = np.stack([ids // (ny * nz), (ids // nz) % ny, ids % nz], axis=1)
    verts = lo + (corner - 1) * voxel
    mesh = bpy.data.meshes.new("Solid")
    mesh.from_pydata(verts.tolist(), [], inverse.reshape(-1, 4).tolist())
    mesh.update()
    return mesh, {"close": close, "solid_voxels": int(solid.sum()), "shell_voxels": int(occ.sum())}


def proxy_cover(proxy, tol):
    """Share of the body's vertices within tol of the proxy's surface: a proxy that lost a limb or broke into
    blobs (of which only one was kept) leaves most of the body far away."""
    me = proxy.data
    tree = BVHTree.FromPolygons([v.co for v in me.vertices], [p.vertices[:] for p in me.polygons])
    near = 0
    for v in body.data.vertices:
        hit = tree.find_nearest(v.co, tol)
        near += hit[0] is not None
    return round(near / max(1, len(body.data.vertices)), 3)


def reset_groups():
    body.vertex_groups.clear()
    for name in BONES:
        body.vertex_groups.new(name=name)


def finish_weights():
    """Vertices left without weights go to the nearest bone segment, then at most 4 bones each, summing to 1."""
    segs = [s for s in SEGMENTS if not s[0].endswith("ToeBase")]
    pts = body_points()
    dist = np.stack([seg_dist(pts, np.array(s[1]), np.array(s[2])) for s in segs], axis=1)
    orphans = 0
    for v in body.data.vertices:
        if sum(g.weight for g in v.groups) > 1e-4:
            continue
        orphans += 1
        body.vertex_groups[segs[int(dist[v.index].argmin())][0]].add([v.index], 1.0, "REPLACE")
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    return orphans


def heat_weights(proxy):
    """Bone heat on the proxy, copied to the body: each vertex takes the weights of the nearest proxy surface point."""
    bpy.ops.object.select_all(action="DESELECT")
    proxy.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    heat = {g.index: 0 for g in proxy.vertex_groups}
    for v in proxy.data.vertices:
        for g in v.groups:
            if g.weight > 1e-3:
                heat[g.group] += 1
    empty = [g.name for g in proxy.vertex_groups if heat[g.index] == 0]
    unweighted = sum(1 for v in proxy.data.vertices if sum(g.weight for g in v.groups) < 1e-4)
    reset_groups()
    dt = body.modifiers.new("weights", "DATA_TRANSFER")
    dt.object = proxy
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "POLYINTERP_NEAREST"
    dt.layers_vgroup_select_src = "ALL"
    dt.layers_vgroup_select_dst = "NAME"
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.datalayout_transfer(modifier="weights")
    bpy.ops.object.modifier_apply(modifier="weights")
    return {"heat_empty": empty, "heat_unweighted": unweighted, "orphans": finish_weights()}


# Envelope: which bones a vertex may take weight from, by the body part its nearest bone is in: that part's bones
# plus the joint it hangs from (a hand next to the thigh never takes thigh weight).
ENVELOPE_SIGMA = 0.02  # m on a 1 m model: how far past the nearest bone a neighbor still pulls
JOINS = {
    "spine": ["Neck", "LeftShoulder", "RightShoulder", "LeftArm", "RightArm", "LeftUpLeg", "RightUpLeg"],
    "head": ["Spine2"],
    "armL": ["Spine2"],
    "armR": ["Spine2"],
    "legL": ["Hips"],
    "legR": ["Hips"],
}


def envelope_weights():
    pts = body_points()
    names = [s[0][len(P):] for s in SEGMENTS]
    dist = np.stack([seg_dist(pts, np.array(s[1]), np.array(s[2])) for s in SEGMENTS], axis=1)
    chain_names = list(CHAINS)
    chain_of = {b: ci for ci, c in enumerate(chain_names) for b in CHAINS[c]}
    allowed = np.zeros((len(chain_names), len(names)), dtype=bool)
    for ci, c in enumerate(chain_names):
        for j, nm in enumerate(names):
            allowed[ci, j] = nm in CHAINS[c] or nm in JOINS[c]
    nearest = dist.argmin(axis=1)
    mask = allowed[np.array([chain_of[names[j]] for j in nearest])]
    w = np.exp(-(((dist - dist.min(axis=1, keepdims=True)) / ENVELOPE_SIGMA) ** 2)) * mask
    # Smooth over the surface (UV seams split vertices, so weld by position first) to soften the joints.
    key = np.round(pts / 1e-5).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    weld = weld.reshape(-1)
    edges = np.empty(len(body.data.edges) * 2, dtype=np.int64)
    body.data.edges.foreach_get("vertices", edges)
    e = weld[edges.reshape(-1, 2)]
    e = e[e[:, 0] != e[:, 1]]
    n = weld.max() + 1
    wm = np.zeros((n, w.shape[1]))
    np.add.at(wm, weld, w)
    wm /= np.maximum(np.bincount(weld, minlength=n), 1)[:, None]
    deg = np.bincount(e.ravel(), minlength=n)[:, None]
    for _ in range(4):
        acc = np.zeros_like(wm)
        np.add.at(acc, e[:, 0], wm[e[:, 1]])
        np.add.at(acc, e[:, 1], wm[e[:, 0]])
        wm = np.where(deg > 0, 0.5 * wm + 0.5 * acc / np.maximum(deg, 1), wm)
    w = wm[weld] * mask
    w[w < 0.02 * w.max(axis=1, keepdims=True)] = 0
    w /= np.maximum(w.sum(axis=1, keepdims=True), 1e-9)
    reset_groups()
    groups = [body.vertex_groups[s[0]] for s in SEGMENTS]
    for i in range(len(pts)):
        for j in np.argsort(w[i])[::-1][:4]:
            if w[i, j] > 0:
                groups[j].add([i], float(w[i, j]), "REPLACE")
    return {"orphans": finish_weights()}


def check_weights():
    out = blender_stats(body, rig)
    out.pop("dominant", None)
    return out


COVER_MIN = 0.95  # share of the body within 3 voxels of the proxy
KEPT_MIN = 0.8  # share of the remesh in its biggest piece


def solid_proxy(close):
    mesh, info = solid_mesh(VOXEL, close)
    proxy, pinfo = remesh_proxy(mesh, VOXEL)
    bpy.data.meshes.remove(mesh)
    return proxy, info | pinfo


attempts = []
result = None
plan = [] if ATTEMPT > 1 else [("bone-heat", lambda: remesh_proxy(body.data, VOXEL))] + [("bone-heat-retry", lambda c=c: solid_proxy(c)) for c in (1, 2)]

for path, make in plan:
    start = time.time()
    proxy, info = make()
    info["cover"] = proxy_cover(proxy, 3 * VOXEL)
    entry = {"path": path} | info
    if DEBUG_BLEND:
        bpy.ops.wm.save_as_mainfile(filepath=DEBUG_BLEND.replace(".blend", f"-{len(attempts) + 1}.blend"))
    if info["cover"] < COVER_MIN or info["kept"] < KEPT_MIN:
        entry |= {"ok": False, "fails": [f"proxy covers {info['cover']} of the body, biggest piece {info['kept']} of {info['pieces']}"]}
    else:
        entry |= heat_weights(proxy)
        check = check_weights()
        entry |= {"ok": check["ok"], "fails": check["fails"]}
        if check["ok"]:
            result = (path, check)
    bpy.data.objects.remove(proxy, do_unlink=True)
    entry["s"] = round(time.time() - start, 2)
    attempts.append(entry)
    if result:
        break
if not result:
    start = time.time()
    entry = {"path": "envelope"} | envelope_weights()
    check = check_weights()
    entry |= {"ok": check["ok"], "fails": check["fails"], "s": round(time.time() - start, 2)}
    attempts.append(entry)
    result = ("envelope", check)
    if not check["ok"]:
        print("RIG_WARNING the envelope weights failed the check too:", check["fails"])
rig_path, rig_check = result
mark("skin")
mod = body.modifiers.new("Armature", "ARMATURE")
mod.object = rig
body.parent = rig

bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
rig.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB,
    export_format="GLB",
    use_selection=True,
    export_skins=True,
    export_animations=False,
    export_morph=False,
    export_yup=True,
    export_apply=False,
)
mark("export")
last = attempts[-1]
print("RIG_RESULT " + json.dumps({
    "timings": marks, "verts": len(body.data.vertices), "turned": turned, "toe_lead": round(toe_lead, 4), "height_in": round(height, 4),
    "rig": rig_path, "rig_ok": rig_check["ok"], "attempt": ATTEMPT, "attempts": attempts, "check": rig_check,
    # The old fields, from the path that made the rig.
    "proxy_faces": last.get("proxy_faces", 0), "orphans": last.get("orphans", 0), "heat_empty": last.get("heat_empty", []),
    "heat_unweighted": last.get("heat_unweighted", 0),
}))
