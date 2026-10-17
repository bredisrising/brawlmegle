# Body input best practices: webcam to fighting-game intent

_Research date: 2026-10-17. Scope: turning body motion seen by a laptop webcam or phone into fast, accurate, skill-rewarding fighting-game input for Brawlegle, with ~18 hours of build time left._

**Bottom line.** No off-the-shelf model gives reliable fist depth from one frontal webcam. Shipped camera games didn't win on tracking fidelity. They won by:

- seeing the motion from a good angle,
- reacting at motion *onset*,
- never dropping an input, and
- designing the fight so 150–250 ms of lag fits inside the move.

Our biggest wins are therefore geometry, both camera placement and 2D foreshortening cues, plus earlier commits and forgiving fight design. A better model comes after those.

**How this was researched.** Four parallel research passes plus my own reading. Partway through, the session's shared web-search limit ran out, so later facts come from fetching known pages directly. Anything that couldn't be checked is marked **[unverified]**. Older sources carry their year.

---

## (a) What to do in the next 18 hours (ranked)

| # | Do this | Why | Effort |
|---|---|---|---|
| 1 | **Take the camera off-axis by about 45°**, rather than asking players to turn away from the screen. Put the game on a shared screen in front and angle each laptop or webcam in from the side, or turn the laptops and keep players facing them in a bladed boxing stance. Teach "stand like a boxer" in the tutorial. | Your synthetic tests already show 45° fixes the invisible straight punch. A boxing stance is naturally bladed. Every depth method below is weaker than simply changing the view. | 0.5–1 h (booth layout, tutorial text, recalibrate thresholds) |
| 2 | **Add 2D foreshortening cues for "toward the camera" strikes** to the limb reader. Don't rely on z. Cues: projected shoulder→wrist length collapsing against the arm length calibrated in the T-pose (\|dz\| ≈ √(L² − l²)), the elbow rising to shoulder height, the wrist moving over the torso or face box, the elbow's visibility dropping, and the shoulder width shrinking (torso twist on a cross). | In any view this catches the punch that 2D wrist travel misses. MediaPipe's z error is the same size as a punch (§2). | 2–3 h |
| 3 | **Commit at onset and confirm later.** (i) Compute onset velocity from raw or lightly filtered positions, not the One Euro output. In simulation that saves 33–67 ms (§5). (ii) Have the engine and director *use* the existing `anticipate` intent to start a generic windup at once. In the current tree, `anticipate` is emitted for arms only and nothing outside `src/intent` consumes it. (iii) Confirm the strike when displacement crosses `strikeDist`, not when the limb decelerates, which costs about the whole punch duration. (iv) If the strike isn't confirmed, branch the windup into a feint or guard rather than showing nothing. | The genre's top failure is input that is silently dropped (Fighters Uncaged). Kinect's gesture tooling split "trigger" from "progress" for exactly this reason (§3, §4). | 2–4 h |
| 4 | **MediaPipe configuration.** Switch `pose_landmarker_lite` to `pose_landmarker_full`: about 17 mAP better on yoga, roughly 10% slower on 2021 hardware. Keep `numPoses: 2` *deliberately*. With one person in frame, the person detector then reruns every frame and MediaPipe's built-in smoothing (One Euro, beta 80, and a visibility low-pass at alpha 0.1) is **off**. With `numPoses: 1` in VIDEO mode it is **on**, stacked under yours. Measure dropouts when the fist covers the face, because the BlazePose detector keys on the face. | Cheap accuracy gain and less hidden lag. The detector-per-frame behaviour silently flips back to ROI tracking once the other player walks into frame (they stand 1.5 m away), so frame the camera tightly. | 1 h, plus 2–3 h to move inference into a Web Worker if the main thread is contended |
| 5 | **Light and camera settings.** Buy one or two LED panels or clamp lights ($20–40) and light players from the front. In Chrome, set `exposureMode: 'manual'` and then `exposureTime` in two separate calls where `getCapabilities()` allows it. Request `frameRate: {ideal: 60}` and check `getSettings()`. Optional: a 60 fps webcam (Logitech C922 720p60 or Elgato Facecam MK.2 1080p60, about $120 each). | Dim light makes webcams lengthen exposure (more blur) and drop to 15–24 fps. A fist at about 8 m/s moves about 25 cm per 30 fps frame. | 1 h (+ a store run) |
| 6 | **Measure, replay, tune on novices.** Log `performance.now() − captureTime` at the moment intent is emitted. Build the recorded-PoseFrame replay source the spec already plans. Record teammates doing prompted "JAB NOW / KICK NOW" moves, which gives free labels. Replay BoxingVI's 2D punch keypoints too. Grid-search thresholds. Tune on non-fighters. | Dance Central's two most important tools were skeleton record/playback and testing with novices. Without numbers you're guessing. | 2–3 h |
| 7 | **Forgiving fight design in the resolver and director.** Fixed, generous, *telegraphed* defense windows (Arkham counter icon). Strikes have travel time, so lag lives inside the move (ARMS). A whiffed strike doesn't break the combo, and anything can cancel into a dodge (Spider-Man). Stamina slows flailing, so input is never rejected (Creed, The Fight). Normalize per-player speed (already done via `typicalSpeed`; Thrill of the Fight does the same). Sell impact with hit-stop, shake and sound, not tracking. Always show the player's skeleton. | This is how shipped games turned 90–150 ms Kinect lag and noisy reads into fun. | 2–4 h, spread across the team |
| 8 | **Stretch, only if 1–2 still fail on real players.** Pick one: **(a) a phone as a side camera** running the same `CameraSource` and streaming PoseFrames through the existing remote-source path, where a forward punch becomes about 80 px of sideways motion (3–5 h); or **(b) a phone IMU in a $10 running armband**, using DeviceMotion as a sharp onset trigger while vision still picks the limb and direction (2–3 h; needs HTTPS and an iOS permission tap, and covers arms only). | Both are cheap ways to get real signal for forward punches. | 2–5 h |
| 9 | **Optional parallel track for a free teammate: RTMPose on onnxruntime-web.** Use RTMPose-s or m (Apache-2.0), the Halpe26 variant for foot points. WebGPU with WASM fallback, a fixed crop of the play area, run every frame. A/B it against MediaPipe on the recorded clips. Ship only if it measurably wins. | Top-down models running every frame can't lose a fast limb outside a stale crop. RTMPose-m scores 75.8 COCO AP in about 11 ms on a desktop CPU with ORT. No browser FPS has been published. | 4–6 h |

**Skip for this weekend:** monocular depth models (≥100–200 ms per frame in the browser and unproven on fists), 2D→3D lifters (no browser port; unproven on punches), cloud pose or SMPL (round trip too slow), depth cameras and ARKit (native bridge, stock; ARKit body tracking breaks on iOS 26.0/26.1 LiDAR iPhones), NTU-pretrained action GCNs (2–3 s windows, wrong classes), VLMs (≤1 fps), and training a classifier unless someone is idle.

## (b) After the hackathon: best-in-class version

1. **Pose:** RTMPose-m or RTMW (Apache-2.0) on onnxruntime-web WebGPU in a worker fed by `MediaStreamTrackProcessor`, run every frame at 60 fps under bright light. Fine-tune on your own punch and kick clips with motion-blur augmentation; PoseBench found blur one of the most damaging corruptions. Evaluate YOLO26-pose and YOLO27-pose when it ships; they are AGPL unless you buy the enterprise license.
2. **Depth from views, not models:** standard setup of front camera plus side phone, with a one-time calibration (a person walking around is enough for rough extrinsics) and triangulated wrists and ankles. Alternatively, a small causal lifter that takes calibrated bone lengths (PriorFormer-style) or streams (MoViD-style). Use an Orbbec Femto Bolt only as ground truth during development.
3. **Learned causal intent model:**
   - Log consented gameplay with prompted labels.
   - Annotate an "action point" per strike (Microsoft's Action Points framing).
   - Train a per-frame causal TCN/GRU or streaming GCN (CoST-GCN) with JCR-RNN-style class plus start-time regression.
   - Pretrain on BABEL/AMASS and CMU boxing projected to 2D through random webcam-like cameras with MediaPipe-like noise; optionally distil from a whole-clip teacher.
   - Add one-shot per-user enrollment ("show me your jab").
   - Keep the rules as a fallback and as the trigger stage.
4. **Fight feel:** full commit-then-confirm with rollback-style correction of speculative strikes. Telegraph-driven defense. Strike travel time as a design pillar (ARMS). Optional IMU wristbands as a "pro" tier.
5. **Latency engineering:** a photodiode or clock-in-frame rig for glass-to-glass numbers, a per-stage budget, and equal input delay for host and remote players.

---

## (c) Evidence

### 1. Real-time pose estimation

**MediaPipe Pose Landmarker (what you're using).**
- **Versions:** `@mediapipe/tasks-vision` went 0.10.21 (Feb 2025) → 0.10.32–0.10.35 (Jan–Apr 2026) → **1.0.0 (2026-07-28)** → 1.1.0 (2026-10-06, adds per-landmark presence scores on web and fixes OneEuro landmark drift) → 1.1.1 (2026-10-14, LiteRT 2.3.0) ([npm](https://registry.npmjs.org/@mediapipe/tasks-vision), [releases](https://github.com/google-ai-edge/mediapipe/releases)).
- **No new pose models:** the bucket still holds only the April 2023 `.task` files: lite 5.8 MB, full 9.4 MB, heavy 30.7 MB, 33 landmarks, 224 px detector / 256 px landmarker ([bucket](https://storage.googleapis.com/mediapipe-models?prefix=pose_landmarker/), [guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker)).
- **Web delegate:** still only `"CPU" | "GPU"`, where GPU means WebGL2. No WebGPU option ([vision.d.ts](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/vision.d.ts)).
- **Threading:** `detectForVideo` is synchronous and blocks the UI thread; Google recommends a Web Worker ([web guide](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js)).
- **Accuracy (BlazePose GHUM, 2021):**

| Model | Yoga mAP | Dance mAP | HIIT mAP |
|---|---|---|---|
| Lite | 45.0 | 53.6 | 53.8 |
| Full | 62.6 | 67.4 | 68.0 |
| Heavy | 68.1 | 73.0 | 74.0 |

  Source: [legacy docs](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/pose.md).

- **Speed (2021 hardware, web runtime):**

| Hardware | Lite | Full | Heavy |
|---|---|---|---|
| 2019 MacBook Pro | 75 FPS | 67 FPS | 34 FPS |
| GTX 1070 | 150 FPS | 130 FPS | 97 FPS |

  Source: [TF blog 2021](https://blog.tensorflow.org/2021/08/3d-pose-detection-with-mediapipe-blazepose-ghum-tfjs.html).

- **Depth (z):** z is "not metric but up to scale", and accuracy and jitter get worse with motion ([model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf)).
- **Tracking vs. detection (verified in source):**
  - In stream mode (VIDEO / LIVE_STREAM), the next crop comes from the previous frame's landmarks. The detector runs only while fewer than `num_poses` poses are tracked ("skip pose detector graph when we successfully track the poses from the last frame") ([pose_landmarker_graph.cc](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/cc/vision/pose_landmarker/pose_landmarker_graph.cc)).
  - `smooth_landmarks` is forced to `use_stream_mode` when `num_poses == 1`. It is not supported for `num_poses > 1`.
  - When on, it applies One Euro (min_cutoff 0.05, beta 80, d_cutoff 1.0) to image landmarks, (0.1, 40, 1.0) to world landmarks, and a visibility low-pass at alpha 0.1 ([pose_landmarks_detector_graph.cc](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/cc/vision/pose_landmarker/pose_landmarks_detector_graph.cc)).
  - **Consequence for us:** `numPoses: 2` with one person means detection every frame (no stale crop) and no hidden smoothing. The model card says the landmarker tolerates only about 10% crop shift and that the detector is face-sensitive, so a fist over the face may cause single-frame dropouts. Measure that, and consider treating a dropout while the wrist rises toward the face as a cue.
  - That last idea comes from a hobby project said to detect forward punches when the wrist and elbow disappear after guard [unverified; page returned 403].

**RTMPose / RTMO / RTMW (OpenMMLab, Apache-2.0).** COCO body figures, 256×192 input ([mmpose RTMPose](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose), [paper 2023](https://arxiv.org/abs/2303.07399)):

| Model | AP | GFLOPs | ORT CPU (i7-11700) | TRT FP16 (1660 Ti) | Snapdragon 865 |
|---|---|---|---|---|---|
| RTMPose-t | 68.5 | 0.36 | 3.2 ms | 1.1 ms | 9.0 ms |
| RTMPose-s | 72.2 | 0.68 | 4.5 ms | 1.4 ms | 13.9 ms |
| RTMPose-m | 75.8 | 1.93 | 11.1 ms | 2.3 ms | 26.4 ms |
| RTMPose-l | 76.5 | 4.16 | 18.9 ms | 3.5 ms | 45.4 ms |

- **Variants:** Body8 and **Halpe26** (26 keypoints including heels and toes, useful for kicks) ship as ONNX.
- **RTMO** (one-stage, 640 px): 68.6 / 72.6 / 74.8 AP for s / m / l. It is only faster than RTMPose with more than 4 people in frame ([RTMO](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmo)).
- **RTMW-l** (133 whole-body keypoints): 70.1 whole-body AP.
- **Project activity:** mmpose's last release was v1.3.0 (Jan 2024), so it is slow-moving. **rtmlib** (onnxruntime-only, no mmcv) is active, with 0.0.16 released 2026-08 ([PyPI](https://pypi.org/project/rtmlib/), [repo](https://github.com/Tau-J/rtmlib)).
- **rtmlib's `PoseTracker`:** with `det_frequency > 1` it reuses previous keypoints as the next box, the same failure mode as MediaPipe tracking. The default of 1 avoids it.
- **In the browser:** the only browser demo found runs RTMW3D-x (369 MB) plus RTMDet-s on onnxruntime-web WebGPU/WASM, with no published FPS ([Harvard MMLA](https://mmla.gse.harvard.edu/tools/rtmw3d)).

**YOLO pose (Ultralytics, AGPL-3.0 or enterprise license).** COCO pose at 640 px input:

| Model | mAP50-95 | CPU ONNX | T4 TensorRT | Size |
|---|---|---|---|---|
| YOLO11n-pose | 50.0 | 52 ms | 1.7 ms | — |
| YOLO11x-pose | 69.5 | — | 12.1 ms | — |
| YOLO26n-pose (Jan 2026, NMS-free) | 57.2 | 40 ms | 1.8 ms | 2.9M params, 7.6 GFLOPs |
| YOLO26x-pose | 71.6 | — | 12.2 ms | — |

- **Sources:** [HF YOLO11](https://huggingface.co/Ultralytics/YOLO11/blob/main/README.md), [pose docs](https://docs.ultralytics.com/tasks/pose/).
- **YOLO27** was announced 2026-09-13 with pose variants, but weights are not yet released ([docs](https://docs.ultralytics.com/models/yolo27/)).
- **Export:** TF.js is gone from the export list; ONNX and LiteRT remain ([export](https://docs.ultralytics.com/modes/export/)). A Transformers.js WebGPU YOLO26 Space exists, with no FPS shown ([Space](https://huggingface.co/spaces/ipepe/YOLO26-WebGPU)).
- **License:** AGPL's network clause means you must publish the source of anything that serves it.

**MoveNet / TF.js (2021).**
- **Speed:** Lightning 104 FPS and Thunder 77 FPS on WebGL on a 2019 MacBook Pro ([TF blog](https://blog.tensorflow.org/2021/05/next-generation-pose-detection-with-movenet-and-tensorflowjs.html)).
- **Claims:** the model card says it is "tuned to be robust on detecting fitness/fast movement… motion blur", best at 3–6 ft ([card](https://storage.googleapis.com/movenet/MoveNet.SinglePose%20Model%20Card.pdf)). Your 2 m is just past that. It also crops from the previous frame.
- **Benchmark:** fastest but least accurate (mAP 0.37) in a 2025 Panoptic comparison ([preprint](https://assets-eu.researchsquare.com/files/rs-7157503/v1_covered_ff6a39f9-f723-4605-994e-f8094d5ada77.pdf)).
- **TF.js status:** effectively in maintenance. Stable 4.22.0 is from Oct 2024 and pose-detection 2.1.3 from 2023. **LiteRT.js** (`@litertjs/core` 2.5.3, Jul 2026) is Google's successor web runtime (WebGPU, WebNN, WASM), with no pose benchmarks ([docs](https://developers.google.com/edge/litert/web)).

**ViTPose, Sapiens and newer models.**
- **ViTPose++-S:** 75.8 AP, top-down, with an ONNX build for Transformers.js ([repo](https://github.com/ViTAE-Transformer/ViTPose), [ONNX](https://huggingface.co/onnx-community/vitpose-plus-base-ONNX)).
- **Sapiens** (ECCV 2024, 0.3–2B params) and **Sapiens2** (Apr 2026, 0.1–5B params, 308 keypoints) are offline-class; Sapiens ran at 0.6 FPS in the 2025 benchmark ([Sapiens2](https://github.com/facebookresearch/sapiens2)).
- **Newer real-time models:** none found that beat RTMO/YOLO26 in 2025–26 [search-limited, unverified].

**Fast motion and occlusion evidence.**
- **PoseBench (2024):** motion blur is among the worst corruptions (ViTPose-H 46.4 mAP under blur), and blur augmentation helps ([arXiv](https://arxiv.org/html/2406.14367v2)). It didn't test MediaPipe, RTMPose or YOLO.
- **2025 Panoptic benchmark:** RTMO most accurate (credited to occlusion handling), with RTMPose-L close behind and faster for single-person scenes.
- **MediaPipe vs YOLOv8 (2025):** MediaPipe lite fastest, YOLOv8 better under occlusion ([ITU](https://research.itu.edu.tr/en/publications/comparative-evaluation-of-mediapipe-and-yolov8-for-real-time-pose/)).
- **Punches toward the camera:** no benchmark covers them.

**Browser runtimes.**
- **WebGPU support** ([status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status), [web.dev Nov 2025](https://web.dev/blog/webgpu-supported-major-browsers)):
  - Chrome: version 113 on Windows, macOS and ChromeOS. Linux from 144 (Intel Gen12+) and 147 (NVIDIA on Wayland).
  - Firefox: 141 on Windows, 145 on Apple Silicon macOS.
  - Safari 26: on by default.
- **onnxruntime-web 1.30.0:** WebGPU EP (`onnxruntime-web/webgpu`), `preferredOutputLocation: 'gpu-buffer'`, and graph capture for static shapes. The docs note WASM can be better for tiny models ([EP docs](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)). No published pose benchmarks.
- **Others:** Transformers.js 4.3.1. MediaPipe stays on WebGL2.

**Native sidecar.**
- **Setup:** Python with rtmlib or Ultralytics owns the camera and streams keypoints over a localhost WebSocket. `Peer.ts` never sends video, so the browser doesn't need the camera.
- **Speed:** RTMPose-m TensorRT about 2.3 ms on a T4-class GPU; about 11 ms on CPU.
- **Cost:** an install on every machine. Windows gives the camera to one app unless the 24H2 multi-app toggle is on ([WindowsLatest](https://windowslatest.com/2024/08/21/windows-11-24h2-will-finally-allow-multiple-apps-to-use-your-camera-at-the-same-time)).
- **Verdict:** only worth it on a laptop with an NVIDIA GPU you control.

### 2. Depth: getting a forward-punch signal

**It's a geometry problem.** A forearm aimed at a single camera is the classic depth-ambiguity case.
- BlazePose GHUM reports 36–45 mm 3D error on yoga at 2–4 m and 121 mm MPJPE for in-the-wild lifting. No separate z error is published. Lite takes 13 ms in Chrome on a 2017 MacBook Pro ([GHUM Holistic](https://arxiv.org/html/2206.11678)).
- That error is roughly the size of a 30–40 cm punch, which matches what you measured.

**Geometric cues: my arithmetic, no paper found.** Assumes a 640 px wide image, ~70° horizontal field of view (f ≈ 457 px) and a player at 2 m.

| Cue for a straight punch at the camera | Signal |
|---|---|
| Elbow rises to shoulder height and flares out | About 50–60 px |
| Projected upper arm (~69 px) and forearm (~62 px) shorten | \|dz\| ≈ √(L² − l²) against the calibrated L. The sign is ambiguous; assume forward. |
| Shoulder width shrinks by cos θ (−13% at 30°), mostly on a cross | Normalize by torso length so stepping in doesn't fake it |
| Elbow visibility drops; wrist overlaps the face or chest box | Boolean |
| Fist size grows from ~21 to ~25 px (+21%) | Too small at 640×480; needs a hand crop from a higher-res frame |

Rule of thumb:
- **Extended:** wrist near guard + elbow up + short projected arm.
- **Guard:** wrist near guard + elbow low + long forearm.

**Temporal 2D→3D lifters.** Human3.6M MPJPE from detected 2D:

| Model | Frames | Params | MPJPE | Causal? | License |
|---|---|---|---|---|---|
| VideoPose3D (2018/19; repo archived 2023) | 243 | ~17M | 49.0 causal / 46.8 | Yes (published variant) | CC BY-NC ([paper](https://ar5iv.labs.arxiv.org/html/1811.11742)) |
| MotionAGFormer-XS (WACV 2024) | 27 | 2.2M, 1.0 GMACs | 45.1 mm | No (seq2seq; run on a window ending now) | Apache-2.0 ([paper](https://arxiv.org/html/2310.16288), [repo](https://github.com/taatiteam/motionagformer)) |
| MotionAGFormer-B/L | 243 | 11.7–19M | 38.4 mm | No | Apache-2.0 |
| MotionBERT (2023) | 243 | 42.5M | 39.2 mm | No | Apache-2.0 ([repo](https://github.com/Walter0807/MotionBERT)) |
| TCPFormer (AAAI 2025) | 81 / 243 | 35.1M | 40.5 / 37.9 mm | No | MIT ([paper](https://arxiv.org/pdf/2501.01770)) |
| PriorFormer (Aug 2025) | short sequences | small | ~36 mm; 1.8 ms CPU | Unclear | Code unclear. Uses bone-length and intrinsics priors; trained on AMASS projected through random cameras ([arXiv](https://arxiv.org/abs/2508.18238)) |
| MoViD (Apr 2026) | streaming buffer | — | view-invariant | Yes | 15 fps on Jetson Orin NX with ViTPose ([paper](https://arxiv.org/html/2604.03299), [code](https://github.com/HKUST-MINSys-Lab/MoViD)) |

No lifter reports wrist depth on punches, and Human3.6M has almost none. I found no browser port; porting MotionAGFormer-XS to onnxruntime-web is an estimated 4–8 h.

**Whole-body and SMPL models.**
- **RTMW3D** (2024, 133 keypoints) has the browser demo above.
- **Multi-HMR ViT-S:** about 34 fps on a V100 ([repo](https://github.com/naver/multi-hmr)).
- **Desktop or offline only:** WHAM ([repo](https://github.com/yohanshin/WHAM)), SAM 3D Body (Meta, Nov 2025, 631–840M params, single image) ([repo](https://github.com/facebookresearch/sam-3d-body)) and Human3R (14–16 fps on an RTX 4090) ([paper](https://arxiv.org/pdf/2510.06219)).
- **Not checked:** HMR2.0, TokenHMR, CameraHMR, PromptHMR [unverified; believed ViT-H, offline].

**Monocular depth models.**
- **Depth Anything V2 Small:** 24.8M params, Apache-2.0. About 7 ms FP16 natively on an RTX 3070, but "under 200 ms" per frame in the browser with Transformers.js and WebGPU ([repo](https://github.com/DepthAnything/Depth-Anything-V2), [benchmark](https://github.com/karadjordjepetrovic/realtime-depth-optimization), [Xenova 2024](https://twitter.com/xenovacom/status/1766284534901887406)).
- **Depth Anything 3 Small** (Nov 2025): about 90–113 ms per frame as a community int8 ONNX ([repo](https://github.com/ByteDance-Seed/Depth-Anything-3), [ONNX](https://huggingface.co/en970/depth-anything-v3-small-onnx)).
- **Video Depth Anything:** streaming mode is experimental and less accurate ([repo](https://github.com/DepthAnything/Video-Depth-Anything)).
- **Depth Pro:** 0.3 s per frame ([arXiv](https://arxiv.org/abs/2410.02073)).
- No evidence any of them resolves a blurred fist 35 cm in front of the chest.

**Hardware options (prices as of 2026):**

| Option | Signal | Cost / effort | Risks |
|---|---|---|---|
| Phone as side camera (same `CameraSource`, streamed like the client laptop) | Forward punch becomes ~80 px of lateral motion | Free; 3–5 h | Placement, second stream, thermals. No published precedent found. |
| Phone IMU in an armband (DeviceMotion) | Sharp onset spike | ~$10; 2–3 h | iOS needs `requestPermission()` from a tap and HTTPS ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/requestPermission_static)). Read `event.interval` rather than assuming a rate ([Chrome sensors](https://developer.chrome.com/docs/capabilities/web-apis/generic-sensor)). Arms only; four phones for two players. A multi-IMU study hit 98.8% punch accuracy ([CiNii](https://cir.nii.ac.jp/crid/1050011771467502976)). |
| iPhone ARKit body tracking | 3D skeleton, ~91 joints, rear camera, A12+; LiDAR not required ([Apple](https://developer.apple.com/documentation/arkit/arbodytrackingconfiguration.md)) | Data OSC app ([App Store](https://apps.apple.com/app/id6447833736)) plus an OSC→WebSocket bridge | 18.8° ± 12.1° joint-angle error vs Vicon ([study](https://doaj.org/article/6d61b23a9283450b845f1a3e77c1f072)). **No valid joints on iOS 26.0/26.1 LiDAR iPhones**, still open in Dec 2025 ([forums](https://developer.apple.com/forums/thread/804899)). Android ARCore has no body tracking. |
| 60 fps webcam | Half the frame interval; less blur if well lit | Logitech C922 720p60, $120 ([Logitech](https://www.logitech.com/en-us/products/webcams/c922-pro-stream-webcam.960-001087.html)); Elgato Facecam MK.2 1080p60, $120 ([Elgato](https://www.elgato.com/us/en/p/facecam-mk2)); Razer Kiyo Pro | Doesn't solve depth. No 120 fps webcam confirmed. |
| Depth camera | Real depth | Orbbec Femto Bolt (Azure Kinect successor, MS Body Tracking SDK, Windows/Ubuntu, ~$418, backordered) ([Orbbec](https://www.orbbec.com/products/tof-camera/femto-bolt/)); RealSense D435i ~$334+ (spun out of Intel Jul 2025; Cognex acquisition announced Sep 2026) ([RealSense](https://www.realsenseai.com/news-insights/news/cognex-to-acquire-realsense-expanding-machine-vision-leadership-into-high-growth-robotic-perception-market/)); OAK-D Lite $169–269 ([Luxonis](https://new-store.luxonis.com/products/oak-d-lite-1)) | Native SDK plus bridge, and store stock. Not this weekend. |

### 3. How shipped games did it

**Latency was always there.**
- Rare put Kinect Sports at about 150 ms, measured with high-speed cameras ([Gamewatcher 2010](https://www.gamewatcher.com/2010-18-06-e3-2010-lag-not-an-issue-for-kinect-says-rare-studio-not-casual), [RareGamer](https://raregamer.co.uk/?p=749)).
- Leaked specs listed Kinect v1 at 90 ms and v2 at 60 ms ([MCV 2013](https://www.mcvuk.com/kinect-2-specs-leaked-hours-before-ps4-reveal/)).
- Reviewers still felt about half a second per punch in Kinect Sports boxing, the weakest event ([Digital Trends](https://digitaltrends.com/gaming/kinect-sports-review), snippet only; [GodIsAGeek](https://godisageek.com/2010/11/kinect-sports-review/)).
- Rare showed body-part prompts slightly early to hide lag.

**The failure that kills these games is dropped or invented input.**
- Fighters Uncaged (2010, Metacritic 32): the fighter "just stands there like a lemon" about 10% of the time. About a third of punches registered and moves fired that the player never made ([Wikipedia](https://en.wikipedia.org/wiki/Fighters_Uncaged), [PureXbox](https://www.purexbox.com/reviews/2010/11/fighters_uncaged_360)). Its defense meant reading wind-ups that got subtler as you progressed, stacked on unreliable recognition.
- Kinect Star Wars was praised for rarely making you repeat a move ([Wikipedia](https://en.wikipedia.org/wiki/Kinect_Star_Wars)).

**What worked:**
- **Dance Central (Harmonix):**
  - Detection was built to degrade gracefully on noisy or "crumpled" skeletons.
  - A skeleton record/playback tool with debug views was essential.
  - Moves were tuned with people who had almost no dance experience, because testers misjudged their own skill ([postmortem](https://www.gamedeveloper.com/production/postmortem-harmonix-s-dance-central-2010-)).
  - They taught one canonical gesture with feedback instead of chasing every variant ([Engadget, MIGS 2010](https://www.engadget.com/2010-11-08-harmonix-details-design-process-behind-dance-centrals-kinect-ui.html)).
  - Talk: Dean Tate, "Break it Down!", GDC Europe 2011 ([Vault](https://gdcvault.com/play/1014957/Break-it-Down-How-Harmonix)).
- **Kinect Visual Gesture Builder (v2):**
  - A discrete AdaBoost trigger, smoothed by a 1–10-frame sliding-window sum against a threshold, with a per-gesture "weight of false positives".
  - The trigger gates a random-forest *progress* regressor ([MS docs](https://learn.microsoft.com/en-us/previous-versions/windows/kinect/dn785522(v=ieb.10)), [RFRProgress](https://msdn.microsoft.com/en-us/library/dn785523.aspx)).
  - That trigger-then-refine structure is the one to copy.
- **Kinect Human Interface Guidelines** ([v1.8](https://www.slideshare.net/slideshow/xbox-one-kinect/40801572), [2.0 PDF](https://download.microsoft.com/download/6/7/6/676611B4-1982-47A4-A42E-4CF84E1095A8/KinectHIG.2.0.pdf)):
  - Innate gestures over learned ones; at most about six, separated by direction.
  - 30 fps misses very fast gestures.
  - Don't make players wait for an animation before they can repeat a gesture.
  - Show a "user viewer"; pause and guide on tracking loss.
  - Tunable thresholds; design for body-size variation.
- **The Fight: Lights Out (PS Move, 2010):**
  - Its "1:1" punches felt "weak regardless of speed or force".
  - Tracking was lost every bout, and two-handed special gestures were too slow ([Engadget](https://www.engadget.com/2010-11-16-the-fight-lights-out-review.html)).
  - Its stamina system penalized flailing through game rules ([Push Square](https://www.pushsquare.com/reviews/2010/11/fight_lights_out_ps3)).
  - Lesson: fidelity without exaggerated impact feels weightless.
- **ARMS (2017):**
  - Arms travel, so "it takes a bit of time for them to impact", and play is about timing and the gaps between hits.
  - Punches curve mid-flight: a straight punch feints, a curved one punishes the dodge.
  - New players flail at first, then settle ([Famitsu interview with Yabuki](https://miketendo64.com/2017/02/06/an-extensive-famitsu-interview-kosuke-yabuki-arms/), [NintendoEverything](https://nintendoeverything.com/arms-producer-on-the-games-origins-more-news-about-content-to-come-controls-more/)).
  - **Best precedent for hiding 150–250 ms.**
- **Fitness Boxing:**
  - Rhythm-judged Perfect/OK, with weak motions rejected.
  - Wind-ups triggered punches early, and with no latency calibration players learned to punch late ([Vooks](https://vooks.net/fitness-boxing-switch-review)).
  - **Ring Fit** avoids the problem with turn-based combat ([Wikipedia](https://en.wikipedia.org/wiki/Ring_Fit_Adventure)).
- **Thrill of the Fight (VR):**
  - Each hit is judged on its own for velocity and location.
  - The developer says velocity is over-weighted because the game "doesn't know enough about the body mass".
  - A per-player auto-adjust multiplier means "1x is not intended to be the real value" ([Steam dev post 2021](https://steamcommunity.com/app/494150/discussions/0/3163190952003947285)).
- **Creed: Rise to Glory (VR), "Phantom Melee":**
  - The avatar deliberately desyncs from your hands when staggered.
  - "Virtual Stamina" slows its arms after flurries, so flailing gets no rejection message, just worse results ([Road to VR 2018](https://www.roadtovr.com/?p=167500)).
- **Nex Playground (2023–2026):**
  - Single RGB camera and on-device NPU pose; CEO David Lee: "fun over fidelity" ([Notebookcheck, Dec 2025](https://notebookcheck.net/Nex-Playground-became-no-2-US-game-console-by-focusing-on-fun-over-fidelity-says-CEO-David-Lee.1189813.0.html)).
  - Over 1M units sold, $299 ([GamesBeat, Sep 2026](https://gamesbeat.com/nex-raises-150m-in-debt-and-equity-to-take-nex-playground-to-global-market-exclusive-interviews/)).
  - Complaints cover sleeves, patterned clothes, poor light, bystanders and lag (secondary source).
  - No latency figure or GDC talk found.
- **Batman Arkham free-flow:**
  - "Selecting the right move, not long combos" ([Siliconera 2011](https://www.siliconera.com/the-improvements-to-batman-arkham-citys-combat-system/)).
  - Direction plus attack picks the target. Reach and speed grow with the combo until Batman "pinballs". Counters are telegraphed with an icon and resolve automatically ([Shamus Young 2017](https://www.shamusyoung.com/twentysidedtale/?p=36613)).
  - **Arkham Shadow (VR, 2024)** uses real ducks and leans plus direction cues ([UploadVR](https://www.uploadvr.com/batman-arkham-shadow-review/)).
  - GDC 2026: "Punching Across the Room in Batman: Arkham Shadow" (Darcey and Johnsen, Camouflaj) is the most relevant talk ([Vault](https://gdcvault.com/play/1035681/Punching-Across-the-Room-in)). The full talk is members-only; the abstract gives no mechanics.
- **Marvel's Spider-Man (2018):** almost any attack cancels into a dodge, and a whiffed attack doesn't break the combo ([Game Developer](https://www.gamedeveloper.com/design/marvel-s-spider-man-design-analysis)).
- **Owlchemy's "Tomato Presence":** players accept a stand-in for their hand ([Owlchemy](https://owlchemylabs.com/tomatopresence/)). The avatar doesn't have to copy the body exactly.

**Not found or unverified:** Wii Sports Boxing's classifier, Just Dance camera-mode scoring, Sifu and Shadow of Mordor targeting, FightCamp's algorithm (its trackers are IMUs in hand wraps; [FightCamp](https://joinfightcamp.com/trackers/)), Thrill of the Fight 2, FitXR, Supernatural, and any Rocksteady free-flow GDC talk.

**Lessons to apply:**
1. Never show nothing; resolve every onset to *something*.
2. Make lag part of the fiction: travel time and windups.
3. Telegraph defense with fixed, generous windows.
4. One intent, and context picks the move.
5. Calibrate per player.
6. Punish flailing with stamina, not by rejecting input.
7. Keep the gesture vocabulary small and natural; no special gestures.
8. Sell impact separately from tracking.
9. Trigger, then refine.
10. Show the player what the camera sees.
11. Build replay tools and tune with novices.

### 4. Action detection from the skeleton stream

**Learned early-recognition doesn't help at onset.** NTU-60 accuracy by fraction of the clip observed ([TS-GCN, APSIPA 2025](https://apsipa.org/proceedings/2025/papers/APSIPA2025_P207.pdf)):

| Model | 20% | 40% | 100% |
|---|---|---|---|
| TS-GCN | 49.1% | 78.1% | 89.8% |
| InfoGCN++ ([arXiv](https://arxiv.org/abs/2310.10547)) | 44.6% | 73.6% | 85.4% |

- Models trained on full clips need about 80% of the sequence ([PoseOFF 2026](https://arxiv.org/abs/2608.25495)).
- Our first 60–100 ms is about 10–30% of a strike. That's enough for *which limb, roughly which way*, not hook vs uppercut.
- At that point the rules are as good as anything learned.

**Older work on the right problem:**
- **Microsoft's "Action Points" (2012):** Kinect gaming actions (jump, kick, punch, duck…), each with an anchor moment; for a punch it's maximum extension. With 1–3 frames of allowed latency, an online HMM won; with 4 or more, a random forest on joint velocities and angles did ([MSR-TR-2012-68](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/MSR-TR-2012-68.pdf)).
- **MSRC-12 convention:** a detection counts within 10 frames (~333 ms) of the anchor ([arXiv](https://arxiv.org/pdf/1502.01228)).
- **SSNet (2019):** 72% on G3D gaming actions at 10% observed, 270K params, 50 fps ([arXiv](https://arxiv.org/abs/1902.03084)).
- **JCR-RNN (2016):** per-frame class plus start/end regression ([arXiv](https://arxiv.org/abs/1604.05633)).
- **CoST-GCN:** streams ST-GCN frame by frame with up to 109× lower complexity ([arXiv](https://arxiv.org/abs/2203.11009)).

**Pretrained classifiers are a poor fit.**
- **Classes:** NTU has A24 kicking something, A26 hopping, A27 jump up, A50 punching/slapping other person (two-person), A51 kicking other person and A102 side kick. No duck, dodge or guard ([NTU](https://github.com/shahroudy/NTURGB-D)).
- **PYSKL ST-GCN++** on 2D HRNet keypoints: 1.39M params, 89.3% NTU-60 cross-subject, Apache-2.0, unmaintained since 2023 ([PYSKL](https://github.com/kennymckormick/pyskl)).
- **Window length:** MotionBERT, SkateFormer (ECCV 2024), ProtoGCN (CVPR 2025) and BlockGCN classify 64–100-frame (2–3 s) windows ([SkateFormer](https://arxiv.org/abs/2403.09508), [ProtoGCN](https://arxiv.org/abs/2411.18941)).

**Zero-shot and VLM approaches are not real-time.**
- Zero-shot anticipation on NTU with 5 unseen classes: 39.6% at 10% observed ([arXiv 2026](https://arxiv.org/abs/2608.14243)).
- Gemini Live takes JPEG frames at ≤1 fps ([docs](https://ai.google.dev/gemini-api/docs/live)).
- OpenAI realtime takes image snapshots ([docs](https://developers.openai.com/api/docs/guides/realtime-conversations)).
- Good for the commentators, useless for input.

**Labeled punch data to replay now:**
- **BoxingVI (Nov 2025):** 6,915 clips, 6 punch types, 18 athletes, with AlphaPose COCO 2D keypoints and start/end frames. Punches last ≤25 frames at 30 fps. No license stated ([arXiv](https://arxiv.org/abs/2511.16524), [GitHub](https://github.com/Bikudebug/BoxingVI)).
- **Synthetic punch videos:** ST-GCN++ fine-tuned on 10,368 computer-generated punch videos reached 94% on *synthetic* test data ([icSPORTS 2024](https://scitepress.org/publishedPapers/2024/130184/pdf/index.html)).

**Synthetic training data (optional).**
- **HumanML3D captions** (14,616 motions, regex counts) ([repo](https://github.com/EricGuo5513/HumanML3D)): punch 247, jab 57, uppercut 30, kick 487, jump 1,053, duck 34, dodge 67. Labels are per clip.
- **BABEL** has *frame-level* AMASS labels including punch, kick, jump, hop, lean, squat, crouch and duck ([BABEL](https://babel.is.tue.mpg.de/), [labels](https://github.com/abhinanda-punnakkal/BABEL/blob/main/action_recognition/data/action_label_2_idx.json)). AMASS is non-commercial and needs registration ([license](https://amass.is.tue.mpg.de/license.html)).
- **CMU mocap** is "free for all uses", with boxing in subjects 13, 14, 15, 17, 79, 80, 86 and 144 ([CMU](http://mocap.cs.cmu.edu/search.php?subjectnumber=%&motion=box)).
- **Text-to-motion:** MoMask (MIT, 20 fps output) and MDM (MIT, ~0.4 s per sample) ([MoMask](https://github.com/EricGuo5513/momask-codes), [MDM](https://github.com/GuyTevet/motion-diffusion-model)). They likely smooth fast strikes [unverified].
- **Pipeline:**
  1. Auto-label onsets with your own rule detector on the clean 3D.
  2. Project through random cameras (yaw ±60°, pitch ±15°) with MediaPipe-like noise and dropout, at 30 fps.
  3. Train a 64-unit GRU on 8–12-frame windows (<100k multiply-adds per frame, plain TS).
- **Effort:** about 5–8 h, with a real risk it doesn't beat the rules. Precedent: [IMUGPT 2.0](https://arxiv.org/abs/2402.01049).

**Rule-based practice that holds up:**
- **Hysteresis:** MediaPipe's own rep counter uses torso normalization, EMA-smoothed class scores, and an exit threshold set below the enter threshold ([MediaPipe pose classification](https://github.com/google/mediapipe/blob/master/docs/solutions/pose_classification.md)).
- **Trigger then refine:** as in Visual Gesture Builder.
- **Templates only to confirm or pick a subtype, never to trigger:** $1/$P/$Q ([ACE Lab](https://depts.washington.edu/acelab/proj/dollar/index.html)) or Jackknife DTW with 1–2 templates per class and synthetic negatives for rejection ([GitHub](https://github.com/ISUE/Jackknife)).
- **Commit then confirm** is rollback netcode applied to recognition ([GGPO](https://www.ggpo.net/)): play the speculative move during its startup, then convert or cancel.
- **Starting values** (engineering judgement, L = torso length):
  - Rest: <0.5 L/s for ≥100 ms.
  - Trigger: speed >max(2.5 L/s, 0.4 × calibrated peak), more than 0.15 L from the anchor, outward in a torso-aligned frame.
  - Re-arm: within 0.3 L of guard, or after 200 ms.
  - Jump: hip and shoulder midpoints rise >0.15–0.2 L at >1.5 L/s. Use shoulders and nose if the feet are out of frame.
  - Duck: shoulders drop >0.3 L.
  - Lean: the shoulder midpoint shifts >0.25 L from the hip midpoint, or the torso tilts >15–20°. A shrinking shoulder width means a twist, not a lean.
  - Guard: both wrists within ~0.4 L of the nose for ≥150 ms.

### 5. Latency

**Budget.**
- SPEC.md estimates 150–250 ms from camera to intent.
- Street Fighter 6 measures about 57 ms button-to-screen on PS5/PC ([EventHubs 2023](https://www.eventhubs.com/news/2023/jun/05/input-lag-tests-sf6-platforms)).
- An exergame study (n=37) found play tolerant of "hundreds of milliseconds", with a tipping point near **400 ms** ([Durnez, Claypool et al., IEEE ToG 2022](https://web.cs.wpi.edu/~claypool/papers/spaz-22)).
- Players *say* they notice about 85 ms and tolerate about 600 ms of network latency ([Jiang, Claypool et al., WPI-CS-TR-20-02, 2020](https://ftp.cs.wpi.edu/pub/techreports/pdf/20-02.pdf)).
- So 150–250 ms is playable, *if* the game starts reacting at onset.

**The human punch hides part of it.**
- Competition boxers take **357 ± 178 ms** from first movement to contact for straight punches and **477 ± 203 ms** for hooks. The forearm-projection phase of a single cross is 100–223 ms (10 boxers, 3D mocap; [Piorkowski, Lees & Barton, Sports Biomechanics 2011](https://knowledge.lancashire.ac.uk/id/eprint/3757/)). Novices will be slower.
- Peak cross fist speed is about 7–8.5 m/s ([Xu et al., Frontiers 2024](https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2024.1441470/full)), roughly 25 cm per frame at 30 fps.
- The onset is the part a 30 fps camera sees cleanly.
- Detect onset at about 70–100 ms and give the avatar's move a short startup. Its fist then lands about when the real arm reaches full extension, and that is the illusion to aim for.

**Where the milliseconds go:**

| Stage | Cost | Fix |
|---|---|---|
| Exposure, readout, USB, driver | ~1–3 frames [unverified; no rigorous getUserMedia figure found; measure with the clock-in-frame method ([glossary](https://bloggeek.me/webrtcglossary/glass-to-glass/))] | **Light.** In dim scenes, webcam auto-exposure lowers the frame rate ([FTC docs](https://ftc-docs.firstinspires.org/programming_resources/vision/webcam_controls/exposure/auto_exposure/auto-exposure.html), [Framework forum](https://community.frame.work/t/webcam-capture-low-framerates-in-low-light/4387)). Set manual `exposureMode`, then `exposureTime`, in **two** `applyConstraints` calls. Works in Chrome on Windows, Linux and Android; spotty on macOS; not in Safari or Firefox ([webrtcHacks 2022](https://webrtchacks.com/?p=3807)). Some Logitech cameras ignore manual exposure; more light is the fallback. |
| Frame scheduling | 0–16 ms of jitter | Already done: `CameraSource` uses `requestVideoFrameCallback` and `captureTime` (Chrome 83+, Safari 15.4+, Firefox 132+ ([web.dev](https://web.dev/articles/requestvideoframecallback-rvfc))). The spec says `captureTime` SHOULD exist for getUserMedia frames ([spec](https://wicg.github.io/video-rvfc/)). |
| Inference | ~5–30 ms | Move it into a Worker. `MediaStreamTrackProcessor` is worker-only in the spec and works in Chrome and Safari 18+; Firefox is uncertain ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackProcessor), [Mozilla 2024](https://blog.mozilla.org/webrtc/unbundling-mediastreamtrackprocessor-and-videotrackgenerator/)). It drops old frames when you fall behind; `close()` every frame. |
| Smoothing | 33–67 ms (simulated, below) | Detect onset on raw data or a 3-sample least-squares slope. Keep One Euro for rest anchoring and display. |
| Intent decision | ~the full punch, since `strike` fires on deceleration | Commit on `anticipate` and confirm at `strikeDist` (see (a) #3). |
| Network (client → host) | +5–30 ms on LAN | The host player gets an edge. Delay the host's own frames by the measured one-way latency (delay-based netcode idea; [Infil](https://words.infil.net/w02-netcode-p4.html)). |
| Render and display | 1–2 frames | `powerPreference: 'high-performance'` on dual-GPU laptops. The `desynchronized` hint can bypass the compositor, but WebGL needs `preserveDrawingBuffer` and no DOM on top ([Chrome blog](https://developer.chrome.com/blog/desynchronized)). Minor; only if measured. |

**One Euro lag simulation (our parameters, my scratch script).**
- **Setup:** a noise-free minimum-jerk punch at 30 fps through `preprocess.ts`'s extremity filter (`minCutoff 1.6, beta 1.2, dCutoff 1.0`). Onset uses the reader's arm thresholds (`onsetSpeed 1.7`, `onsetDist 0.1`, `strikeDist 0.24`); torso ≈ 0.28 image units.

| Punch | Raw: onset / strikeDist | Current filter | beta 6, dCutoff 4 |
|---|---|---|---|
| 0.6 torso in 200 ms | 67 / 100 ms | 100 / 133 ms | 100 / 133 ms |
| 0.35 torso in 250 ms (small, facing-camera-like) | 100 / 167 ms | **167 / 233 ms** | 133 / 200 ms |

- **What it shows:** the filter costs 1–2 frames, most on small motions, which is exactly the punch that's already hard to see. Real raw data is noisy, so use a short regression slope rather than a raw two-sample difference.
- **Caveat:** this shows the mechanism, not a measured number.

**Latency hiding that shipped.**
- Sony's patent [US 9,674,267](https://www.patentarcade.com/video-game-patent/US9674267/methods-and-apparatus-for-hiding-latency-in-network-multiplayer-games) stretches a pre-hit windup (e.g. 100 → 150 ms) to absorb delay, and holds on the impact frame if the answer is still late.
- The same trick covers camera lag: start a generic windup on `anticipate` and branch once classified.
- Joint prediction (e.g. ALIEN, [CVPR 2025](https://mlanthology.org/cvpr/2025/wei2025cvpr-alien/)) is research-grade. Extrapolating one frame at constant velocity is fine for drawing the player's own skeleton; never use it to decide hits.

---

## Uncertainty and gaps

- **Search limit:** the shared web-search budget ran out. Several items come from search snippets or a single source and are marked; notably Digital Trends and GamesRadar on Kinect and Fighters Uncaged, and the Nex complaints, which are secondary.
- **No browser pose FPS:** I found no published in-browser FPS for RTMPose, RTMO or YOLO-pose on WebGPU. The figures above are native CPU/GPU numbers, and the 4–6 h RTMPose estimate assumes no surprises in pre/post-processing.
- **MediaPipe behaviour:** the `numPoses: 2` reading (detector every frame, no smoothing) is from the source code, not a test. Verify it with a frame-time and jitter readout. The face-occlusion dropout risk is inferred from the model card.
- **Unmeasured cues:** the foreshortening numbers are geometry, not measurements. No paper or benchmark covers punches thrown straight at a webcam.
- **Sources not checked:** Sifu and Shadow of Mordor, Thrill of the Fight 2, FitXR and Supernatural, FightCamp's method, the Just Dance camera mode, Wii Sports Boxing internals, HMR2.0, TokenHMR, CameraHMR and PromptHMR.
- **Code state:** observations about the code (`anticipate` unused outside `src/intent`, strike emitted on deceleration, One Euro settings) reflect the working tree on 2026-10-17, which has uncommitted changes.
