# Forge server

Scan frames in, fighter out. It holds the OpenAI key so the browser never sees it, and matches `src/forge/forge.ts`.

```
cd forge
npm ci         # the fighter optimizer's packages (gltf-transform, meshoptimizer, sharp)
npm start      # http://127.0.0.1:8787, reads OPENAI_API_KEY from the repo root .env
```

Then set `VITE_FORGE_API=http://127.0.0.1:8787` in the root `.env` for the game. The dev page at http://127.0.0.1:8787/ captures front/left/right from a webcam (or takes 1–3 uploaded photos) and shows the brief, model sheet and card. Use it to test likeness on all four of us.

## API

| Call | Returns |
|---|---|
| `POST /api/forge` `{name, frames: [front, left, right]}` (1–3 base64 JPEG/PNG or data URLs) | `{id, ownerKey, deleteCode}`, then the forge runs in the background. The key and code are handed out only here (see "Deleting fighters") |
| `GET /api/forge/:id` | The fighter: `status` (`scanning` → `forging` → `ready` or `failed`), `step` (`brief` → `sheet` → `model`), `brief`, `sheetUrl`, `cardUrl`, `timings`, `error` |
| `GET /api/fighters` | Ready fighters, newest first (for the roster) |
| `POST /api/fighters/:id/delete` `{key}` / `POST /api/fighters/delete` `{code}` (`x-forge-key`) | `{ok, id, name}`: the fighter is deleted for good. 403 wrong key or code, 404 already gone, 409 still forging, 429 too many tries (`FORGE_MAX_DELETES` per 10 min, default 30, keys and codes counted apart) |
| `POST /api/highlights` (body: the clip, `video/webm` or `video/mp4`, up to 6 MB; `x-forge-key`; `x-highlight-meta`: URI-encoded JSON `{p1, p2, winner, move, combo, roundTime, duration}`, sides `{id?, name, cpu?}`) | The highlight. K.O. replays the game records, kept in `FORGE_DATA/highlights/` (newest 40) |
| `GET /api/highlights` | `{highlights}`, newest first, each with `url` (clips are immutable and served with byte ranges) |

Fighters are saved in `forge/data/<id>/` (gitignored). An empty `name` gets the fighter name from the brief.

### Deleting fighters

No logins: each forge makes an owner key (32 random bytes) and a delete code (16 Crockford base32 characters, 80
bits, `XXXX-XXXX-XXXX-XXXX`) and keeps only their SHA-256 hashes in `fighter.json` (`ownerKeyHash`, `deleteCodeHash`,
never in any answer). The browser that scanned keeps the key (localStorage `brawlegle.owned`) and shows "Delete my
fighter" on the memory card; the code is shown once the forge is done, to screenshot, and works from any laptop
(Leaders or the memory card: "Delete a fighter with a code"). A delete removes the whole `<id>/` folder (photos,
sheet, card, every GLB, `*.pre-rescue`/`*.pre-face` backups), its record in `records.json`, and every highlight that
shows it (index entry and clip). The username's previous fighter is current again. Code: `owner.js`.

Fighters from before owner keys (or a lost code): delete by hand on the server, by id or username (a username means
all of its fighters). Without `--yes` it only lists them. It asks the running server (localhost-only `/admin/delete`,
with the key in `FORGE_DATA/.admin-key`), or deletes on disk when the server is stopped:

    cd /opt/brawlegle/forge && sudo -u brawlegle FORGE_DATA=/var/lib/brawlegle/forge node delete-fighter.mjs <id|username> [--yes]

## Pipeline

1. **Brief** (`gpt-5.4-mini`, about 3 s): reads the photos and returns JSON with name, face, outfit, distinctive features, build, fighting archetype, signature costume details, prop, palette and scout report.
2. **Model sheet** (`gpt-image-2.5-sunburst`, 1536x2304, about 19 s at medium): the player as a Street Fighter 6 style fighter in a full-body A-pose on light gray, drawn with more detail and contrast than the model should end up with (the 3D rebuild softens it). This is what the image-to-3D step gets.
3. **Card art** (`gpt-image-2.5-flare`, about 13 s): same character in a fighting stance, using the sheet as the reference.
4. **Back view + 3D model + rig** (runs next to step 3): sunburst draws the back of the sheet (about 20 s), then Tripo builds the model from front + back (multiview, H v3.1, Ultra geometry, up to 60,000 faces, detailed PBR textures with the sheet's shading kept, about 100 s, 60 credits) and auto-rigs it with a Mixamo skeleton (about 8 s, 25 credits). If the back view fails the model is built from the front alone. `glbUrl` is the rigged GLB (or the static one if rigging fails). Needs `TRIPO_API_KEY` in the root `.env` and API credits on the Tripo platform; without them `glbUrl` stays empty, `modelError` says why, and the game uses its default fighter.

5. **Or our own GPU service** (`FORGE_3D=local` or `gradio`, about 20 s): the sheet goes to `forge/gpu` (TRELLIS.2 + a Blender Mixamo rig, on an AWS GPU box or a private Hugging Face Space) instead of Tripo, with the same `model` → `rig` steps and the same files. If the box fails, is warming up or isn't done within `FORGE_3D_TIMEOUT`, Tripo builds the model as before (`localError` says why, `engine3d` says which one built it, `gpuTimings` has the box's own timings). The forging card shows it live: `sheetPartialUrl` (the sheet while it draws), then the box's `previewVoxelsUrl` (TRELLIS's sparse voxels) and `previewMeshUrl` (the untextured shape) as they appear. See `forge/gpu/README.md` and `research/forge-gpu.md`.
5b. **Rig check** (`rigcheck.js`, under 1 s): every rigged GLB is posed the way the game poses it (a port of `src/director/skeletonPose.ts`, in the game's own poses baked into `rigcheck-poses.json`: a cross, a hook, a knee, a kick, a head snap, the victory pose, the K.O. ragdoll), skinned on the CPU, and checked: the 22 Mixamo bones and their layout, size and floor, every vertex weighted, no bone owning most of the surface, each limb's vertices owned by that limb, hands landing on the wrist, limbs following their bones, no torn or detached surface. A rig that fails is never shown, not even in the forging preview: the GPU box re-rigs it once (`rigAttempt: 2` in the job), then Tripo has a go (if it has credits; a Tripo rig gets Tripo's rig once more, then the GPU box's), and if nothing passes the fighter ships without `glbUrl`, so the game gives it the default body. `rigCheck` in fighter.json records every attempt; the first rejected GLB stays as `rigged.rejected.glb` (not served). Without `npm ci` the check is skipped (the startup log says `rig check OFF`). By hand: `node rigcheck.js fighter.glb [--sheet out.png]` (a contact sheet: front and side in the poses, colored by owning bone). Every fighter on the server: `node rigcheck-all.js [FORGE_DATA] [--sheets dir] [--hide]` (`--hide` sets `hidden: true` on the broken ones, keeping `fighter.json.pre-hide`; restart the server after).
6. **Optimize** (`optimize.js`, about 2 s): before the fighter is marked ready, the GLB the game loads gets WebP textures (base color 2048, normal and metal/roughness 1024 instead of Tripo's 4096s) and meshopt-compressed geometry, about 10.5 MB down to 1 MB with no visible difference in game; the skeleton, weights and bone names are untouched. The original is kept as `rigged.orig.glb` (not served). The card and sheet get `.webp` copies, which the API hands out as `cardUrl`/`sheetUrl` (the PNGs stay). Without `npm ci` the step is skipped with a warning. Fighters forged before this: `node optimize-all.js <FORGE_DATA>` (see the top of that file). Measurements: `research/perf-assets.md`.

A whole forge takes about 2.5 minutes and 85 Tripo credits. `FORGE_STYLE=goldsrc` brings back the previous forge exactly (Half-Life 1 style sheet, 30,000 faces, single image, 65 credits, about 2 minutes). Why these settings: `research/forge-quality.md`.

Prompts live in `prompts.js`.

## Settings (env, all optional)

| Variable | Default |
|---|---|
| `FORGE_STYLE` | `detailed` (Street Fighter 6 style fighter); `goldsrc` for the old Half-Life 1 look and the old Tripo settings |
| `FORGE_IMAGE_MODEL` | `gpt-image-2.5-sunburst` for the model sheet and its back view (best style match) |
| `FORGE_SHEET_SIZE` | `1536x2304` (`1024x1536` with goldsrc); the card is always `1024x1536` |
| `FORGE_CARD_MODEL` | `gpt-image-2.5-flare` for the card (fastest, about 13 s) |
| `FORGE_IMAGE_QUALITY` | `medium` (`low` is cheaper and faster for testing) |
| `FORGE_BRIEF_MODEL` | `gpt-5.4-mini` |
| `FORGE_MULTIVIEW` | `1`: draw a back view and build the model from front + back (`0` with goldsrc; `0` saves about 20 s) |
| `FORGE_TRIPO_MODEL` / `FORGE_FACE_LIMIT` | `v3.1-20260211` / `60000` (`30000` with goldsrc) |
| `FORGE_GEOMETRY_QUALITY` | `detailed` (Tripo's Ultra geometry, +20 credits); `standard` with goldsrc |
| `FORGE_DELIGHT` | `0`: keep the sheet's painted shading in the textures (`1` with goldsrc, Tripo's default) |
| `FORGE_RIG_MODEL` | `v1.0-20240301` (biped, Mixamo bone names) |
| `FORGE_3D` | `tripo`; `local` builds the model on our GPU service first (the AWS box or the Docker Space), `gradio` on the ZeroGPU Space. Tripo stays the fallback |
| `FORGE_3D_URL` / `FORGE_3D_KEY` | the service (`http://<private ip>:8790` for the AWS box, `https://<user>-<space>.hf.space` for a Space) and its key (`FORGE3D_KEY`) |
| `FORGE_3D_HF_TOKEN` | an HF token that can read the private Space (Spaces only) |
| `FORGE_3D_TIMEOUT` | `90` seconds before falling back to Tripo |
| `FORGE_GPU_SHEET` | `1`: with `FORGE_3D`, the sheet is gpt-image-2.5-flare at 1024x1536 (about 12 s instead of 19 s; TRELLIS reads it at 1024 px anyway). `0` keeps sunburst 1536x2304 |
| `FORGE_SHEET_PARTIALS` | `3` partial sheet images streamed for the forging card's preview (`0` turns streaming off) |
| `FORGE_PORT` / `FORGE_BIND` | `8787` / `127.0.0.1` |
| `FORGE_ALLOWED_ORIGINS` | the Vite dev and preview origins on localhost, plus the hosted test pages (https://54-149-60-196.sslip.io) |
| `FORGE_MAX_ACTIVE` | `3` forges at once |
| `FORGE_HIGHLIGHT_KEEP` / `FORGE_HIGHLIGHT_MAX_BYTES` / `FORGE_MAX_HIGHLIGHTS` | `40` clips kept / `6291456` bytes per clip / `20` uploads per 10 minutes |

Only pages from `FORGE_ALLOWED_ORIGINS` can call the API from a browser, so a random website can't spend our credits through it.
