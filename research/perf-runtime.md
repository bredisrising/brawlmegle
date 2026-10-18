# Runtime performance (branch perf-runtime)

Goal: a smooth fight on a typical laptop, with GPU room left for MediaPipe (same GPU). Real 1v1 sessions showed the
host's pose tracker at 6-9 poses/s with 29 fps cameras, which feels like lag. Main result: on a Radeon 780M
(integrated), the tracker goes from **13-16 to 24-32 poses/s**, and the fight goes from 21-27 fps with ~240 hitches
per 15 s to a steady 30-60 fps.

## How it was measured

- `scripts/perf/edge.sh <label> nvidia|amd [run.mjs args]` starts one headless Edge on Windows from WSL, with its own
  profile so it never touches your Edge, then closes it.
  - It runs `scripts/perf/run.mjs` with Windows node over CDP.
  - `amd` passes `--use-adapter-luid=0,81299` (Radeon 780M, standing in for an average laptop); otherwise the RTX 4070 Laptop.
  - The fake camera plays a y4m: `CLIPNAME=`
    - 24 fps boxing close-up;
    - the same clip re-timed to 30 fps;
    - a gym clip with a boxer and his mirror reflection, two full-body people.
- The game is a production build (`vite build --minify false`, so React component names show) served by `vite preview` on :4173.
  - That's the forge's CORS origin; :5173 is the main checkout's dev server.
  - Practice vs the CPU, picking `rico`, with `Math.random` seeded so the CPU's fighter and play repeat.
  - The viewport is 1536x864 @1.25 DPR (1920x1080 drawing buffer).
- In the page:
  - `?perf` (src/director/PerfMonitor.ts): an overlay plus `window.__brawl` with
    - rAF frame intervals;
    - loop CPU ms;
    - GPU ms (EXT_disjoint_timer_query_webgl2 around the composer);
    - renderer.info per whole frame.
  - A stand-in React DevTools hook counts commits and rendered components (works in production builds).
  - Long-animation-frame entries attribute hitches.
  - CameraSource stats: detections/s, camera fps, ms per detection.
  - Every pose delivered to the hub: age (capture to game) and the tracked person's hip x.
- CDP: `Performance.getMetrics` (main-thread task/script/style ms per frame), tracing for GC pauses, and `--profile` for a sampled CPU profile.
- Windows: fight (12-15 s, CPU attacking, HP topped up), hits (forced light/heavy/counter every 300 ms), K.O. and replay.
- `--ablate`: GPU ms with one feature off at a time. `--shots`: screenshots of the fight, a hit and a counter.
- Caveat: headless Edge ticks rAF at 120 Hz. The baseline drew up to 120 fps there; the branch caps at 60 (as on a 60 Hz panel). Compare GPU ms per frame, frame-time stability and hitches, not raw fps.
- Before = main at bc079f8 plus only the perf hook (781aad9). Runs vary by a few poses/s; ranges are 2+ runs.

## Results

### Camera on (the host's real case): 30 fps camera, Practice fight

| | 4070 before | 4070 after | 780M before | 780M after |
|---|---|---|---|---|
| poses/s (fight / hit bursts) | 19-28 / 19-28 | 32 / 32 | 13-16 / 13-14 | 24-26 / 29 (32 in one-pose mode) |
| render fps, frame p95 | 46-82 fps, 25-50 ms | 60, 16.8 ms | 21-27, 83-92 ms | 30-60 (governor), 33 ms at the 30 cap |
| hitches (>1.5x frame) per 15 s | 41-292 | 0-6 | 225-245 | 0 once settled |
| main thread, ms per frame | 9-21 | 4.5-5.5 | 34-44 | 5-8 |
| GPU ms per frame | 3.0-3.6 | 2.0 | 18-22 | 5.3 |
| pose age p50 (capture to game) | 22-40 ms | 30 ms | 63-67 ms | 52-54 ms (two-pose), 25-27 ms (one-pose) |

### No camera (render only): Practice fight with hits

| | 4070 before | 4070 after (full quality) | 780M before | 780M after |
|---|---|---|---|---|
| triangles per frame | 2.22M | 1.04-1.16M | 2.12M | 1.06M |
| GPU ms per frame | 2.7-3.3 | 1.5-2.1 | 15.1-15.6 | ~10 at full look; 4.8-5.6 at the governor's msaa0/px1 |
| hits window: p99 / worst frame | 25 / 117 ms | 16.8 / 26-33 ms | 75 / 108 ms | — |
| GC during hits (10 s) | 48, 90 ms total, max 15.6 | 8, 7.9 ms, max 1.7 | | |
| React | 10 commits/s, 42 renders/s | 9-18 / 37-50 | same | same |

React and layout were never the problem: style+layout 0.1-0.7 ms per frame, a few commits a second. HealthBar,
SuperMeter and PlayerHUD re-render on meter/HP changes only.

### What each GPU cost was (780M, full quality, ablation: GPU ms saved)

| | ms | |
|---|---|---|
| 4x MSAA on the HalfFloat scene target | 8.4 (2x: 5.6) | biggest per-pixel cost on an iGPU |
| background hills (54 x 36.7k triangles, double-sided) | 5.9 | LOD + culling + draw order |
| pixel ratio 1.25 -> 1 | 4.3 | |
| bloom | 3.2 | (half-res bloom: no gain) |
| idle impact pass (an extra full-screen pass every frame) | ~3 | |
| hills drawn before the island (overdraw) | 2.3 | |
| both fighters (main + outline + shadow) | 1.7 | outlines alone 0.6 |
| shadows | 1.1 | shadow map 2048 -> 1024: no gain |

### The pose tracker on the 780M (30 fps camera, levels pinned with `?qlevel=`)

| | poses/s | game |
|---|---|---|
| main thread (old way), 60 fps render | 18 | 23 fps, main thread 38 ms/frame |
| main thread, 30 fps cap | 19.6 | 20 fps |
| worker, 60 fps (msaa0, px1) | 20 | 58 fps |
| worker, 30 fps | 23.5 | 30 fps steady |
| worker, lightest render (no bloom/outlines, px 0.75) | 22.7 | 30 fps |
| worker, 30 fps, **one-pose mode** | **31-32** (full model, 20 ms each) | 30 fps |
| worker, 30 fps, old video recorder on | 19.4 | |
| worker, 30 fps, new video recorder on | 20.8 | |

Past the 30 fps cap, render quality barely buys poses on this GPU: the limit is MediaPipe itself (lite ~45-55 ms a
detection, pipelined). The CPU delegate was slower everywhere (55-90 ms on the 4070's Ryzen 9).

## Changes (in merge order)

1. **Pool effects and fireballs** (Effects.ts, Fireballs.ts).
   - Each burst made new materials and disposed them when done. Disposing the last material of a kind deletes its
     shader, so the next hit recompiled ~5 programs: the 50-120 ms frame on a hit.
   - Layers are now pooled; materials live for the game; every effect is drawn once, invisibly, on the title screen.
   - Hits are now allocation-free: GC during hits went from 48 to 8.
2. **MediaPipe in a worker** (poseWorker.ts, poseModel.ts, CameraSource.ts).
   - `detectForVideo` is synchronous; on the main thread it froze the game 18-26 ms per camera frame on the 4070 and
     50-150 ms on the 780M.
   - Frames go over as `VideoFrame`s, one in flight plus the newest waiting (no queue), and results are stamped with
     the capture time. The scan crops the exact image the pose came from (`source.image`).
   - The in-page path remains as a fallback (no VideoFrame/OffscreenCanvas, or `?poseworker=0`).
   - Fixed a latent bug: a second landmarker (the lite switch, the CPU fallback) failed with "ModuleFactory not set".
3. **Hills** (Hills.ts, hillsLod.worker.ts).
   - Back faces culled: winding checked, 100% outward.
   - Per-row LOD from three's bundled meshoptimizer simplifier, in a worker, error-bounded to 0.5 px on a 1440p
     screen. The nearest row keeps ~73% of its triangles, the far rows 25-35%.
   - Per-hill frustum culling; rows drawn after the opaque things in front of them.
   - 2.1M -> 1.1M triangles, no visible change (screenshots compared).
4. **Impact pass off between impacts** (the output pass then draws straight to the canvas), and **no canvas MSAA** (everything reaches the canvas as full-screen passes).
5. **Frame cap** (Renderer.ts): 60 by default, so a 120/144 Hz laptop doesn't draw every sim tick twice. The sim and the camera still update every animation frame; only drawing is skipped.
6. **Quality governor** (QualityGovernor.ts, quality.ts).
   - Every second it compares detections/s against the camera's fps (2 s windows; target min(24, 0.8 x camera)) and
     the drawn fps against the cap.
   - It steps down after 2 s short and back up after 8 s with room, then waits 3 s for the numbers to settle. A failed
     step up doubles the wait (max 64 s).
   - Load stalls (a gap of 100+ ms), covered screens and the model's start-up aren't judged.
   - Ladder: msaa2, px1, msaa0, 30 fps, one-pose, then no bloom, px 0.75, no outlines.
   - `?qlevel=N` pins a level; `?quality=high` pins full.
7. **One-pose mode** (poseWorker.ts): numPoses 1 as a second landmarker, so switching is instant.
   - Single-pose tracking skips the per-frame person detector. On the 780M that's 31-32 poses/s with the full model,
     and half the pose age. It adds MediaPipe's own smoothing, which two-pose mode avoids on purpose.
   - It keeps to the player: an anchor (hip x, torso size) follows the poses the existing "nearest the center" rule
     accepted. A pose 0.25 of the frame away, or under 55% / over 180% of that torso, is dropped. 8 in a row, or 1 s
     without the player, go back to two-pose until the player has been followed 45 frames.
   - On the mirror clip, the old two-pose rule gave >= 5% of its poses to the reflection; one-pose never left the boxer.
8. **Covered screens**: behind the title, fighter select and the client's waiting screen the scene draws at 4 fps, not 60. Not zero, so models loading meanwhile still compile.
9. **Preloaded model bytes go to MediaPipe** (an incognito window downloaded the 9.4 MB model twice).
10. **Round video** (MatchRecorder.ts) records a clone of the camera track at 15 fps and at most 360 px tall, in VP8 at 250 kbps.

## What's left, and risks

- **One-pose mode**:
  - The anchor thresholds were tuned on two synthetic clips. Check them on booth footage with people walking behind.
  - MediaPipe's smoothing lag wasn't measured separately (pose age fell overall).
- **Pose worker on strong GPUs**:
  - Detection is ~6-9 ms slower than on the main thread. Chrome's GPU process serves the page's draws first, and an
    idle laptop GPU clocks down.
  - It never blocks the game, so it's the better trade. Main-thread pose ages: 22-28 ms; worker: 24-31 ms.
- **The governor probes upward**: a failed step up costs ~5 s of lower pose rate, at most once a minute after backoff.
  It has only run in headless Edge, not in a real 1v1 (the client laptop's camera is watched the same way).
- **Not done (small)**:
  - CameraPip redraws the video every animation frame (~3% of main thread on the 4070); drawing on new camera frames
    would do.
  - HealthBar animates `width` (layout per frame for 0.7 s after a hit); `transform: scaleX` would be compositor-only.
  - Game.record keeps 240 frames with full PoseFrames for the replay (old-generation garbage); `fight.state()`
    allocates per call. Both are in Game.tick, left alone while it was being reworked.
  - A fighter spawning mid-round compiles and uploads on its first frame: `renderer.compileAsync` and
    `initTexture` before adding the model.
  - Bloom's final full-resolution additive pass could fold into the output pass (~1 ms on an iGPU).
- The client laptop's mirror path (JSON frames at 60 Hz) wasn't measured: it was being reworked.
- One 780M run had the browser close during setup; it didn't reproduce in 6 later runs.
