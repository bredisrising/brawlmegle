# PS2 rocky floating platform + Mount Rainier

Open **floating_island.blend** to inspect the island, or **mount_rainier.blend** for the standalone mountain. Both files contain both asset scenes; the scene picker at the top switches between them. The original Blender scene is preserved. Rendering uses **Eevee**. Press Numpad 0 to toggle the preview camera; enable Overlays in the viewport toolbar if you want editing guides.

The foreground is a **rocky platform** with fractured slate, overlapping stone plates, fissures, chunky outcrops, scree, and suspended rock fragments. Props include a weathered stone arch, broken column, fallen masonry, two braced crates, two barrels, a stone fire ring with charred logs, a signpost, timber railing, and deadwood. Four small pines and sparse crevice grass sit around the edges. The foreground has **5,210 triangles** across **25 meshes**.

**Rainier is distant scenery, physically separated from the platform by over 15 units of air.** Its independent `MountRainierBackdrop` root is in the top-level **EXPORT - Rainier Background** collection, outside the platform's export collection. Moving the platform does not move the mountain. The preview camera shows a sky gap between them.

The standalone Rainier model remains **766 triangles** in one mesh, with its origin at the base and full proportions. The placed backdrop is a separate copy with lighter palette swatches to suggest distance. Rainier is an artistic interpretation, not geographic survey data. Shape reference: [National Park Service park brochure](https://www.nps.gov/mora/planyourvisit/park-brochure.htm). The earlier grassy island is preserved in `previous/floating_island_grassy.blend`.

## Export after reviewing

1. Choose the desired asset scene and finish your edits. Keep exportable meshes inside its **EXPORT** collection. Save your `.blend`.
2. Open the **Scripting** workspace. In the Text Editor choose the embedded **export_glb.py**, or open it from this folder.
3. Click **Run Script** (Alt+P with the mouse over the Text Editor).
4. The current asset is written to **exports/floating_island.glb** (foreground only) or **exports/mount_rainier.glb** (standalone mountain), alongside the `.blend` file. Running again replaces that GLB.

To export the **placed background prop**, change `DEFAULT_ASSET = None` near the top of the script to `DEFAULT_ASSET = 'backdrop'`, then run it. This writes **exports/rainier_backdrop.glb**, preserving the backdrop's scene placement. Reset the setting to `None` to export the current scene's asset again. Use the standalone Rainier export instead when you want a mountain centered at the origin.

The script exports the chosen asset collection, embeds the texture, applies modifiers during export, converts Blender Z-up to glTF Y-up, and excludes preview cameras and lights. It preserves your selection and source meshes. Foreground and background are exported independently.

All three exports were checked using temporary GLBs: all triangles, UVs and normals survived; each file contained one scene, one material and an embedded PNG with nearest filtering. Preview cameras, lights and the original cube were excluded. The platform export excluded Rainier, and the background export excluded the platform. Source mesh data remained unchanged. The test GLBs were temporary; use the script to create your final files.

Command-line alternatives from this folder (use the full Blender executable path if needed):

```powershell
blender --background floating_island.blend --python export_glb.py -- --asset island
blender --background mount_rainier.blend --python export_glb.py -- --asset rainier
blender --background floating_island.blend --python export_glb.py -- --asset backdrop
```

Add `--output C:/path/to/model.glb` to choose a destination. Export once after reviewing; GLBs are not automatically generated when the scene is built.

## Three.js

Use `GLTFLoader` with the exported GLB. The asset uses one shared opaque, rough Principled material and one **128 x 64 PNG palette atlas**, packed into the `.blend` and embedded in the GLB. The atlas uses nearest filtering, baked pixel grain, and UV swatch margins. Geometry has flat normals; no procedural textures, external libraries, geometry nodes, rigs, or compression extensions are required. The original PNG is also in `textures/`.

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const { scene: island } = await new GLTFLoader().loadAsync('/models/floating_island.glb');
scene.add(island);
```

Copy the exported file into your application's public asset folder before using that URL. Add lighting in Three.js; Blender's Eevee ambient occlusion, world, and preview lights are not baked into the model. The island is approximately 23 Blender units wide; the standalone mountain is approximately 20 units wide, with its origin at the base. Preview images are under `previews/`.

## Rebuild

`create_scene.py` is the deterministic source builder; `rocky_platform.py` builds the rocky foreground, props, and distant backdrop placement. Keep both scripts in this folder. Run `create_scene.py` in a fresh Blender file using the Text Editor or `blender --background --python create_scene.py`. It creates two new scenes and saves both `.blend` files. It refuses to rebuild when the generated island scene already exists, to protect manual edits. Building again in a fresh file overwrites the generated files in this folder.
