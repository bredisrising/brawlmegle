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
   exports `rigged.glb` and `model.glb` (no skeleton). Every skin is checked (`rig_check.py`: each limb owned by its
   bones, no bone owning the mesh), and a failed check moves on to the next path: bone heat on a flood-filled solid
   (TRELLIS.2's meshes are hollow shells, which the plain remesh sometimes shatters), then envelope weights.
4. **The game's rig check** (`forge/rigcheck.js`, installed next to the optimizer) poses the result like the game. If
   it fails, the box re-rigs with the rigger's next attempt plan (`--attempt 2`: envelope weights, `3`: a finer solid)
   and sends the best one. The job's `report` says which path made the rig (`rig`), its own check (`rig_ok`, `check`),
   the game's check (`game_check`) and every try (`tries`).
5. **The face** (`face_project.py`, with `FORGE3D_FACE_PROJECT=1`; off by default): TRELLIS.2's face is soft, the
   sheet's is crisp and straight-on. The model is drawn from the front into the sheet's frame (bounding boxes, then an
   ECC fit of the silhouettes), MediaPipe's face landmarks on the sheet and on that drawing give a warp that puts the
   sheet's eyes and mouth on the model's, and every front-facing texel of the head takes the sheet's color, feathered
   by how squarely it faces the camera, a depth test and the sheet's silhouette (around the face only the sheet's
   detail is kept, on TRELLIS's tone, so hair and neck blend in). It writes into the base-color image (upscaled to
   2048 when the face has fewer texels than the sheet has pixels), so mesh, UVs and rig are untouched. A sheet whose
   head is turned (its features miss the model's by over 6% of the face width) keeps TRELLIS's face. ~1.5 s of CPU
   after the rig, plus ~0.5 s in the optimizer for the bigger texture; the job's `face` says what it did.
   `forge/gpu/face-rescue.mjs` paints fighters forged before it (a face-only job: no new model, no re-rig).

## API (`server.py`, port 8790)

| Call | Returns |
|---|---|
| `POST /jobs` `{image, model?, settings?, face?, faceOnly?}` (base64 sheet; `model`: a GLB to rig only; `settings`: pipeline, steps, faces, texture, remesh for one job; `face`: true/false overrides `FORGE3D_FACE_PROJECT` for this job; `faceOnly`: `model` is already rigged, only paint its face) | `202 {id}` (`503` while warming up, `429` if 6 are queued) |
| `GET /jobs/:id` | `{status: queued, model, rig, done or failed, timings, error, rigged, optimized, previews, face}` (`face`: `{painted, seconds, skipped?, face: the landmark match}` when the face step ran; `timings.face` too) |
| `GET /jobs/:id/voxels.bin`, `/shape.glb` | the previews, as soon as `previews` lists them: stage 1's sparse voxels (uint16 resolution, then x, y, z bytes, z up) and the untextured shape (12k faces, y up) |
| `GET /jobs/:id/rigged.glb`, `/rigged.orig.glb`, `/model.glb` | the GLBs: rigged (optimized by `optimize.js` when `optimized`), its unoptimized original, unrigged (jobs are kept 15 min) |
| `GET /health` | `{ok, ready, queued, settings}` (no key needed) |

Every call but `/health` needs `x-forge3d-key`. The forge uses it when `FORGE_3D=local` (see `forge/README.md`).
One GPU thread makes models and one CPU thread rigs them, so two forges in a row overlap.

## Run it

The live box is `i-02b680f2662c0b82f` (g6e.xlarge, us-east-1d, 54.161.35.172): us-west-2 had no L40S capacity, so
every `aws.sh` call for it needs `FORGE3D_REGION=us-east-1`. On bingus:

```
export FORGE3D_REGION=us-east-1                  # where the box lives (default us-west-2)
bash aws.sh status | stop | start                # ready ~4 min after a start
FORGE3D_TYPE=g6e.xlarge FORGE3D_SUBNET=subnet-... bash aws.sh launch   # a new box: key pair, SG, instance, EIP
tar czf /tmp/gpu.tgz gpu && scp -i ~/.ssh/brawlegle-gpu.pem /tmp/gpu.tgz ubuntu@IP:   # then on the box:
#   mkdir -p forge-gpu && tar xzf gpu.tgz -C forge-gpu --strip-components=1 && sudo bash forge-gpu/setup.sh
bash aws.sh ssh sudo journalctl -u forge3d -f    # "ready" after the warm-up
bash aws.sh ssh 'sudo shutdown -h 09:00'         # auto-stop at 2 AM Pacific (UTC clock); `sudo shutdown -c` cancels
```

`setup.sh` takes about an hour the first time on 4 vCPUs (CuMesh alone compiles for ~30 min) and is safe to re-run
to update the code. The first real job after a start runs once at ~105 s while FlexGEMM tunes its kernels; the
tuning is saved in `/root/.flex_gemm/`, so later jobs and restarts stay at ~26 s.

`setup.sh` installs everything under `/opt/forge3d` (conda env, TRELLIS.2 and its CUDA extensions, 17 GB of weights,
Blender 5.2, the app) and a systemd unit (`forge3d`, restarts on failure, starts on boot). Settings and the key are in
`/etc/forge3d.env` (root only):

| Variable | Default |
|---|---|
| `FORGE3D_KEY` | random, made by `setup.sh` |
| `FORGE3D_PIPELINE` | `1024_cascade` (TRELLIS.2's best; `512` is faster and softer) |
| `FORGE3D_STEPS` | `8` sampling steps per stage (12 is TRELLIS's default: ~3 s more, same fighter) |
| `FORGE3D_FACES` / `FORGE3D_TEXTURE` | `40000` / `1024` (60000 / 2048: ~6 s more bake and export, same fighter at fight distance) |
| `FORGE3D_YAW` | `0`: extra turn (degrees) before the rigger's own facing check |
| `FORGE3D_FACE_PROJECT` | `0`: `1` paints the sheet's face onto every model (`face_project.py`) |
| `FORGE3D_FACE_MODEL` | `face_landmarker.task` next to the pose model (`weights.py` downloads it) |
| `FORGE3D_IDLE_STOP_MIN` | `0` (never): power off after this many minutes with no forge (the live box: `15`) |
| `FORGE3D_WARMUPS` | `2` warm-up runs at startup (the live box: `1`; the second only logs the steady-state time) |
| `FORGE3D_LOW_VRAM` | unset: models stay on the card unless it has under 20 GiB (they need ~16 GiB, a run ~3.5 more); `1`/`0` forces it |

After changing it: `sudo systemctl restart forge3d`.

### Only paying while it forges

An idle GPU costs as much as a busy one (~$1.86/h for this box), so the box powers itself off after
`FORGE3D_IDLE_STOP_MIN` minutes with nothing to do (a stopped box costs only its disk, ~$16/month). It comes back on
its own: the forge server marks the GPU "wanted" when someone opens the scan (`GET /api/capacity`) or a forge needs it,
and `waker.sh` on bingus (which has the AWS key; the game server never does) polls `GET /api/gpu/wanted` every 5 s and
starts the box if it's stopped, as the first GPU AWS has free: g6e.xlarge (L40S), else g6.2xlarge (L4), else g5.2xlarge
(A10G); a stopped box often can't get an L40S back (`research/forge-gpu.md`). From cold it's ready in about 3.5 min (boot ~1 min, model load ~2 min, one warm-up
run); meanwhile the forge waits (`FORGE_3D_WARMUP_WAIT`, 6 min) and the player sees "Firing up the 3D forge". Forges
within the next 15 minutes find it warm. Set up the waker once on bingus:

```
mkdir -p ~/.config/brawlegle && (umask 077; echo "$FORGE_GPU_WAKER_KEY" > ~/.config/brawlegle/waker-key)
bash waker.sh install                            # user service brawlegle-gpu-waker (systemd, lingering)
journalctl --user -u brawlegle-gpu-waker -f      # "wanted and stopped: starting ..."
```

The game server needs the same key as `FORGE_GPU_WAKER_KEY` in `/etc/brawlegle/forge.env`.

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

The rigger alone: `blender -b --factory-startup -P rig_blender.py -- in.glb landmarks.json out.glb [--static model.glb] [--attempt N]`
(landmarks from `python landmarks.py pose_landmarker_heavy.task sheet.png landmarks.json`). Its weight check on any
rigged GLB: `blender -b --factory-startup -P rig_check.py -- rigged.glb [...]`.
