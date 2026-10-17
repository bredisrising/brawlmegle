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

1. **Brief** (`gpt-5.4-mini`, about 3 s): reads the photos and returns JSON with name, distinctive features, archetype, outfit upgrade, prop, palette and scout report.
2. **Model sheet** (`gpt-image-2`, about 11 s at low quality): full-body A-pose caricature on gray. This is what the image-to-3D step will get.
3. **Card art** (about 11 s): same character in a fighting stance, using the sheet as the reference.
4. **3D model + rig:** not wired yet. It goes next to step 3 once we pick a provider. Until then `glbUrl` stays empty and the game uses the default model.

Prompts live in `prompts.js`. They're v1 and the look isn't decided, so tune them freely.

## Settings (env, all optional)

| Variable | Default |
|---|---|
| `FORGE_IMAGE_MODEL` | `gpt-image-2.5-flare` (about 12 s at medium; also `gpt-image-2.5-sunburst`, `gpt-image-2`) |
| `FORGE_IMAGE_QUALITY` | `medium` (`low` is cheaper and faster for testing) |
| `FORGE_BRIEF_MODEL` | `gpt-5.4-mini` |
| `FORGE_PORT` / `FORGE_BIND` | `8787` / `127.0.0.1` |
| `FORGE_ALLOWED_ORIGINS` | the Vite dev and preview origins on localhost |
| `FORGE_MAX_ACTIVE` | `3` forges at once |

Only pages from `FORGE_ALLOWED_ORIGINS` can call the API from a browser, so a random website can't spend our credits through it.
