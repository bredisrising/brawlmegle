"""Bake edited island or hill shader colors and export a self-contained GLB.

Run in a separate Blender process, never over the live editing session:
  blender -b floating_island.blend --python bake_export_island.py -- \
      --output ../floating_island.glb
  blender -b floating_island.blend --python bake_export_island.py -- \
      --asset hills --output ../forested_hills.glb

capture_live_snapshot() can capture unsaved geometry, shaders, and painted images
through Blender MCP without changing the source objects or shader graphs.
"""
from array import array
from pathlib import Path
import argparse
import json
import math
import struct
import sys
import tempfile
import bpy
from mathutils import Vector


def enum(owner, property_name, candidates):
    available = {item.identifier for item in owner.bl_rna.properties[property_name].enum_items}
    for value in candidates:
        if value in available:
            setattr(owner, property_name, value)
            return value
    # Registered engines / OCIO enums can be absent from static RNA.
    for value in candidates:
        try:
            setattr(owner, property_name, value)
            return value
        except (TypeError, ValueError):
            pass
    raise RuntimeError(f'No supported {property_name}: {sorted(available)}')


def log(message):
    print('BAKE_STAGE ' + message, flush=True)


def signature(scene, collection):
    return {
        'scene': scene.name,
        'objects': [
            {'name': obj.name, 'type': obj.type,
             'matrix': [value for row in obj.matrix_world for value in row],
             'vertices': len(obj.data.vertices) if obj.type == 'MESH' else 0,
             'faces': len(obj.data.polygons) if obj.type == 'MESH' else 0,
             'modifiers': [
                 {'name': modifier.name, 'type': modifier.type,
                  'group': modifier.node_group.name if modifier.type == 'NODES' and modifier.node_group else None,
                  'settings': {key: value.name if isinstance(value, bpy.types.ID) else str(value)
                               for key, value in modifier.items()} if modifier.type == 'NODES' else {}}
                 for modifier in obj.modifiers
             ],
             'materials': [m.name if m else None for m in obj.data.materials] if obj.type == 'MESH' else []}
            for obj in sorted(collection.all_objects, key=lambda o: o.name)
        ],
    }


def working_copy(source_scene, source_collection, evaluate_modifiers=False, asset_label='Floating Island',
                 source_objects=None):
    """Copy just the target hierarchy, lights, and all in-memory image buffers."""
    scene = bpy.data.scenes.new(asset_label + ' - Bake Copy')
    scene.world = source_scene.world
    scene['bake_snapshot'] = True
    coll = bpy.data.collections.new('BAKE - ' + asset_label)
    scene.collection.children.link(coll)
    scene['export_collection'] = coll.name
    scene['source_collection'] = source_collection.name
    scene['evaluated_modifiers'] = evaluate_modifiers
    created = {'objects': [], 'meshes': [], 'materials': [], 'images': [], 'other_data': []}
    objects, materials, images = {}, {}, {}
    source_signature = signature(source_scene, source_collection)
    graph = bpy.context.evaluated_depsgraph_get() if evaluate_modifiers else None
    for obj in source_collection.all_objects if source_objects is None else source_objects:
        if obj.type not in {'MESH', 'EMPTY'}:
            continue
        duplicate = obj.copy()
        duplicate.name = obj.name + ' - Bake Copy'
        duplicate['source_name'] = obj.name
        coll.objects.link(duplicate)
        created['objects'].append(duplicate)
        objects[obj] = duplicate
        if obj.type == 'MESH':
            if evaluate_modifiers and obj.modifiers:
                evaluated = obj.evaluated_get(graph)
                duplicate.data = bpy.data.meshes.new_from_object(
                    evaluated, preserve_all_data_layers=True, depsgraph=graph)
                duplicate.modifiers.clear()
            else:
                duplicate.data = obj.data.copy()
            created['meshes'].append(duplicate.data)
            # Geometry Nodes can add source-tree materials to the evaluated mesh.
            for slot_index, material in enumerate(tuple(duplicate.data.materials)):
                if material is None:
                    raise RuntimeError(f'{obj.name} has an empty material slot')
                if material not in materials:
                    copied = material.copy()
                    copied['source_material'] = material.name
                    created['materials'].append(copied)
                    materials[material] = copied
                    if copied.use_nodes:
                        for node in copied.node_tree.nodes:
                            if node.type != 'TEX_IMAGE' or node.image is None:
                                continue
                            original_image = node.image
                            if original_image not in images:
                                width, height = original_image.size
                                if not original_image.has_data or width == 0 or height == 0:
                                    raise RuntimeError(f'Image {original_image.name} has no loaded pixels')
                                if original_image.source not in {'FILE', 'GENERATED'}:
                                    raise RuntimeError(f'Unsupported image source: {original_image.source}')
                                image = bpy.data.images.new(original_image.name + ' - Snapshot',
                                                            width=width, height=height,
                                                            alpha=True, float_buffer=original_image.is_float)
                                image.colorspace_settings.name = original_image.colorspace_settings.name
                                pixels = array('f', [0]) * len(original_image.pixels)
                                original_image.pixels.foreach_get(pixels)
                                image.pixels.foreach_set(pixels)
                                enum(image, 'file_format', ('PNG',))
                                image.pack()
                                images[original_image] = image
                                created['images'].append(image)
                            node.image = images[original_image]
                duplicate.data.materials[slot_index] = materials[material]
    for original, duplicate in objects.items():
        world = original.matrix_world.copy()
        duplicate.parent = objects.get(original.parent)
        duplicate.matrix_world = world
        for material in duplicate.data.materials if duplicate.type == 'MESH' else []:
            if not material.use_nodes:
                continue
            for node in material.node_tree.nodes:
                if node.type == 'TEX_COORD' and node.object in objects:
                    node.object = objects[node.object]
    for obj in source_scene.objects:
        if obj.type not in {'LIGHT', 'CAMERA'}:
            continue
        duplicate = obj.copy()
        duplicate.data = obj.data.copy()
        duplicate.parent = None
        duplicate.matrix_world = obj.matrix_world.copy()
        scene.collection.objects.link(duplicate)
        created['objects'].append(duplicate)
        created['other_data'].append(duplicate.data)
        if obj == source_scene.camera:
            scene.camera = duplicate
    scene.view_settings.view_transform = source_scene.view_settings.view_transform
    scene.view_settings.look = source_scene.view_settings.look
    scene.view_settings.exposure = source_scene.view_settings.exposure
    scene.view_settings.gamma = source_scene.view_settings.gamma
    scene.render.engine = source_scene.render.engine
    for key in ('use_gtao', 'gtao_distance', 'gtao_factor', 'taa_render_samples'):
        if hasattr(source_scene.eevee, key):
            setattr(scene.eevee, key, getattr(source_scene.eevee, key))
    scene['source_signature'] = json.dumps(source_signature)
    return scene, coll, created


def capture_live_snapshot(asset='island', root_name=None):
    source_scene = bpy.context.scene
    key = 'hills_export_collection' if asset == 'hills' else 'export_collection'
    collection_name = source_scene.get(key)
    if not collection_name and asset == 'hills':
        collection_name = 'EXPORT - Forested Hills'
    source_collection = bpy.data.collections.get(collection_name or '')
    if source_collection is None:
        raise RuntimeError('The current file has no requested asset export collection')
    source_objects = None
    if root_name:
        root = source_collection.all_objects.get(root_name)
        if root is None:
            raise RuntimeError(f'The export collection has no {root_name} root')
        source_objects = [root, *root.children_recursive]
    before = signature(source_scene, source_collection)
    label = 'Forested Hills' if asset == 'hills' else 'Floating Island'
    scene, coll, created = working_copy(source_scene, source_collection,
                                       evaluate_modifiers=asset == 'hills', asset_label=label,
                                       source_objects=source_objects)
    folder = Path(tempfile.mkdtemp(prefix='brawlegle-' + asset + '-bake-'))
    snapshot = folder / 'source_snapshot.blend'
    try:
        bpy.data.libraries.write(str(snapshot), {scene}, path_remap='ABSOLUTE', compress=True)
        (folder / 'source_signature.json').write_text(json.dumps(before, indent=2), encoding='utf-8')
    finally:
        for obj in created['objects']:
            bpy.data.objects.remove(obj, do_unlink=True)
        for data in created['meshes']:
            bpy.data.meshes.remove(data)
        for material in created['materials']:
            bpy.data.materials.remove(material)
        for image in created['images']:
            bpy.data.images.remove(image)
        for data in created['other_data']:
            if isinstance(data, bpy.types.Camera):
                bpy.data.cameras.remove(data)
            elif isinstance(data, bpy.types.Light):
                bpy.data.lights.remove(data)
        bpy.data.scenes.remove(scene)
        bpy.data.collections.remove(coll)
    assert before == signature(source_scene, source_collection), 'Source objects changed during capture'
    return str(snapshot)


def color_signal(material):
    if not material.use_nodes:
        return None, tuple(material.diffuse_color), 'lit'
    output = next(n for n in material.node_tree.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output)
    link = next(iter(output.inputs['Surface'].links), None)
    if link is None:
        raise RuntimeError(f'No surface output on {material.name}')
    shader = link.from_node
    if shader.type == 'BSDF_DIFFUSE':
        pin = shader.inputs['Color']
        if shader.inputs['Normal'].is_linked:
            raise RuntimeError(f'{material.name} also requires a normal bake')
        return (pin.links[0].from_socket if pin.is_linked else None), tuple(pin.default_value), 'lit'
    if link.from_socket.type in {'RGBA', 'VALUE'}:
        return link.from_socket, (1, 1, 1, 1), 'unlit'
    if shader.type == 'EMISSION':
        if shader.inputs['Strength'].is_linked or shader.inputs['Strength'].default_value != 1:
            raise RuntimeError(f'{material.name} has non-unit emission strength')
        pin = shader.inputs['Color']
        return (pin.links[0].from_socket if pin.is_linked else None), tuple(pin.default_value), 'unlit'
    raise RuntimeError(f'Unsupported surface shader on {material.name}: {shader.type}')


def preview(scene, objects, path):
    if scene.camera is None:
        data = bpy.data.cameras.new('Baked asset preview')
        scene.camera = bpy.data.objects.new('Baked asset preview', data)
        scene.collection.objects.link(scene.camera)
    points = [obj.matrix_world @ Vector(v) for obj in objects for v in obj.bound_box]
    lower = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    upper = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    center = (lower + upper) * .5
    camera = scene.camera
    camera.location = center + Vector((18, -30, 23))
    camera.rotation_euler = (center + Vector((0, 0, .5)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    enum(camera.data, 'type', ('ORTHO',))
    camera.data.ortho_scale = max(28, (upper.x - lower.x) * 1.22)
    enum(scene.render, 'engine', ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'))
    scene.render.resolution_x, scene.render.resolution_y = 960, 720
    scene.render.resolution_percentage = 100
    enum(scene.render.image_settings, 'file_format', ('PNG',))
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def prepare_uvs(objects):
    # Freeze implicit UV reads before adding the unique atlas UV set.
    for obj in objects:
        if not obj.data.uv_layers:
            raise RuntimeError(f'{obj.name} has no source UVs')
        original_uv = obj.data.uv_layers.active.name
        for material in obj.data.materials:
            if not material.use_nodes:
                continue
            tree = material.node_tree
            key = '__frozen_source_uv'
            if material.get(key) and material[key] != original_uv:
                raise RuntimeError('Shared material uses inconsistent source UV names')
            if material.get(key):
                continue
            material[key] = original_uv
            uv = tree.nodes.new('ShaderNodeUVMap')
            uv.uv_map = original_uv
            for node in list(tree.nodes):
                if node.type == 'TEX_COORD':
                    for link in list(node.outputs['UV'].links):
                        tree.links.new(uv.outputs['UV'], link.to_socket)
                elif node.type == 'TEX_IMAGE' and not node.inputs['Vector'].is_linked:
                    tree.links.new(uv.outputs['UV'], node.inputs['Vector'])
        obj.data.uv_layers.new(name='BakedUV')
        obj.data.uv_layers.active_index = len(obj.data.uv_layers) - 1
        obj.data.uv_layers.active.active_render = True
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.hide_set(False); obj.hide_viewport = False; obj.hide_select = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=.008,
                            area_weight=0, correct_aspect=True, scale_to_bounds=True)
    bpy.ops.uv.pack_islands(rotate=True, margin_method='FRACTION', margin=.008)
    bpy.ops.object.mode_set(mode='OBJECT')


def export_document(path):
    raw = path.read_bytes()
    magic, version, total = struct.unpack_from('<4sII', raw)
    assert magic == b'glTF' and version == 2 and total == len(raw)
    size, kind = struct.unpack_from('<II', raw, 12)
    assert kind == 0x4E4F534A
    document = json.loads(raw[20:20+size])
    assert all('uri' not in buffer for buffer in document['buffers'])
    assert all('bufferView' in image for image in document['images'])
    return document


def bake_export(output, resolution, asset='island'):
    if not bpy.app.background:
        raise RuntimeError('Run this script in a separate background Blender process to preserve your live edits.')
    source_scene = bpy.context.scene
    if source_scene.get('bake_snapshot'):
        scene = source_scene
        coll = bpy.data.collections[scene['export_collection']]
    else:
        key = 'hills_export_collection' if asset == 'hills' else 'export_collection'
        collection_name = source_scene.get(key)
        if not collection_name and asset == 'hills':
            collection_name = 'EXPORT - Forested Hills'
        source_collection = bpy.data.collections[collection_name]
        scene, coll, _ = working_copy(source_scene, source_collection,
                                      evaluate_modifiers=asset == 'hills',
                                      asset_label='Forested Hills' if asset == 'hills' else 'Floating Island')
    bpy.context.window.scene = scene
    objects = [o for o in coll.all_objects if o.type == 'MESH']
    if any(o.modifiers for o in objects):
        raise RuntimeError('Evaluate modifiers on export copies before using this color-only baker')
    asset_key = 'forested_hills' if asset == 'hills' else 'floating_island'
    asset_label = 'Forested Hills' if asset == 'hills' else 'Floating Island'
    directory = output.parent / 'blender' / 'baked' / asset_key
    directory.mkdir(parents=True, exist_ok=True)
    log(f'Captured {len(objects)} meshes; rendering shader reference')
    preview(scene, objects, directory / 'shader_reference.png')
    materials = {m for obj in objects for m in obj.data.materials}
    roles, signals = {}, {}
    for material in materials:
        signal, constant, role = color_signal(material)
        roles[material] = role
        signals[material] = (signal, constant)
    original_triangles = sum(len(p.vertices)-2 for obj in objects for p in obj.data.polygons)
    log('Creating non-overlapping atlas UVs while retaining original shader UVs')
    prepare_uvs(objects)
    image = bpy.data.images.new(asset_label + ' - Baked Base Color', width=resolution,
                                height=resolution, alpha=False, float_buffer=False)
    image.colorspace_settings.name = 'sRGB'
    enum(image, 'file_format', ('PNG',))
    for material in materials:
        if not material.use_nodes:
            material.use_nodes = True
        tree = material.node_tree
        output_node = next(n for n in tree.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output)
        emission = tree.nodes.new('ShaderNodeEmission')
        signal, constant = signals[material]
        if signal:
            tree.links.new(signal, emission.inputs['Color'])
        else:
            emission.inputs['Color'].default_value = constant
        emission.inputs['Strength'].default_value = 1
        tree.links.new(emission.outputs[0], output_node.inputs['Surface'])
        target = tree.nodes.new('ShaderNodeTexImage')
        target.image = image
        tree.nodes.active = target
        target.select = True
    enum(scene.render, 'engine', ('CYCLES',))
    enum(scene.cycles, 'device', ('CPU',))
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    log(f'Baking {resolution}x{resolution} color atlas, including shader AO and masks')
    result = bpy.ops.object.bake(type='EMIT', use_clear=False, margin=4, uv_layer='BakedUV')
    if 'FINISHED' not in result:
        raise RuntimeError(f'Bake failed: {result}')
    atlas_path = directory / (asset_key + '_basecolor.png')
    image.filepath_raw = str(atlas_path)
    image.save()
    image.pack()
    exported_materials = {}
    for role in sorted(set(roles.values())):
        material = bpy.data.materials.new(asset_label + ' - Baked ' + role.title())
        material.use_nodes = True
        tree = material.node_tree
        tree.nodes.clear()
        texture = tree.nodes.new('ShaderNodeTexImage'); texture.image = image
        # Retain crisp low-resolution source art after baking its shader composition.
        enum(texture, 'interpolation', ('Closest',))
        output_node = tree.nodes.new('ShaderNodeOutputMaterial')
        if role == 'unlit':
            shader = tree.nodes.new('ShaderNodeBackground')
            shader.inputs['Strength'].default_value = 1
            tree.links.new(texture.outputs['Color'], shader.inputs['Color'])
        else:
            shader = tree.nodes.new('ShaderNodeBsdfPrincipled')
            shader.inputs['Roughness'].default_value = 1
            shader.inputs['Metallic'].default_value = 0
            shader.inputs['Specular IOR Level'].default_value = 0
            tree.links.new(texture.outputs['Color'], shader.inputs['Base Color'])
        tree.links.new(shader.outputs[0], output_node.inputs['Surface'])
        exported_materials[role] = material
    role_names = sorted(exported_materials)
    for obj in objects:
        face_roles = [roles[obj.data.materials[p.material_index]] for p in obj.data.polygons]
        obj.data.materials.clear()
        for role in role_names:
            obj.data.materials.append(exported_materials[role])
        for poly, role in zip(obj.data.polygons, face_roles):
            poly.material_index = role_names.index(role)
        for uv in list(obj.data.uv_layers):
            if uv.name != 'BakedUV':
                obj.data.uv_layers.remove(uv)
        obj.name = obj.get('source_name', obj.name)
    for obj in coll.all_objects:
        if obj.type == 'EMPTY':
            obj.name = obj.get('source_name', obj.name)
    log('Rendering the baked material preview')
    preview(scene, objects, directory / 'baked_preview.png')
    bpy.ops.object.select_all(action='DESELECT')
    for obj in coll.all_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    output.parent.mkdir(parents=True, exist_ok=True)
    log('Exporting ' + str(output))
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB',
                              use_selection=True, use_active_scene=True,
                              export_cameras=False, export_lights=False,
                              export_yup=True, export_apply=True,
                              export_normals=True, export_texcoords=True,
                              export_materials='EXPORT', export_image_format='AUTO',
                              export_extras=False, export_animations=False)
    document = export_document(output)
    count = sum(document['accessors'][prim['indices']]['count']//3
                for mesh in document['meshes'] for prim in mesh['primitives'])
    assert count == original_triangles, (count, original_triangles)
    assert len(document['meshes']) == len(objects)
    assert len(document['images']) == 1
    assert not document.get('cameras')
    if 'unlit' in role_names:
        assert 'KHR_materials_unlit' in document.get('extensionsUsed', [])
    names = [node.get('name', '') for node in document['nodes']]
    assert not any('Rainier' in name or name.startswith('TREE SOURCE') for name in names)
    if asset == 'island':
        assert not any(name.startswith('Hill ') or name == 'ForestedHills' for name in names)
    else:
        assert 'FloatingIsland' not in names
    for mesh in document['meshes']:
        for primitive in mesh['primitives']:
            assert {'POSITION', 'NORMAL', 'TEXCOORD_0'} <= primitive['attributes'].keys()
    report = {'file': str(output), 'bytes': output.stat().st_size, 'meshes': len(objects),
              'triangles': count, 'atlas': str(atlas_path), 'resolution': resolution,
              'source_materials': {m.get('source_material', m.name): roles[m] for m in materials},
              'export_materials': [m['name'] for m in document['materials']],
              'extensions': document.get('extensionsUsed', []),
              'scope': scene.get('source_collection', 'EXPORT - Floating Island') + ' only; excludes other assets, source library, cameras and lights',
              'baked': 'Shader color and connected texture/color processing',
              'modifiers_realized_on_copy': bool(scene.get('evaluated_modifiers', False)),
              'source_preserved': True}
    (directory / 'export_report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    enum(scene.render, 'engine', ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'))
    scene['export_filename'] = output.name
    bpy.ops.wm.save_as_mainfile(filepath=str(directory / (asset_key + '_baked.blend')))
    log('COMPLETE ' + json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--resolution', type=int, default=2048)
    parser.add_argument('--asset', choices=('island', 'hills'), default='island')
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    bake_export(args.output.resolve(), args.resolution, args.asset)
