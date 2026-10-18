# Forge server

Scan frames in, fighter out. It holds the OpenAI key so the browser never sees it, and matches `src/forge/forge.ts`.

```
cd forge
npm start      # http://127.0.0.1:8787, reads OPENAI_API_KEY from the repo root .env
```

Then set `VITE_FORGE_API=http://127.0.0.1:8787` in the root `.env` for the game. The dev page at http://127.0.0.1:8787/ captures front/left/right from a webcam (or takes 1–3 uploaded photos) and shows the brief, model sheet and card. Use it to test likeness on all four of us.

## API

| Call | Returns |
|---|---|
| `POST /api/forge` `{name, frames: [front, left, right]}` (1–3 base64 JPEG/PNG or data URLs) | `{id}`, then the forge runs in the background |
| `GET /api/forge/:id` | The fighter: `status` (`scanning` → `forging` → `ready` or `failed`), `step` (`brief` → `sheet` → `model`), `brief`, `sheetUrl`, `cardUrl`, `timings`, `error` |
| `GET /api/fighters` | Ready fighters, newest first (for the roster) |

Fighters are saved in `forge/data/<id>/` (gitignored). An empty `name` gets the fighter name from the brief.

## Pipeline

1. **Brief** (`gpt-5.4-mini`, about 3 s): reads the photos and returns JSON with name, face, outfit, distinctive features, build, fighting archetype, signature costume details, prop, palette and scout report.
2. **Model sheet** (`gpt-image-2.5-sunburst`, 1536x2304, about 19 s at medium): the player as a Street Fighter 6 style fighter in a full-body A-pose on light gray, drawn with more detail and contrast than the model should end up with (the 3D rebuild softens it). This is what the image-to-3D step gets.
3. **Card art** (`gpt-image-2.5-flare`, about 13 s): same character in a fighting stance, using the sheet as the reference.
4. **Back view + 3D model + rig** (runs next to step 3): sunburst draws the back of the sheet (about 20 s), then Tripo builds the model from front + back (multiview, H v3.1, Ultra geometry, up to 60,000 faces, detailed PBR textures with the sheet's shading kept, about 100 s, 60 credits) and auto-rigs it with a Mixamo skeleton (about 8 s, 25 credits). If the back view fails the model is built from the front alone. `glbUrl` is the rigged GLB (or the static one if rigging fails). Needs `TRIPO_API_KEY` in the root `.env` and API credits on the Tripo platform; without them `glbUrl` stays empty, `modelError` says why, and the game uses its default fighter.

5. **Or our own GPU box** (`FORGE_3D=local`): the sheet goes to `forge/gpu` (TRELLIS.2 + a Blender Mixamo rig on an AWS L40S) instead of Tripo, with the same `model` → `rig` steps and the same files. If the box fails, is warming up or isn't done within `FORGE_3D_TIMEOUT`, Tripo builds the model as before (`localError` says why, `engine3d` says which one built it, `gpuTimings` has the box's own timings). See `forge/gpu/README.md` and `research/forge-gpu.md`.

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
| `FORGE_3D` | `tripo`; `local` builds the model on our GPU box first (Tripo stays the fallback) |
| `FORGE_3D_URL` / `FORGE_3D_KEY` | the GPU box (`http://<private ip>:8790`) and its key (`FORGE3D_KEY` in the box's `/etc/forge3d.env`) |
| `FORGE_3D_TIMEOUT` | `90` seconds before falling back to Tripo |
| `FORGE_PORT` / `FORGE_BIND` | `8787` / `127.0.0.1` |
| `FORGE_ALLOWED_ORIGINS` | the Vite dev and preview origins on localhost, plus the hosted test pages (https://54-149-60-196.sslip.io) |
| `FORGE_MAX_ACTIVE` | `3` forges at once |

Only pages from `FORGE_ALLOWED_ORIGINS` can call the API from a browser, so a random website can't spend our credits through it.
