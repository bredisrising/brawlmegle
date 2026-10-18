"""One-click hills export: bake textures, validate, and replace the game's GLB.

Blender: open this file in the Text Editor and press Alt+P (Run Script).
Captures unsaved edits, then works in a separate hidden Blender process.
CLI from models/blender:
  blender -b floating_island.blend --python-exit-code 1 --python reexport_hills.py
"""
from pathlib import Path
import json
import runpy
import shutil
import subprocess
import sys
import tempfile

import bpy


HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent / 'forested_hills.glb'
ROOT = 'ForestedHills'
RESOLUTION = 2048
JOB_KEY = 'brawlegle_hills_export'


def geometry_stats(objects):
    points = [obj.matrix_world @ vertex.co for obj in objects for vertex in obj.data.vertices]
    return {
        'meshes': len(objects),
        'triangles': sum(len(p.vertices) - 2 for obj in objects for p in obj.data.polygons),
        'bounds': [[fn(p[i] for p in points) for i in range(3)] for fn in (min, max)],
    }


def bake_and_replace(helpers):
    """Validate a staged export before replacing the existing files."""
    scene = next(s for s in bpy.data.scenes if s.get('bake_snapshot'))
    bpy.context.window.scene = scene
    collection = bpy.data.collections[scene['export_collection']]
    source = [obj for obj in collection.all_objects if obj.type == 'MESH']
    expected = geometry_stats(source)
    with tempfile.TemporaryDirectory(prefix='brawlegle-hills-export-') as temporary:
        staged = Path(temporary) / 'models' / OUTPUT.name
        helpers['bake_export'](staged, RESOLUTION, 'hills')
        review = staged.parent / 'blender' / 'baked' / 'forested_hills'
        for obj in source:
            obj.hide_render = True
        existing = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(staged))
        loaded = [obj for obj in bpy.data.objects
                  if obj not in existing and obj.type == 'MESH']
        bpy.context.view_layer.update()
        actual = geometry_stats(loaded)
        error = max(abs(a - b) for p, q in zip(expected['bounds'], actual['bounds'])
                    for a, b in zip(p, q))
        if (expected['meshes'], expected['triangles']) != (actual['meshes'], actual['triangles']):
            raise RuntimeError('GLB reload changed the mesh or triangle count')
        if error > 0.0001:
            raise RuntimeError(f'GLB reload changed the bounding box by {error}')
        images = {node.image for obj in loaded for material in obj.data.materials
                  for node in material.node_tree.nodes if node.type == 'TEX_IMAGE' and node.image}
        # Reading size/pixels loads Blender's lazily decoded embedded images.
        if len(images) != 1 or any(tuple(image.size) != (RESOLUTION, RESOLUTION)
                                   or len(image.pixels) == 0 for image in images):
            raise RuntimeError('GLB reload has a missing or incorrectly sized texture')
        helpers['preview'](scene, loaded, review / 'glb_roundtrip.png')
        destination = HERE / 'baked' / 'forested_hills'
        report = json.loads((review / 'export_report.json').read_text(encoding='utf-8'))
        report.update(file=str(OUTPUT), atlas=str(destination / 'forested_hills_basecolor.png'),
                      scope=f'{ROOT} hierarchy only; excludes loose meshes, other assets, source library, cameras and lights',
                      roundtrip_validation={
                          'reimported_meshes': actual['meshes'],
                          'reimported_triangles': actual['triangles'],
                          'bounding_box_max_error': error,
                          'embedded_textures_load': True,
                      })
        (review / 'export_report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        destination.mkdir(parents=True, exist_ok=True)
        for path in review.iterdir():
            shutil.copy2(path, destination / path.name)
        shutil.copy2(staged, OUTPUT)
    print(f'HILLS_EXPORT_COMPLETE {OUTPUT} ({actual["triangles"]:,} triangles)', flush=True)


def notify(message, error=False):
    print(message, flush=True)
    if not bpy.app.background:
        def draw(menu, context):
            menu.layout.label(text=message)
        bpy.context.window_manager.popup_menu(draw, title='Hills export', icon='ERROR' if error else 'INFO')


def main():
    helpers = runpy.run_path(str(HERE / 'bake_export_island.py'))
    if bpy.app.background and any(s.get('bake_snapshot') for s in bpy.data.scenes):
        bake_and_replace(helpers)
        return
    if bpy.app.driver_namespace.get(JOB_KEY):
        notify('Hills export is already running.')
        return
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        raise RuntimeError('Switch to Object Mode before exporting hills.')
    snapshot = Path(helpers['capture_live_snapshot']('hills', root_name=ROOT))
    log_path = snapshot.parent / 'export.log'
    command = [bpy.app.binary_path, '--background', str(snapshot), '--python-exit-code', '1',
               '--python', str(Path(__file__).resolve())]
    try:
        with log_path.open('w', encoding='utf-8') as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
    except Exception:
        shutil.rmtree(snapshot.parent)
        raise

    def finished():
        if process.poll() is None:
            return 1.0
        bpy.app.driver_namespace.pop(JOB_KEY, None)
        if process.returncode:
            notify(f'Hills export failed. Log: {log_path}', error=True)
        else:
            shutil.rmtree(snapshot.parent)
            notify(f'Baked and replaced {OUTPUT.name}.')
        return None

    if bpy.app.background:
        process.wait()
        finished()
        if process.returncode:
            raise RuntimeError(f'Hills export failed. Log: {log_path}')
    else:
        bpy.app.driver_namespace[JOB_KEY] = process
        bpy.app.timers.register(finished, first_interval=1.0)
        notify('Baking hills in the background; the GLB will be replaced when validation passes.')


if __name__ == '__main__':
    main()
