"""Build editable PS2-style assets. Run in Blender's Text Editor or with --python.

Creates a new scene; existing scenes are preserved. Never exports a production GLB.
"""
from pathlib import Path
import math
import random
import importlib.util
import bpy
from mathutils import Vector

HERE = Path(globals().get("ASSET_DIRECTORY", Path(__file__).resolve().parent))
SEED = 2406
SCENE_NAME = "Floating Island - PS2"
PALETTE = [
    ("earth_umber", "493f43"), ("earth_dark", "55484c"),
    ("earth_mid", "715957"), ("earth_light", "8a6d60"),
    ("earth_warm", "a38267"), ("earth_gold", "b69973"),
    ("trail_dark", "b49b74"), ("trail_light", "d1ba8a"),
    ("grass_dark", "446952"), ("grass_mid", "5f8258"),
    ("grass_light", "7b9c60"), ("grass_sun", "98ad70"),
    ("pine_dark", "294e48"), ("pine_mid", "37685a"),
    ("pine_light", "56826a"), ("pine_tip", "7c9b77"),
    ("bark_dark", "514137"), ("bark_mid", "775b43"),
    ("bark_cut", "bb996d"), ("rock_dark", "505d71"),
    ("rock_mid", "69798a"), ("rock_light", "8d9ca4"),
    ("mountain_shadow", "637793"), ("mountain_light", "889cb2"),
    ("snow_shadow", "9db9cc"), ("snow_mid", "c2d8df"),
    ("snow_light", "e1ece5"), ("snow_sun", "f4f0da"),
    ("flower_gold", "edc26b"), ("flower_cream", "f1deac"),
    ("flower_lilac", "ac94bd"), ("moss", "8b9970"),
]


def set_enum(owner, key, candidates):
    """Read RNA enums before selecting values (engines have dynamic enums)."""
    prop = owner.bl_rna.properties[key]
    valid = {item.identifier for item in prop.enum_items}
    for value in candidates:
        if value in valid:
            setattr(owner, key, value)
            return value
    # OCIO exposes only NONE via static RNA; assignment resolves dynamic items.
    for value in candidates:
        try:
            setattr(owner, key, value)
            return value
        except (TypeError, ValueError):
            pass
    raise RuntimeError(f"No supported {key}: {sorted(valid)}")


def eevee(scene):
    # Engine RNA can under-report registered renderers; try version-compatible IDs.
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = engine
            return
        except (TypeError, ValueError):
            pass
    raise RuntimeError("This Blender installation has no Eevee renderer")


def collection(name, parent):
    result = bpy.data.collections.new(name)
    parent.children.link(result)
    return result


def empty(name, coll):
    obj = bpy.data.objects.new(name, None)
    coll.objects.link(obj)
    return obj


def atlas():
    width, height, tile = 128, 64, 16
    image = bpy.data.images.new("PS2_Palette_128x64", width=width, height=height, alpha=False)
    rng = random.Random(SEED)
    pixels = []
    for y in range(height):
        for x in range(width):
            index = (y // tile) * 8 + x // tile
            color = tuple(int(PALETTE[index][1][i:i + 2], 16) / 255 for i in (0, 2, 4))
            # Restrained two-pixel grain: baked pixels, no procedural shader dependency.
            dither = (((x % 2) ^ (y % 2)) - 0.5) * 0.035
            grain = rng.choice((-0.018, 0.0, 0.0, 0.018))
            pixels.extend([max(0, min(1, c + dither + grain)) for c in color] + [1])
    image.pixels.foreach_set(pixels)
    image.filepath_raw = str(HERE / "textures" / "ps2_palette.png")
    set_enum(image, "file_format", ("PNG",))
    image.save()
    image.pack()
    image.filepath_raw = "//textures/ps2_palette.png"
    material = bpy.data.materials.new("PS2 - pixel palette (opaque)")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    shader = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    shader.inputs["Roughness"].default_value = 1
    shader.inputs["Metallic"].default_value = 0
    if "Specular IOR Level" in shader.inputs:
        shader.inputs["Specular IOR Level"].default_value = 0.12
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    set_enum(texture, "interpolation", ("Closest",))
    material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    return material


def mesh(name, verts, faces, colors, coll, parent, material):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    coll.objects.link(obj)
    obj.parent = parent
    data.materials.append(material)
    uv = data.uv_layers.new(name="PaletteUV")
    for poly, color in zip(data.polygons, colors):
        col, row = color % 8, color // 8
        # Stay 3 texels inside each swatch so mipmaps don't bleed adjacent colors.
        for j, loop in enumerate(poly.loop_indices):
            angle = 2 * math.pi * j / len(poly.loop_indices)
            uv.data[loop].uv = ((col + 0.5 + 0.3 * math.cos(angle)) / 8,
                                (row + 0.5 + 0.3 * math.sin(angle)) / 4)
        poly.use_smooth = False
    return obj












def make_rainier(coll, root, material):
    """Art-directed radial ridges, glacier fingers and a broad double summit.

    A stylized silhouette reference, not surveyed geographic terrain / a DEM.
    Local footprint ~20 x 16, height ~8; origin is centered at the base.
    """
    rng = random.Random(SEED + 2)
    sides = 48
    # radius, nominal height. Closely spaced high rings form a rounded summit.
    rings = [(1.0, 0), (.84, .65), (.65, 1.8), (.48, 3.3),
             (.34, 4.9), (.24, 6.25), (.17, 7.2), (.105, 7.65)]
    verts = []
    for k, (radius, z) in enumerate(rings):
        for i in range(sides):
            a = i * math.tau / sides
            ridge = .065 * math.cos(a * 9 + .3) + .035 * math.sin(a * 5)
            r = radius * (1 + ridge + rng.uniform(-.018, .018))
            # Summit shifts east; a west shoulder evokes Liberty Cap.
            x = 10.0 * r * math.cos(a) + (1 - radius) * .75
            y = 8.0 * r * math.sin(a) + (1 - radius) * .10
            shoulder = .6 * math.exp(-((a - math.pi) / .50) ** 2) if k in (4, 5, 6) else 0
            relief = (0.15 + .3 * math.sin(a * 9 + .3)) * math.sin(radius * math.pi)
            verts.append((x, y, z + shoulder + relief + rng.uniform(-.06, .06)))
    # Summit snow basin, deliberately shallow (no pointed cone).
    verts.append((.82, .08, 7.60))
    faces, colors = [], []
    for k in range(len(rings) - 1):
        for i in range(sides):
            j = (i + 1) % sides
            a, b = k * sides, (k + 1) * sides
            faces.extend(((a + i, a + j, b + j), (a + i, b + j, b + i)))
            angle = (i + .5) * math.tau / sides
            # Snow tongues run down valleys between dark exposed cleavers.
            glacier = math.cos(angle * 9 + .3) < -.08
            snowy = k >= 4 or (k >= 2 and glacier) or (k == 1 and math.cos(angle * 5) < -.8)
            if snowy:
                swatches = (24, 25, 26, 26, 27) if k >= 4 else (24, 24, 25, 26)
            else:
                swatches = (19, 20, 22, 23) if k >= 2 else (19, 20, 21, 22)
            colors.extend(rng.choices(swatches, k=2))
    last = (len(rings) - 1) * sides
    for i in range(sides):
        faces.append((last + i, last + (i + 1) % sides, len(verts) - 1))
        colors.append(rng.choice((25, 26, 27)))
    # Closed underside, invisible in normal views but useful when exporting.
    faces.append(tuple(reversed(range(sides))))
    colors.append(19)
    obj = mesh("Mount Rainier - glacier ridges and summit", verts, faces, colors, coll, root, material)
    obj["description"] = "Stylized Mount Rainier; broad summit, Liberty Cap shoulder, radiating glaciers. Not surveyed terrain."
    return obj


def point_at(obj, point):
    obj.rotation_euler = (Vector(point) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def preview_setup(scene, coll, rainier_only=False):
    eevee(scene)
    if hasattr(scene, "eevee"):
        for key, value in (("use_gtao", True), ("gtao_distance", 3), ("gtao_factor", 1.12), ("taa_render_samples", 96)):
            if hasattr(scene.eevee, key):
                setattr(scene.eevee, key, value)
    world = bpy.data.worlds.new(scene.name + " - sky")
    world.use_nodes = True
    background = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    background.inputs["Color"].default_value = (.19, .29, .37, 1)
    background.inputs["Strength"].default_value = .7
    scene.world = world
    for name, energy, color, location, kind, size in (
        ("Key - afternoon sun", 3.0, (1.0, .86, .67), (-10, -12, 20), "SUN", 0),
        ("Fill - cool sky", 1800, (.61, .79, 1.0), (7, -4, 12), "AREA", 12),
        ("Rim - mountain light", 2200, (1.0, .88, .72), (-5, 10, 16), "AREA", 10),
    ):
        data = bpy.data.lights.new(name, type=kind)
        data.energy, data.color = energy, color
        if kind == "AREA":
            data.size = size
        elif hasattr(data, "angle"):
            data.angle = math.radians(8)
        obj = bpy.data.objects.new(name, data)
        coll.objects.link(obj)
        obj.location = location
        point_at(obj, (0, 0, 0))
    data = bpy.data.cameras.new("Preview camera")
    cam = bpy.data.objects.new("Preview camera", data)
    coll.objects.link(cam)
    cam.location = (15, -42, 27) if not rainier_only else (16, -29, 17)
    point_at(cam, (0, 8, 1) if not rainier_only else (0, 0, 2.8))
    set_enum(data, "type", ("ORTHO",))
    data.ortho_scale = 40 if not rainier_only else 26
    data.lens = 45
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y = (1400, 1100) if not rainier_only else (1200, 1000)
    scene.render.resolution_percentage = 100
    set_enum(scene.render.image_settings, "file_format", ("PNG",))
    set_enum(scene.view_settings, "view_transform", ("Standard",))
    set_enum(scene.view_settings, "look", ("None", "Medium High Contrast"))


def main():
    HERE.mkdir(parents=True, exist_ok=True)
    (HERE / "textures").mkdir(exist_ok=True)
    if bpy.data.scenes.get(SCENE_NAME):
        raise RuntimeError("The island scene already exists. Rename it before rebuilding to preserve your edits.")
    scene = bpy.data.scenes.new(SCENE_NAME)
    if bpy.context.window:
        bpy.context.window.scene = scene
    material = atlas()
    spec = importlib.util.spec_from_file_location('rocky_platform', HERE / 'rocky_platform.py')
    rocky = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rocky)
    asset, root = rocky.build(globals(), scene, material)
    root["style"] = "PS2-inspired, flat normals, nearest-filtered 128x64 atlas"
    preview_setup(scene, collection("PREVIEW - cameras and lights", scene.collection))
    scene["export_collection"] = asset.name
    scene["export_filename"] = "floating_island.glb"
    scene["asset_directory"] = str(HERE)
    # Independent scene with full proportions, ready for separate inspection/export.
    mountain_scene = bpy.data.scenes.new("Mount Rainier - PS2")
    mountain_asset = collection("EXPORT - Mount Rainier", mountain_scene.collection)
    mountain_root = empty("MountRainier", mountain_asset)
    mountain_root["asset"] = "mount_rainier"
    make_rainier(mountain_asset, mountain_root, material)
    preview_setup(mountain_scene, collection("PREVIEW - Rainier studio", mountain_scene.collection), True)
    mountain_scene["export_collection"] = mountain_asset.name
    mountain_scene["export_filename"] = "mount_rainier.glb"
    mountain_scene["asset_directory"] = str(HERE)
    # Store export code in the .blend for a self-contained Text Editor workflow.
    for filename in ("create_scene.py", "rocky_platform.py", "export_glb.py"):
        path = HERE / filename
        if path.exists():
            text = bpy.data.texts.new(filename)
            text.write(path.read_text(encoding="utf-8"))
            text.filepath = str(path)
    if bpy.context.window:
        bpy.context.window.scene = mountain_scene
        for screen in bpy.data.screens:
            for area in screen.areas:
                if area.type == 'VIEW_3D':
                    space = area.spaces.active
                    space.region_3d.view_perspective = 'CAMERA'
                    space.region_3d.view_camera_zoom = 20
                    space.region_3d.view_camera_offset = (0, 0)
                    space.overlay.show_overlays = False
                    space.shading.type = 'RENDERED'
    bpy.ops.wm.save_as_mainfile(filepath=str(HERE / "mount_rainier.blend"))
    if bpy.context.window:
        bpy.context.window.scene = scene
    bpy.ops.wm.save_as_mainfile(filepath=str(HERE / "floating_island.blend"))
    meshes = [o for o in asset.all_objects if o.type == 'MESH']
    triangles = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
    print(f"Created {len(meshes)} island meshes / {triangles} triangles; atlas 128x64; {scene.render.engine}")
    print(f"Saved editable assets in {HERE}; no production GLB exported.")


if __name__ == "__main__":
    main()
