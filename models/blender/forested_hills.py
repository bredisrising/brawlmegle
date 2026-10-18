"""Faceted hills and live, replaceable tree scattering for Blender 4.1+.

The scatter is instanced internally and realized at the modifier output so the
existing glTF exporter includes the trees without applying the source modifier.
"""
import importlib.util
import math
import random
from pathlib import Path
import bpy
from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt


def module_at(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def socket(node, name, kind):
    return next(s for s in node.inputs if s.name == name and s.bl_idname == kind)


def make_tree_sources(api, geo_module, library, material):
    sources = []
    for name, width, height, tiers in (
        ('TREE SOURCE - Alpine Pine', .86, 3.1, 3),
        ('TREE SOURCE - Broad Pine', 1.10, 2.65, 3),
        ('TREE SOURCE - Slender Fir', .65, 3.65, 4),
    ):
        geo = geo_module.Geometry()
        geo.taper((0, 0, 0), (.105, .055), (0, height * .85), (16, 17, 18), 6)
        for tier in range(tiers):
            t = tier / (tiers - 1)
            base = .45 + t * height * .52
            radius = width * (1 - t * .61)
            crown_height = height * (.52 - .12 * t)
            geo.taper((0, 0, 0), (radius, radius * .82, .018),
                      (base, base + .18, base + crown_height),
                      (12, 13, 14, 13, 15, 14, 13), 7)
        obj = geo.emit(api, name, library, None, material)
        obj['usage'] = 'Replace the Tree Source input on any Hill modifier. Origin is at the base; Z is up.'
        # Hidden sources still supply geometry to Object Info nodes.
        obj.hide_render = True
        obj.hide_set(True)
        sources.append(obj)
    return sources


def scatter_group(api):
    group = bpy.data.node_groups.new('PS2 Hills - Editable Tree Scatter', 'GeometryNodeTree')
    group.is_modifier = True
    interface = group.interface
    interface.new_socket(name='Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    interface.new_socket(name='Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    settings = {}
    for name, kind, default, low, high, description in (
        ('Tree Source', 'NodeSocketObject', None, None, None, 'Swap this object to replace every tree on this hill. Base origin, Z up.'),
        ('Tree Density', 'NodeSocketFloat', .40, 0, 4, 'Maximum number of trees per square unit, subject to spacing.'),
        ('Tree Spacing', 'NodeSocketFloat', 1.0, .2, 8, 'Minimum distance between tree origins.'),
        ('Minimum Size', 'NodeSocketFloat', .48, .05, 3, 'Smallest uniform tree scale.'),
        ('Maximum Size', 'NodeSocketFloat', .95, .05, 3, 'Largest uniform tree scale.'),
        ('Scatter Seed', 'NodeSocketInt', 42, 0, 100000, 'Change the tree arrangement without editing the hill.'),
    ):
        item = interface.new_socket(name=name, in_out='INPUT', socket_type=kind)
        item.description = description
        if default is not None:
            item.default_value = default
            item.min_value, item.max_value = low, high
        settings[name] = item.identifier
    nodes, links = group.nodes, group.links
    inputs = nodes.new('NodeGroupInput'); inputs.location = (-820, 200)
    output = nodes.new('NodeGroupOutput'); output.location = (760, 200)
    points = nodes.new('GeometryNodeDistributePointsOnFaces'); points.location = (-240, 200)
    api['set_enum'](points, 'distribute_method', ('POISSON',))
    points.label = 'Scatter on gentle, grassy upper slopes'
    links.new(inputs.outputs['Geometry'], points.inputs['Mesh'])
    links.new(inputs.outputs['Tree Density'], points.inputs['Density Max'])
    links.new(inputs.outputs['Tree Spacing'], points.inputs['Distance Min'])
    links.new(inputs.outputs['Scatter Seed'], points.inputs['Seed'])
    mask = nodes.new('GeometryNodeInputNamedAttribute'); mask.location = (-800, -100)
    api['set_enum'](mask, 'data_type', ('FLOAT',))
    mask.inputs['Name'].default_value = 'tree_mask'
    mask.label = 'Keep trees off the rocky skirt'
    links.new(mask.outputs['Attribute'], points.inputs['Density Factor'])
    normal = nodes.new('GeometryNodeInputNormal'); normal.location = (-820, -300)
    dot = nodes.new('ShaderNodeVectorMath'); dot.location = (-630, -300)
    api['set_enum'](dot, 'operation', ('DOT_PRODUCT',))
    dot.inputs[1].default_value = (0, 0, 1)
    links.new(normal.outputs['Normal'], dot.inputs[0])
    slope = nodes.new('ShaderNodeMath'); slope.location = (-430, -220)
    api['set_enum'](slope, 'operation', ('GREATER_THAN',))
    slope.inputs[1].default_value = .72
    links.new(dot.outputs['Value'], slope.inputs[0])
    links.new(slope.outputs[0], points.inputs['Selection'])
    source = nodes.new('GeometryNodeObjectInfo'); source.location = (-240, -100)
    api['set_enum'](source, 'transform_space', ('ORIGINAL',))
    source.inputs['As Instance'].default_value = False
    links.new(inputs.outputs['Tree Source'], source.inputs['Object'])
    instances = nodes.new('GeometryNodeInstanceOnPoints'); instances.location = (40, 200)
    links.new(points.outputs['Points'], instances.inputs['Points'])
    links.new(source.outputs['Geometry'], instances.inputs['Instance'])
    size = nodes.new('FunctionNodeRandomValue'); size.location = (-240, -380)
    api['set_enum'](size, 'data_type', ('FLOAT',))
    size.label = 'Uniform size variation'
    links.new(inputs.outputs['Minimum Size'], socket(size, 'Min', 'NodeSocketFloat'))
    links.new(inputs.outputs['Maximum Size'], socket(size, 'Max', 'NodeSocketFloat'))
    links.new(inputs.outputs['Scatter Seed'], size.inputs['Seed'])
    links.new(next(s for s in size.outputs if s.bl_idname == 'NodeSocketFloat'), instances.inputs['Scale'])
    yaw = nodes.new('FunctionNodeRandomValue'); yaw.location = (-240, -600)
    api['set_enum'](yaw, 'data_type', ('FLOAT_VECTOR',))
    socket(yaw, 'Min', 'NodeSocketVector').default_value = (0, 0, -math.pi)
    socket(yaw, 'Max', 'NodeSocketVector').default_value = (0, 0, math.pi)
    links.new(inputs.outputs['Scatter Seed'], yaw.inputs['Seed'])
    rotation = nodes.new('FunctionNodeEulerToRotation'); rotation.location = (0, -350)
    links.new(next(s for s in yaw.outputs if s.bl_idname == 'NodeSocketVector'), rotation.inputs[0])
    links.new(rotation.outputs[0], instances.inputs['Rotation'])
    realize = nodes.new('GeometryNodeRealizeInstances'); realize.location = (300, 200)
    realize.label = 'Export trees as standard glTF mesh geometry'
    links.new(instances.outputs['Instances'], realize.inputs['Geometry'])
    join = nodes.new('GeometryNodeJoinGeometry'); join.location = (550, 200)
    links.new(inputs.outputs['Geometry'], join.inputs['Geometry'])
    links.new(realize.outputs['Geometry'], join.inputs['Geometry'])
    links.new(join.outputs['Geometry'], output.inputs['Geometry'])
    group['usage'] = 'Select a Hill, open Modifiers, swap Tree Source or adjust density, spacing, sizes and seed.'
    return group, settings


def hill(api, name, radii, peak, seed, coll, root, material):
    rng = random.Random(seed)
    rx, ry = radii
    rim_count = 30
    coords = []
    for i in range(rim_count):
        a = i * math.tau / rim_count
        r = rng.uniform(.95, 1.04)
        coords.append(Vector((rx * r * math.cos(a), ry * r * math.sin(a))))
    for row in range(8):
        for col in range(12):
            x = -rx * .88 + col * rx * .16 + rng.uniform(-.22, .22)
            y = -ry * .85 + row * ry * .24 + rng.uniform(-.20, .20)
            if (x / rx) ** 2 + (y / ry) ** 2 < .88:
                coords.append(Vector((x, y)))
    points, _, faces, *_ = delaunay_2d_cdt(coords, [], [list(range(rim_count))], 1, 1e-5)
    vertices, mask = [], []
    for v in points:
        r2 = (v.x / rx) ** 2 + (v.y / ry) ** 2
        # Broad, rounded hills with a small asymmetrical shoulder.
        dome = max(0, 1 - r2) ** .90
        z = peak * dome * (.90 + .10 * math.sin(v.x * .47 + seed))
        z += .12 * dome * math.cos(v.y * .8)
        vertices.append((v.x, v.y, z))
        mask.append(max(0, min(1, (1 - math.sqrt(r2)) / .25)))
    colors = rng.choices((8, 9, 9, 10, 10, 10, 11), k=len(faces))
    # Closed rocky skirts. Preserve the actual CDT boundary, including vertex order.
    perimeter = []
    for original in coords[:rim_count]:
        perimeter.append(min(range(len(points)), key=lambda i: (points[i] - original).length_squared))
    bottom = len(vertices)
    for index in perimeter:
        x, y, _ = vertices[index]
        vertices.append((x * .96, y * .96, -1.45 + rng.uniform(-.15, .1)))
        mask.append(0)
    bottom_center = len(vertices)
    vertices.append((0, 0, -1.65)); mask.append(0)
    for i in range(rim_count):
        j = (i + 1) % rim_count
        faces.extend(((perimeter[i], bottom + i, bottom + j),
                      (perimeter[i], bottom + j, perimeter[j]),
                      (bottom + i, bottom_center, bottom + j)))
        colors.extend(rng.choices((3, 4, 19, 20, 31), k=3))
    obj = api['mesh'](name, vertices, faces, colors, coll, root, material)
    attribute = obj.data.attributes.new('tree_mask', type='FLOAT', domain='POINT')
    attribute.data.foreach_set('value', mask)
    obj['scatter_help'] = 'Modifiers > Trees - editable scatter: change Tree Source, density, spacing, size or seed.'
    return obj


def build(api, scene, material):
    if scene.get('hills_export_collection'):
        raise RuntimeError('Forested hills already exist. Edit the existing modifiers instead of rebuilding over them.')
    folder = api['HERE']
    geometry = module_at('rocky_platform', folder / 'rocky_platform.py')
    coll = api['collection']('EXPORT - Forested Hills', scene.collection)
    library = api['collection']('LIBRARY - Replaceable Trees', scene.collection)
    root = api['empty']('ForestedHills', coll)
    root['asset'] = 'forested_hills'
    sources = make_tree_sources(api, geometry, library, material)
    group, settings = scatter_group(api)
    hills = []
    for i, (location, radii, peak) in enumerate((
        ((-12, 17, -4.0), (8.0, 5.2), 3.3),
        ((-3, 22, -4.6), (8.5, 5.6), 4.1),
        ((6, 20, -4.1), (7.2, 4.8), 3.5),
    )):
        obj = hill(api, f'Hill {i+1:02d} - editable tree scatter', radii, peak,
                   630+i, coll, root, material)
        obj.location = location
        modifier = obj.modifiers.new('Trees - editable scatter', 'NODES')
        modifier.node_group = group
        modifier[settings['Tree Source']] = sources[i]
        modifier[settings['Tree Density']] = .40
        modifier[settings['Tree Spacing']] = 1.0
        modifier[settings['Minimum Size']] = .48
        modifier[settings['Maximum Size']] = .95
        modifier[settings['Scatter Seed']] = 51+i*17
        hills.append(obj)
    scene['hills_export_collection'] = coll.name
    scene['hills_export_filename'] = 'forested_hills.glb'
    scene['tree_library_collection'] = library.name
    # A separate inspection scene reuses the very same hills and tree sources.
    inspection = bpy.data.scenes.new('Forested Hills - PS2')
    inspection.collection.children.link(coll)
    inspection.collection.children.link(library)
    for source in sources:
        source.hide_set(True, view_layer=inspection.view_layers[0])
    inspection['export_collection'] = coll.name
    inspection['export_filename'] = 'forested_hills.glb'
    inspection['asset_directory'] = str(folder)
    api['preview_setup'](inspection, api['collection']('PREVIEW - Hills studio', inspection.collection))
    cam = inspection.camera
    cam.location = (16, -15, 23)
    api['point_at'](cam, (-3, 20, -2.1))
    cam.data.ortho_scale = 38
    inspection.render.resolution_x, inspection.render.resolution_y = 1400, 1000
    return coll, library, hills, inspection


def main():
    folder = Path(__file__).resolve().parent
    api = {'__name__': 'asset_builder', '__file__': str(folder / 'create_scene.py')}
    exec(compile((folder / 'create_scene.py').read_text(encoding='utf-8'),
                 str(folder / 'create_scene.py'), 'exec'), api)
    scene = bpy.data.scenes.get('Floating Island - PS2')
    if scene is None:
        raise RuntimeError('Open floating_island.blend before running this script.')
    material = next(m for m in bpy.data.materials if m.name.startswith('PS2 - pixel palette'))
    return build(api, scene, material)


if __name__ == '__main__':
    main()
