"""Export the current asset scene, or choose --asset island / rainier / backdrop / hills.

Blender Text Editor: open this script, select the desired scene, click Run Script.
CLI: blender -b floating_island.blend --python export_glb.py -- --asset island
Optional: --output /absolute/path/asset.glb
"""
from pathlib import Path
import argparse
import sys
import bpy

# Text Editor shortcut: use 'backdrop' for the placed distant mountain,
# 'rainier' for the standalone model, 'hills' for hills with scattered trees,
# or None for the current scene's asset.
DEFAULT_ASSET = None


def triangle_count(objects):
    """Count evaluated geometry, including live tree scatter and modifiers."""
    graph = bpy.context.evaluated_depsgraph_get()
    total = 0
    for obj in objects:
        if obj.type != 'MESH':
            continue
        if not obj.modifiers:
            total += sum(len(poly.vertices) - 2 for poly in obj.data.polygons)
            continue
        evaluated = obj.evaluated_get(graph)
        data = evaluated.to_mesh()
        try:
            total += sum(len(poly.vertices) - 2 for poly in data.polygons)
        finally:
            evaluated.to_mesh_clear()
    return total


def export_asset(asset=None, output=None):
    scenes = {"island": "Floating Island - PS2", "rainier": "Mount Rainier - PS2",
              "backdrop": "Floating Island - PS2", "hills": "Floating Island - PS2"}
    scene = bpy.data.scenes[scenes[asset]] if asset else bpy.context.scene
    collection_key, filename_key = {
        'backdrop': ('background_export_collection', 'background_export_filename'),
        'hills': ('hills_export_collection', 'hills_export_filename'),
    }.get(asset, ('export_collection', 'export_filename'))
    name = scene.get(collection_key)
    coll = bpy.data.collections.get(name or "")
    if coll is None:
        raise RuntimeError("Choose an asset scene with an export collection, or request island, rainier, backdrop or hills.")
    directory = Path(bpy.path.abspath("//")) if bpy.data.filepath else Path(scene["asset_directory"])
    filename = scene[filename_key]
    destination = Path(output).expanduser().resolve() if output else directory / "exports" / filename
    destination.parent.mkdir(parents=True, exist_ok=True)
    objects = [o for o in coll.all_objects if o.type in {"MESH", "EMPTY"}]
    if not any(o.type == 'MESH' for o in objects):
        raise RuntimeError("The export collection contains no meshes.")
    old_scene = bpy.context.window.scene
    old_active = bpy.context.view_layer.objects.active
    old_selected = list(bpy.context.selected_objects)
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        raise RuntimeError("Switch to Object Mode before exporting.")
    hidden = []
    mesh_backups = []
    selected_in_asset_scene = []
    active_in_asset_scene = None
    try:
        bpy.context.window.scene = scene
        selected_in_asset_scene = list(bpy.context.selected_objects)
        active_in_asset_scene = bpy.context.view_layer.objects.active
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects:
            hidden.append((obj, obj.hide_get(), obj.hide_viewport, obj.hide_select))
            obj.hide_set(False)
            obj.hide_viewport = False
            obj.hide_select = False
            obj.select_set(True)
            # The glTF exporter validates mesh data in place in some Blender
            # versions. Give it temporary copies so source geometry stays intact.
            if obj.type == 'MESH':
                original = obj.data
                temporary = original.copy()
                mesh_backups.append((obj, original, temporary))
                obj.data = temporary
        bpy.context.view_layer.objects.active = next(o for o in objects if o.type == 'MESH')
        # Filter version-specific optional settings using the installed operator RNA.
        properties = bpy.ops.export_scene.gltf.get_rna_type().properties
        args = dict(filepath=str(destination), use_selection=True, use_active_scene=True,
                    export_cameras=False, export_lights=False,
                    export_yup=True, export_apply=True,
                    export_normals=True, export_texcoords=True,
                    export_extras=False, export_animations=False)
        formats = {i.identifier for i in properties['export_format'].enum_items}
        # Blender 4.1's format callback returns no items through static RNA.
        # When it is dynamic, the export operator validates the GLB identifier.
        if formats and 'GLB' not in formats:
            raise RuntimeError("This Blender exporter does not support GLB")
        args['export_format'] = 'GLB'
        optional = {'export_image_format': 'AUTO', 'export_materials': 'EXPORT',
                    'export_all_influences': False}
        for key, value in optional.items():
            if key in properties:
                prop = properties[key]
                if prop.type != 'ENUM' or value in {i.identifier for i in prop.enum_items}:
                    args[key] = value
        result = bpy.ops.export_scene.gltf(**args)
        if 'FINISHED' not in result or not destination.is_file():
            raise RuntimeError(f"Export failed: {result}")
        triangles = triangle_count(objects)
        print(f"EXPORTED {destination} ({destination.stat().st_size:,} bytes, {triangles:,} triangles)")
        return destination
    finally:
        for obj, original, temporary in mesh_backups:
            obj.data = original
            bpy.data.meshes.remove(temporary)
        bpy.ops.object.select_all(action='DESELECT')
        for obj, was_hidden, viewport_hidden, select_locked in hidden:
            obj.hide_set(was_hidden)
            obj.hide_viewport = viewport_hidden
            obj.hide_select = select_locked
        for obj in selected_in_asset_scene:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = active_in_asset_scene
        bpy.context.window.scene = old_scene
        for obj in old_selected:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = old_active


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--asset', choices=('island', 'rainier', 'backdrop', 'hills'), default=DEFAULT_ASSET)
    parser.add_argument('--output')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    export_asset(args.asset, args.output)
