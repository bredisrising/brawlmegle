# Forge GPU box

The forge's own image-to-3D + rigging service, so a fighter doesn't wait on Tripo (and its credits). Model sheet in,
textured Mixamo-rigged GLB out, the same file the game already loads from Tripo. Why and how fast:
`research/forge-gpu.md`.

1. **TRELLIS.2-4B** (Microsoft, MIT) turns the sheet into a textured PBR mesh (`gen3d.py`). Two gated pieces of the
   stock pipeline are swapped for open copies: DINOv3 from timm's ungated mirror, BiRefNet (MIT) for background removal.
2. **MediaPipe Pose** finds the joints on the sheet (`landmarks.py`), next to step 1. If it finds no body, the joints
   come from average A-pose proportions.
3. **Blender** (`rig_blender.py`, headless) turns the model to face +x, scales it to 1 m and fits a Mixamo skeleton
   (`mixamorig:Hips` ... `RightToeBase`) to the joints. It skins the mesh with bone heat on a watertight voxel copy and
   exports `rigged.glb` and `model.glb` (no skeleton).

## API (`server.py`, port 8790)

| Call | Returns |
|---|---|
| `POST /jobs` `{image}` (base64 PNG/JPEG of the sheet) | `202 {id}` (`503` while warming up, `429` if 6 are queued) |
| `GET /jobs/:id` | `{status: queued, model, rig, done or failed, timings, error, rigged}` |
| `GET /jobs/:id/rigged.glb`, `/model.glb` | the GLBs (jobs are kept 15 min) |
| `GET /health` | `{ok, ready, queued, settings}` (no key needed) |

Every call but `/health` needs `x-forge3d-key`. The forge uses it when `FORGE_3D=local` (see `forge/README.md`).
One GPU thread makes models and one CPU thread rigs them, so two forges in a row overlap.

## Run it

```
bash forge/gpu/aws.sh launch                    # on bingus: key pair, security group, g6e.2xlarge, Elastic IP
scp -i ~/.ssh/brawlegle-gpu.pem -r forge/gpu ubuntu@IP:forge-gpu
bash forge/gpu/aws.sh ssh sudo bash forge-gpu/setup.sh  # ~40 min the first time; re-run to update the code
bash forge/gpu/aws.sh ssh sudo journalctl -u forge3d -f # "ready" after the warm-up (about 2 min)
bash forge/gpu/aws.sh stop | start | status
```

`setup.sh` installs everything under `/opt/forge3d` (conda env, TRELLIS.2 and its CUDA extensions, 17 GB of weights,
Blender 5.2, the app) and a systemd unit (`forge3d`, restarts on failure, starts on boot). Settings and the key are in
`/etc/forge3d.env` (root only):

| Variable | Default |
|---|---|
| `FORGE3D_KEY` | random, made by `setup.sh` |
| `FORGE3D_PIPELINE` | `1024_cascade` (TRELLIS.2's best; `512` is faster and softer) |
| `FORGE3D_STEPS` | `12` sampling steps per stage |
| `FORGE3D_FACES` / `FORGE3D_TEXTURE` | `60000` / `2048` |
| `FORGE3D_YAW` | `0`: extra turn (degrees) before the rigger's own facing check |

After changing it: `sudo systemctl restart forge3d`.

## Or on Hugging Face

`hf_space.py` puts the same service in a private Space, using HF_TOKEN (a write token) from the env or the root `.env`:

- **ZeroGPU** (`zerogpu/`, needs HF PRO): a Gradio app on HF's shared GPUs with Microsoft's own TRELLIS.2 Space
  stack (torch 2.11 and prebuilt CUDA extensions). Only the TRELLIS.2 call holds a GPU; the landmarks and the
  Blender rig run on the Space's CPU. GPU time counts against the caller's daily ZeroGPU quota. The forge
  calls it with `FORGE_3D=gradio`.
- **Docker** (`docker-space/`, dedicated `a100-large`, `l40sx1`, ..., billed per minute while running): the same
  image as the AWS box, with the same job API (`FORGE_3D=local`).

```
python forge/gpu/hf_space.py push --variant zerogpu && python forge/gpu/hf_space.py hardware zero-a10g
python forge/gpu/hf_space.py push --variant docker && python forge/gpu/hf_space.py hardware a100-large --variant docker
python forge/gpu/hf_space.py status [--variant docker]    # prints FORGE_3D_URL
python forge/gpu/hf_space.py pause [--variant docker]
```

The forge then needs `FORGE_3D_URL`, `FORGE_3D_KEY` (`push` appends a new one to `.env` if there's none) and
`FORGE_3D_HF_TOKEN` (a token that can read the Space). The weights download on the first start (about 17 GB).

## Without a GPU

`FORGE3D_FAKE_GLB=some.glb` (server.py and zerogpu/app.py) skips TRELLIS and "generates" that file every time; the HTTP, landmark and rig steps
are real. It needs Python with `mediapipe pillow numpy`, a Linux Blender and the
[pose model](https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task)
(on WSL, run it without `DISPLAY`: the service already strips it for Blender):

```
FORGE3D_KEY=dev FORGE3D_WORK=/tmp/f3d FORGE3D_FAKE_GLB=model.glb FORGE3D_POSE_MODEL=pose_landmarker_heavy.task \
  FORGE3D_BLENDER=~/blender-5.2.1-linux-x64/blender python forge/gpu/server.py
```

The rigger alone: `blender -b --factory-startup -P rig_blender.py -- in.glb landmarks.json out.glb [--static model.glb]`
(landmarks from `python landmarks.py pose_landmarker_heavy.task sheet.png landmarks.json`).
