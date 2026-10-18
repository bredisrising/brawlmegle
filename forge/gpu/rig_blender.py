"""
Rigs a textured character GLB with a Mixamo skeleton, headless in Blender:

    blender -b --factory-startup -P rig_blender.py -- in.glb landmarks.json out.glb

The input faces +x with +y up (glTF axes, like Tripo's models). landmarks.json holds the 2D body joints found on the
model sheet (landmarks.py). The sheet is a straight-on front A-pose, so the sheet's image plane lines up with the
mesh's front view: each joint lands on the mesh by matching the two bounding boxes, then gets its depth from the mesh
(halfway between the front and back surface there).

Skin weights come from Blender's bone heat, run on a watertight voxel-remeshed copy of the mesh (bone heat often fails
on generated meshes with holes and loose bits) and copied back to the real mesh. Any vertex left without weights
falls back to its nearest bone. The output is about 1 m tall, feet at y=0, with the "mixamorig:" bone names the game
looks up (src/director/skeletonPose.ts).
"""
import json
import math
import sys
import time

import bpy
import bmesh
from mathutils import Matrix, Vector, kdtree

argv = sys.argv[sys.argv.index("--") + 1 :]
IN_GLB, LANDMARKS, OUT_GLB = argv[:3]
opts = dict(zip(argv[3::2], argv[4::2]))
VOXEL = float(opts.get("--voxel", 0.008))  # proxy voxel size for a 1 m tall model
DEBUG_BLEND = opts.get("--debug")
STATIC_GLB = opts.get("--static")  # also write the oriented, normalized model without a skeleton
YAW = float(opts.get("--yaw", 0))  # degrees about +y (glTF up) that turn the generator's front to +x
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

# --- skin weights: bone heat on a watertight proxy, copied back --------------------------------------------------
proxy = body.copy()
proxy.data = body.data.copy()
proxy.name = "Proxy"
bpy.context.scene.collection.objects.link(proxy)
proxy.data.materials.clear()
rm = proxy.modifiers.new("remesh", "REMESH")
rm.mode = "VOXEL"
rm.voxel_size = VOXEL
rm.adaptivity = 0.0
bpy.ops.object.select_all(action="DESELECT")
proxy.select_set(True)
bpy.context.view_layer.objects.active = proxy
bpy.ops.object.modifier_apply(modifier="remesh")
if len(proxy.data.polygons) > PROXY_FACES:
    dec = proxy.modifiers.new("dec", "DECIMATE")
    dec.ratio = PROXY_FACES / len(proxy.data.polygons)
    bpy.ops.object.modifier_apply(modifier="dec")
# Bone heat's solver fails for every bone if the mesh has degenerate faces, loose verts or extra pieces (the
# remesh leaves small floaters): clean up and keep only the body.
bm = bmesh.new()
bm.from_mesh(proxy.data)
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
bmesh.ops.delete(bm, geom=[v for piece in pieces[1:] for v in piece], context="VERTS")
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
bm.to_mesh(proxy.data)
bm.free()
mark("proxy")
proxy_faces = len(proxy.data.polygons)
if DEBUG_BLEND:
    bpy.ops.wm.save_as_mainfile(filepath=DEBUG_BLEND)

bpy.ops.object.select_all(action="DESELECT")
proxy.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type="ARMATURE_AUTO")
mark("bone_heat")
heat = {g.index: 0 for g in proxy.vertex_groups}
for v in proxy.data.vertices:
    for g in v.groups:
        if g.weight > 1e-3:
            heat[g.group] += 1
heat_empty = [g.name for g in proxy.vertex_groups if heat[g.index] == 0]
heat_unweighted = sum(1 for v in proxy.data.vertices if sum(g.weight for g in v.groups) < 1e-4)

# Copy weights to the real mesh: each vertex takes the weights of the nearest proxy surface point.
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
for b in arm_data.bones:
    if not body.vertex_groups.get(b.name):
        body.vertex_groups.new(name=b.name)
bpy.ops.object.datalayout_transfer(modifier="weights")
bpy.ops.object.modifier_apply(modifier="weights")
mark("transfer")

# Vertices bone heat missed: give them to the nearest bone segment.
bones = [(b.name, b.head_local.copy(), b.tail_local.copy()) for b in arm_data.bones if not b.name.endswith("ToeBase")]


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-12)))
    return (p - (a + ab * t)).length


groups = {g.index: g for g in body.vertex_groups}
orphans = 0
for v in body.data.vertices:
    if sum(g.weight for g in v.groups) > 1e-4:
        continue
    orphans += 1
    name = min(bones, key=lambda b: seg_dist(v.co, b[1], b[2]))[0]
    body.vertex_groups[name].add([v.index], 1.0, "REPLACE")
bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
mark("cleanup")

bpy.data.objects.remove(proxy, do_unlink=True)
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
print("RIG_RESULT " + json.dumps({"timings": marks, "verts": len(body.data.vertices), "proxy_faces": proxy_faces, "orphans": orphans, "turned": turned, "toe_lead": round(toe_lead, 4), "heat_empty": heat_empty, "heat_unweighted": heat_unweighted, "height_in": round(height, 4)}))
