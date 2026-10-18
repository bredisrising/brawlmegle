# PS2 rocky platform, forested hills, and Mount Rainier

## Edited island: baked export

The current edited island is exported to **`../floating_island.glb`** (in the repository's `models` folder). It contains **17 meshes / 3,694 triangles**, two materials, and one embedded **2048 x 2048** color atlas. Texture mixes, curves, moss masks, and shader ambient occlusion are baked into the atlas. The wood material retains its unlit appearance. Hills, Rainier, source trees, cameras and lights are excluded. The live Blender scene, source UVs, shaders, and unsaved painted image buffers were preserved; the export used an isolated snapshot of the live edits.

The baked Eevee review file, atlas, reference render, and GLB reimport preview are in **`baked/floating_island/`**. The GLB was reimported and checked: all 17 meshes and 3,694 triangles survived, with identical bounding boxes and working embedded textures. See `export_report.json` in that folder for details.

For a later bake of edited shaders, save your `.blend` with painted/generated images packed, then run this from `models/blender`:

```powershell
blender --background floating_island.blend --python bake_export_island.py -- --output ../floating_island.glb --resolution 2048
```

This runs the color bake in a separate Blender process and writes a baked review copy. The source `.blend` is not overwritten. Continue using the direct export script below for the other assets; edited island shader graphs need the bake script.

## Edited forested hills: baked export

**One-click re-export:** in Blender's Text Editor, choose **`reexport_hills.py`** and press **Alt+P** (Run Script). It captures the current, unsaved `ForestedHills` hierarchy, evaluates tree scattering on a copy, bakes the shader colors, reloads the result to verify geometry and embedded textures, and replaces **`../forested_hills.glb`** automatically. Baking runs in a separate hidden Blender process so editing can continue. A popup reports completion or the failure log. The existing export is replaced only after validation passes. Loose meshes outside the `ForestedHills` hierarchy are excluded; parent additional intended scenery to that root.

The current export contains **one hill and 55 scattered trees**, realized into **one mesh / 35,076 triangles**, with one material and one embedded **2048 x 2048** color atlas. The greenery shader's image texture and color ramp are baked. Scene placement is retained. The rocky island, Rainier, source-tree library objects, cameras and lights are excluded.

Only the export copy has its Geometry Nodes modifier evaluated into a mesh. The source scatter controls, tree models, and shader stay editable in Blender. The baked Eevee review copy, atlas, reference render, and GLB reload preview are in **`baked/forested_hills/`**. The GLB was reimported and checked for identical geometry counts, bounding boxes, and working embedded textures.

To automate the same export from a saved file, run from this folder:

```powershell
blender --background floating_island.blend --python-exit-code 1 --python reexport_hills.py
```

The following sections describe the original generated assets and their default counts. The baked exports above reflect the subsequent Blender edits.

Open **floating_island.blend** for the full composition, **forested_hills.blend** to inspect the hills and trees, or **mount_rainier.blend** for the standalone mountain. Each file contains all three asset scenes; the scene picker at the top switches between them. The original Blender scene is preserved. Rendering uses **Eevee**. Press Numpad 0 to toggle the preview camera; enable Overlays in the viewport toolbar if you want editing guides.

The foreground is a **rocky platform** with fractured slate, overlapping stone plates, fissures, chunky outcrops, scree, and suspended rock fragments. Props include a weathered stone arch, broken column, fallen masonry, two braced crates, two barrels, a stone fire ring with charred logs, a signpost, timber railing, and deadwood. Four small pines and sparse crevice grass sit around the edges. The foreground has **5,210 triangles** across **25 meshes**.

**Rainier is distant scenery, physically separated from the platform by over 15 units of air.** Its independent `MountRainierBackdrop` root is in the top-level **EXPORT - Rainier Background** collection, outside the platform's export collection. Moving the platform does not move the mountain. The preview camera shows a sky gap between them.

The standalone Rainier model remains **766 triangles** in one mesh, with its origin at the base and full proportions. The placed backdrop is a separate copy with lighter palette swatches to suggest distance. Rainier is an artistic interpretation, not geographic survey data. Shape reference: [National Park Service park brochure](https://www.nps.gov/mora/planyourvisit/park-brochure.htm). The earlier grassy island is preserved in `previous/floating_island_grassy.blend`.

## Hills and editable tree scattering

Three faceted green hills form a separate scenery layer between the rocky platform and Rainier. They contain **82 trees** by default, using three reusable source models: **Alpine Pine**, **Broad Pine**, and **Slender Fir**. Hills plus evaluated trees have **12,622 triangles** in three meshes. The hill objects and their live scatter modifiers are shared between the full composition and the Forested Hills inspection scene, so editing either scene changes the same assets.

1. Select **Hill 01**, **Hill 02**, or **Hill 03** in the Outliner under **EXPORT - Forested Hills**.
2. Open **Modifiers** (wrench icon), then **Trees - editable scatter**.
3. Change **Tree Source** to swap every tree on that hill. The three built-in sources are listed in **LIBRARY - Replaceable Trees**. You can choose your own mesh object too; put its origin at the trunk base and orient its local Z axis upward.
4. Adjust **Tree Density**, **Tree Spacing**, **Minimum Size**, **Maximum Size**, and **Scatter Seed**. Density zero removes the trees; increasing spacing limits how many fit. Trees remain upright and avoid the rocky skirts and steep slopes.

The scatter uses **Geometry Nodes**, with live source objects and Poisson spacing. The graph realizes instances at its output so GLB export includes the trees without applying the modifier or losing your editable setup. To edit a built-in source mesh, unhide its eye icon in **LIBRARY - Replaceable Trees**, edit it, and hide it again. The source objects are hidden from rendering; their scattered copies remain visible.

The pre-hills rocky scene is backed up in `previous/floating_island_rocky.blend`.

## Export after reviewing

1. Choose the desired asset scene and finish your edits. Keep exportable meshes inside its **EXPORT** collection. Save your `.blend`.
2. Open the **Scripting** workspace. In the Text Editor choose the embedded **export_glb.py**, or open it from this folder.
3. Click **Run Script** (Alt+P with the mouse over the Text Editor).
4. The current asset is written to **exports/floating_island.glb** (foreground only), **exports/forested_hills.glb** (hills and all scattered trees), or **exports/mount_rainier.glb** (standalone mountain), alongside the `.blend` file. Running again replaces that GLB.

To export the **placed background prop**, change `DEFAULT_ASSET = None` near the top of the script to `DEFAULT_ASSET = 'backdrop'`, then run it. This writes **exports/rainier_backdrop.glb**, preserving the backdrop's scene placement. Reset the setting to `None` to export the current scene's asset again. Use the standalone Rainier export instead when you want a mountain centered at the origin.

To export the **hills and trees** from the full composition, use `DEFAULT_ASSET = 'hills'`, or switch to **Forested Hills - PS2** and leave that setting as `None`. The hills GLB preserves their scene placement and includes the evaluated trees. Source library objects and Blender's node graph are excluded; the live graph stays in your `.blend`.

The script exports the chosen asset collection, embeds the texture, applies modifiers during export, converts Blender Z-up to glTF Y-up, and excludes preview cameras and lights. It preserves your selection, source meshes, and live modifiers. The foreground, hills, and mountain background are exported independently.

All four exports were checked using temporary GLBs: all triangles, UVs and normals survived; each file contained one scene, one material and an embedded PNG with nearest filtering. The hills export included all 82 trees. Preview cameras, lights, source library objects and the original cube were excluded. The platform, hills, and mountain stayed in their respective exports. Source mesh data and live modifiers remained unchanged. Density-zero and tree-source swapping were also tested and restored. The test GLBs were temporary; use the script to create your final files.

Command-line alternatives from this folder (use the full Blender executable path if needed):

```powershell
blender --background floating_island.blend --python export_glb.py -- --asset island
blender --background mount_rainier.blend --python export_glb.py -- --asset rainier
blender --background floating_island.blend --python export_glb.py -- --asset backdrop
blender --background forested_hills.blend --python export_glb.py -- --asset hills
```

Add `--output C:/path/to/model.glb` to choose a destination. Export once after reviewing; GLBs are not automatically generated when the scene is built.

## Three.js

Use `GLTFLoader` with the exported GLB. Each asset uses one shared opaque, rough Principled material and one **128 x 64 PNG palette atlas**, packed into the `.blend` and embedded in the GLB. The atlas uses nearest filtering, baked pixel grain, and UV swatch margins. Exported geometry has flat normals; no procedural textures, external libraries, Blender nodes, rigs, or compression extensions are required at runtime. The original PNG is also in `textures/`.

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const { scene: island } = await new GLTFLoader().loadAsync('/models/floating_island.glb');
scene.add(island);
```

Copy the exported file into your application's public asset folder before using that URL. Add lighting in Three.js; Blender's Eevee ambient occlusion, world, and preview lights are not baked into the model. The island is approximately 23 Blender units wide; the standalone mountain is approximately 20 units wide, with its origin at the base. Preview images are under `previews/`.

## Rebuild

`create_scene.py` is the deterministic source builder; `rocky_platform.py` builds the rocky foreground and backdrop, and `forested_hills.py` builds the hills, reusable tree models, and live scatter. Keep these scripts together in this folder. Run `create_scene.py` in a fresh Blender file using the Text Editor or `blender --background --python create_scene.py`. It creates three asset scenes and saves all three `.blend` files. It refuses to rebuild when the generated island scene already exists, to protect manual edits. Building again in a fresh file overwrites the generated files in this folder. To add hills to an older copy of the rocky scene, run `forested_hills.py`; it refuses to add a second set over existing hills.
