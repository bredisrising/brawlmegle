# Move research: learned classifier, depth on demand, other pose models

_2026-10-17. Measured offline on this branch's code (`research/models/`, `test/research/dump.test.ts`). No game code changed._

## Bottom line

1. **A learned classifier doesn't beat the rules today, and the data is the reason.** Trained on synthetic clips, a gradient-boosted model or a tiny CNN is near-perfect on held-out synthetic data (fake rejection AUC 0.96, 98–99 % style). On real clips it falls to chance: fake AUC 0.50–0.66, and its style accuracy is at best equal to the rules (25/38 vs the rules' 25/38). The synthetic fakes are 85 % waves and head scratches. Real fakes are mostly something else: 38 % are the *other arm* moving during a punch (3 % of synthetic fakes), and the rest are slow form, ducks and blocks.
2. **More real labeled data is what moves the needle.** With one real guided session plus two stock clips in training, the CNN's fake AUC on the held-out session rose to 0.75. On that session it rejected 12 of 15 fakes while keeping 11 of 15 real strikes. That test set is small (30 events), so it's a trend, not a result. The guided test is the right tool for collecting this data; it needs about 20 more sessions before a learned gate is worth shipping.
3. **Depth on demand doesn't work at the reader's onsets.** On the boxer-at-camera clip, the depth "toward" rise in the 2 frames after an onset does not pick out straights. Same-arm AUC is 0.36 (95 % CI 0–0.76), and either arm gives 0.60–0.69 with CIs across 0.5. Hooks come at the camera too, MediaPipe gives the onset to the wrong arm, and at onset + 2 frames the fist isn't out yet. The answer would also arrive about 110–130 ms after onset, against the reader's median confirm at 80 ms. **Don't integrate it.**
4. **Pose models: TBD**
5. **The cheapest wins are in the rules, and the data shows which ones.** The single most common real fake is the other arm firing during a real punch (38 % of real fakes). Of the 53 strike features tested, the two best on real data are "the other hand moved the same way" (AUC 0.70) and the head's vertical motion relative to the shoulder (0.71). These are best-of-53 picks on 75 events, so treat them as hints for the rules agent, not results. Shipped hobby systems use the same tricks: a cross-hand lockout and a hook/straight split by elbow angle at peak (see Q4).

## The data

| Set | What | Arm strike events from the reader | Labels |
|---|---|---|---|
| Synthetic | `test/intent/synth.ts`, 22 conditions × 5 seeds × 120 s (sitting/standing, camera angles, 15–60 fps, noise, combos) | 3,830 (3,053 real, 777 fake) | exact, per move |
| guided-233104 (friend) | Tuner guided test, 20 prompts | 21 (15 real, 6 fake) | prompt windows |
| guided-233624 (user) | Tuner guided test, 20 prompts | 28 (13 real, 15 fake) | prompt windows |
| stock-36564 | Shadowboxing from behind/side, first 12.8 s | 7 (5 real, 2 fake) | hand labels |
| stock-40256 | Boxer punching at a handheld camera, 6.3 s | 10 (5 real, 5 fake) | hand labels |
| stock-49576 | Slow wing-chun form facing the camera, 36 s | 9 (all fake) | all negative |

That is **75 real events (38 real strikes, 37 fakes)**. Every real-data number below has wide error bars: with 38 strikes, ±1 strike is ±2.6 points. The server holds no other guided sessions (checked `/var/lib/brawlegle/samples`: the same two plus empty test uploads).

Ground truth for an event is the label it falls in: the same arm in a strike label gives that style. Anything else is "none": a strike during a stay-still, wave, scratch, block, duck or lean prompt, a wrong-arm strike, or any strike on 49576. This is the same scoring as `test/intent/real.ts` and `eval.ts`.

## Q1. Would a small learned model beat the rules?

### Setup

`test/research/dump.test.ts` runs the real `IntentReader` over every clip and dumps:
- per frame, the preprocessed body (15 landmarks in body units, plus velocities, visibility, elbow angles and scale),
- every intent from the default reader and from a sensitive one (the calibration thresholds).

Two model families, both trained with `python -I` on the CPU in seconds:

- **(a) Re-judge each strike the reader emits.** The features are the reader's own 12 `features` plus reach, speed, direction and height (18 in all). The "all" set adds 35 hand-made window features from onset − 100 ms to the confirm moment (causal). These cover wrist, elbow and hand travel, path curvature, swept area, elbow opening, peak speeds, the other hand's motion and its direction cosine, head motion, shoulder-width change (twist), visibility and duration.
  - Classifiers: gradient-boosted trees (sklearn HistGB), MLP 32-16, kNN (k=7) and logistic regression.
  - Classes: none / straight / hook / upper.
  - Three ways to use the output: **full** (pick the style and reject), **style** (pick the style only), **gate** (keep the rules' style, reject only).
- **(b) A tiny causal temporal CNN**, run per frame on the last 0.5 s of one arm, resampled to 30 Hz:
  - Input: 15 steps × 26 channels. The channels are shoulder-relative and mirrored wrist, elbow and hand positions, elbow angle, visibilities, the other wrist, head, shoulder width and tilt, plus positions relative to the window start.
  - Network: 3 dilated conv layers (32 channels), then last-step and max pooling, then 4 classes. **8,996 parameters, 63k multiply-adds per arm per frame** (about 0.1 ms in plain TypeScript; 0.27–0.42 ms per call in PyTorch, which is all overhead).
  - Trained per frame, with augmentation for scale, offset and jitter. Used two ways: re-judging the reader's strikes, and as a stand-alone detector.

Training and test splits never share a session. "LOSO" means each of the 5 real sessions is held out in turn, training on all synthetic data plus the other 4.

### Results: re-judging the reader's strikes

| Model (training data) | Test | True strikes: right style | True strikes kept | Fakes still emitted | Fake AUC |
|---|---|---|---|---|---|
| **Rules (current reader)** | synthetic seed 5 | 553/602 (92 %) | 602 (100 %) | 154/154 | – |
| GBT, all features (synthetic seeds 1–4) | synthetic seed 5 | 597/602 (99 %) | 599 (100 %) | **5/154** | – |
| CNN (synthetic seeds 1–4) | synthetic seed 5 | 563/602 (94 %) | 568 (94 %) | 7/154 | 0.96 |
| **Rules (current reader)** | all 5 real, LOSO | **25/38 (66 %)** | 38 (100 %) | 37/37 | – |
| GBT, reader features, style only | all 5 real, LOSO | 20/38 (53 %) | 38 | 37 | – |
| kNN, reader features, style only (best) | all 5 real, LOSO | **25/38 (66 %)** | 38 | 37 | 0.62 |
| GBT, reader features, gate | all 5 real, LOSO | 19/38 | 23 (61 %) | 12/37 | 0.64 |
| GBT, all features, full | all 5 real, LOSO | 12/38 (32 %) | 19 (50 %) | 15/37 | 0.56 |
| MLP / logreg, any | all 5 real, LOSO | 10–15/38 | 18–24 | 15–22/37 | 0.52–0.58 |
| GBT / kNN / MLP trained on **real only** (≈60 events) | all 5 real, LOSO | 9–14/38 | – | – | 0.45–0.66 |
| CNN (synthetic only) | all 5 real | 18/38 style-only; 5/38 full | 8 (21 %) full | 4/37 | **0.53** |
| CNN (synthetic + friend) | user + 3 stock (54 events) | 11/23 style-only (rules 15/23) | 13/23 gate | 15/31 | 0.56 |
| CNN (synthetic + user + 36564 + 40256) | friend + 49576 (30 events) | 8/15 style-only (rules 10/15) | 11/15 gate | **3/15** | **0.75** |

At 90 % of real strikes kept, the best learned gate in LOSO still lets 62 % of the fakes through (GBT, reader features); the others let 65–95 % through.

Confusion matrices, all 75 real events (rows = truth, columns = predicted):

| Rules | none | straight | hook | upper |
|---|---|---|---|---|
| none | 0 | 14 | 14 | 9 |
| straight | 0 | 14 | 3 | 2 |
| hook | 0 | 5 | 7 | 0 |
| upper | 0 | 1 | 2 | 4 |

| GBT all features, LOSO (real ×20 weight) | none | straight | hook | upper |
|---|---|---|---|---|
| none | 22 | 5 | 2 | 8 |
| straight | 9 | 5 | 3 | 2 |
| hook | 7 | 3 | 2 | 0 |
| upper | 3 | 2 | 1 | 1 |

The learned model throws away real strikes about as often as fakes.

**As a stand-alone detector** on the user's guided session, the CNN trained on synthetic + friend caught 12/12 prompts. It made 26–33 fakes against the rules' 15, and got 4 styles right against the rules' 6. On the slow-form negatives (49576) it fired 47–55 times a minute against the rules' 15. Trained with the user's session and tested on the friend's, it roughly matched the rules: 10/12 caught (rules 11), 6 styles right (rules 7), 5 fakes (rules 6). On 49576 it still fired 25–37 times a minute against the rules' 15.

### Why: the synthetic fakes aren't the real fakes

| What was going on when the reader emitted a fake strike | Synthetic (777) | Real (37) |
|---|---|---|
| Wave / scratch head (synthetic negatives) | **85 %** | 8 % |
| The **other arm** during a punch (prompt or label) | 3 % | **38 %** |
| Slow form (49576) / slow reach / hands down / fidget | 11 % | 24 % |
| Duck | 0 % | 11 % |
| Block (raising the guard) | 0 % | 11 % |
| Lean / idle / same arm twice | 1 % | 9 % |

Single features show the same thing. On real events the best separators of fakes from strikes are the head's vertical motion relative to the shoulder over the strike (AUC 0.71) and the other hand moving the same way (`cosOther`, AUC 0.70). On synthetic events they score only 0.56 and 0.55, so a model trained on synthetic data learns to ignore them. Synthetic data rewards wrist height at the end (AUC 0.77–0.78: waves and scratches end high), which is the wrong lesson for real play.

### Verdict and plan

**Don't integrate a learned model now.** The rules are as good at style (66 % on real strikes) and better at keeping real strikes. The learned gate's real-data AUC (0.53–0.66) isn't enough to reject fakes without losing punches.

What would change this:
1. **Collect labeled real sessions with the guided test.** It already records prompt windows and uploads to the server. About 20–30 sessions from 10+ people would give roughly 300 real strikes and 300 fakes.
   - Add prompts for the fakes that actually happen: "punch with your right, keep your left still" (counter-arm), "block", "duck with your hands up", "fix your hair" and "reach for the mouse".
   - The trend above (fake AUC 0.53 → 0.56 → 0.75 as real sessions are added) says this is the lever. It's 3 points on different test sets, so it's indicative only.
2. **Fix the synthetic generator's negatives** to match the real mix:
   - counter-arm retraction and torso rotation during a punch on the other side,
   - both hands rising into a block,
   - ducks with the hands up,
   - slow tai-chi-style reaches.

   Then the 5,000 synthetic strikes become useful pretraining.
3. **Re-run these scripts** (`research/models/style_events.py`, `gate_auc.py`, `temporal.py`) on the new data. Ship only if LOSO shows the gate rejecting ≥50 % of fakes at ≥95 % of strikes kept, and style ≥ the rules.

**If it turns positive, integration is cheap:**
- **What:** the CNN as `src/intent/strikeGate.ts`. It has 9k parameters, about 36 KB as float32 or about 200 KB as JSON. Run a plain-TS forward pass per arm per frame (63k MACs, about 0.1 ms).
- **Where:** `IntentReader.updateLimb` keeps a 15-step ring buffer of the 26 channels (computed from `Body`, as in `moves.arm_channels`). At confirm time it asks the gate for `P(none)` and the style.
- **Behaviour:** reject when `P(none) > threshold`, and otherwise keep the rules' style unless the model is confident. It adds no latency, because it runs on frames already in hand at confirm.
- **Flag:** `DEFAULT_INTENT.gate = { enabled: false, reject: 0.7 }`, a tuner slider, and `?gate=1`. With it off, the reader stays byte-identical.

## Q2. Depth on demand

### Setup

- **Model:** Depth Anything V2 Small (`depth-anything/Depth-Anything-V2-Small-hf`, PyTorch fp16, RTX 4070 laptop GPU) on every frame of 40256 (boxer at the camera), 36564 (side/back view) and 49576 (slow form, facing the camera), at 336×196.
- **Signal:** the depth spike's `toward = (fist − body) / (body − background)` (`research/models/depth_on_demand.py`).
- **Onsets:** the reader's arm onsets (`anticipate`) from both the default and the sensitive reader.
- **On-demand variant:** use only the onset frame (baseline) and the next 2 frames, with the denominator from those 3 frames:
  - `rise2` = max(toward at +1, +2) − toward at onset (3 inferences),
  - `rise1` = toward at +2 − toward at onset (one batch of 2).
- **Reference:** the always-on version (`cont_rise`), with an EMA denominator and a 0.5 s baseline.

### Results

| 40256 (boxer at the camera) | Straights | Others | AUC rise2 (95 % CI) | AUC rise1 | Always-on AUC |
|---|---|---|---|---|---|
| Straight vs everything else (same arm) | 5 | 38 | 0.36 (0.00–0.76) | 0.34 | 0.48 |
| Straight vs not-a-strike | 5 | 24 | 0.41 (0.00–0.86) | 0.40 | 0.52 |
| Straight vs hook/uppercut | 5 | 14 | 0.29 (0.00–0.63) | 0.27 | 0.43 |
| Straight by **either** arm vs the rest | 9 | 34 | 0.54 (0.25–0.83) | 0.49 | 0.48 |
| Any strike vs none, all 3 clips | 26 | 83 | 0.61 (0.45–0.77) | 0.55 | 0.53 |

Threshold table, `rise2` on 40256, straight (either arm) vs the rest:

| Threshold | Straights passing | Others passing |
|---|---|---|
| 0.10 | 43 % | 45 % |
| 0.20 | 29 % | 26 % |
| 0.30 | 29 % | 10 % |
| 0.45 | 29 % | 3 % |
| 0.60 | 29 % | 0 % |

Waiting longer doesn't fix it. Either-arm AUC is 0.60 / 0.63 / 0.63 / 0.69 with 2 / 3 / 4 / 6 frames after onset, and same-arm AUC stays at 0.28–0.36.

**What goes wrong** (per-onset listing in the script output):
- **Attribution.** At 3.2 s a real straight shows +3.4 on the arm MediaPipe calls the right and −1.3 on the labeled left: the hands swap.
- **Hooks come at the camera too.** Hooks rise 0.2–0.6, the same range as straights.
- **The fist isn't out yet.** At onset + 2 frames (83 ms at 24 fps) most straights haven't reached the camera.
- **What it does well:** on the slow-form negatives (49576, 52 onsets) it stays quiet (median rise 0.01, none above 0.3). Only a big, clearly attributed punch stands out, the same finding as the original spike.

### Latency

| | |
|---|---|
| PyTorch fp16, batch 1 (this run) | 21–23 ms per frame |
| PyTorch fp16, batch 2 (onset + 2) | 18–23 ms |
| Browser alone, 336 px (depth spike) | 25–35 ms |
| Browser next to MediaPipe (depth spike) | 40–50 ms |
| Earliest on-demand answer | onset + 2 frames (67–83 ms) + about 45 ms = **110–130 ms after onset** |
| Reader's confirm today (real clips) | median 80 ms after onset (p10 64, p90 162–167) |

### Verdict

**Not worth integrating, even as an optional confirm on fast GPUs.** It doesn't separate straights from hooks or fakes at the onsets the reader produces (AUC ≤ 0.69, every CI includes 0.5). It needs arm attribution that MediaPipe can't give on exactly these clips. It would also delay the median confirm by 30–50 ms. The only usable behaviour is "a very large rise (> 0.45) is almost always a real punch at the camera". That fires on fewer than a third of straights, and it would need the ~50 MB model download plus WebGPU. Revisit only with a real webcam recording at 30–60 fps (the stock clip is cinematic, handheld and very close) and a two-camera setup or a hand crop.

## Q3. Other pose models

TBD

## Q4. Other things that would reduce fake moves and wrong types

From a separate web pass; anything not verified is marked. Nothing here repeats `research/body-input-best-practices.md`.

- **Cross-hand lockout.** One open-source MediaPipe boxing spike cut double fires from torso rotation from 8 to 2 with a 250 ms lockout across both hands ([galkatzh/tools#106](https://github.com/galkatzh/tools/pull/106)). In our data the other arm is 38 % of real fakes.
  - The catch: real jab-cross combos are 150–250 ms apart, so a blanket lockout kills combos.
  - **Suggested rule for the reader:** within 400 ms of a confirmed strike, a strike by the other arm needs a reach at least 0.6× the first one's and must not start with a retraction (the hand moving back toward the face). Tune it on the guided sessions.
- **Hook vs straight by elbow angle at peak, and an uppercut must start low.** The two are mutually exclusive by start height. Shadowbox Coach (MediaPipe in a worker, rules) found lateral displacement misread crosses thrown across the midline, so it switched to elbow angle at peak extension. It random-searched thresholds (24k–40k configs) over synthetic plus labeled recordings, with negative scenarios required to fire zero, and went from F1 0.946 to 1.0 on its holdout (mostly synthetic) ([ChaiWithJai/hybrid-ai-blueprints#5](https://github.com/ChaiWithJai/hybrid-ai-blueprints/pull/5)).
  - Our tuner, replay and `test/intent/matrix` can already do this kind of search. **Weight phantoms above misses.**
- **Trigger, then confirm with an explicit "not a punch" class.** On SHREC'21/'22 online gestures, a GRU localizer gating a recognizer that has a non-gesture class cut false positives from 15.3 % to 9.2 % at the same detection rate ([SciTePress 2023](https://www.scitepress.org/publishedPapers/2023/116632/pdf/index.html)). Periodic motions such as waves were the worst offenders ([SHREC 2022](https://ar5iv.labs.arxiv.org/html/2207.06706)). That is the structure Q1's gate would take, once there's real data.
- **Expect hook and uppercut to stay the weak classes.** Even commercial wrist IMUs detect hooks at only 0.50–0.65 and uppercuts at 0.56–0.78, against 0.83–0.96 for straights, with specificity 0.96–0.99 ([Sensors 2021](https://pmc.ncbi.nlm.nih.gov/articles/PMC8123076/)).
  - **Design for it:** let the resolver treat a low-confidence hook or uppercut as a straight. A wrong type hurts less than a phantom punch.
- **Fist size as a corroborating toward-camera cue.** Relative hand-size change ≈ relative depth change. A Fujitsu webcam system detected 81 % of fist pushes at 0.8 m with 9.5 % false alarms, but the sensitivity falls with 1/d², and the hand rotating or covering the face broke it ([MVA 2013](https://www.mva-org.jp/Proceedings/2013USB/papers/09-11.pdf)).
  - We already have index and pinky landmarks, so the index–pinky span is free. Use it only to corroborate, never to trigger. A turning fist shrinks too ([arXiv 2504.01888](https://arxiv.org/pdf/2504.01888)).
- **MediaPipe Hand Landmarker for fist orientation:** 12–17 ms on a Pixel 6 per the docs, with no browser numbers found. It re-runs palm detection whenever tracking drops, which is exactly the blurred-fist case ([docs](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker)). No published work uses palm orientation for punch type. **Not worth a second model.** The pose model's index and pinky give a rough roll for free [unverified that it is stable enough].
- **Few-shot enrollment works but needs examples.** A wrist-IMU study reports F1 of 66 %, 89 % and 92 % with 1, 3 and 5 examples per class ([arXiv 2203.15239](https://arxiv.org/pdf/2203.15239)). That supports the reader's "matcher needs 3 examples" rule.
- **Smoothing:** Savitzky–Golay is centered (non-causal), so a 51-frame window costs 25 frames of lag. Keep One Euro or a causal slope for onsets ([arXiv 1912.05636](https://arxiv.org/pdf/1912.05636)).
- **Camera shake / whole-body motion:** no published skeleton-specific method was found. The practical rule is the one the reader already half-has (`movedTogether`): veto when both wrists, the nose and the shoulders all move with nearly the same velocity. Our data hints that head motion during the strike also separates fakes (AUC 0.71, but best-of-53 on 75 events).
- **Lighter depth models** (for completeness): ZipDepth (6.1M params, ECCV 2026) and DepthART-S (6.0M) are 4× smaller than DA-V2-S but have no browser build. DA3-Small int8 ONNX reports 90–113 ms on unstated hardware [unverified in browser] ([ZipDepth](https://zipdepth.github.io/), [DepthART](https://arxiv.org/html/2607.17099v1), [DA3 ONNX](https://huggingface.co/en970/depth-anything-v3-small-onnx)). None changes the Q2 verdict, which is about the signal, not the speed.

## Reproduce

```bash
# 1. Dump the reader's view of every clip (synthetic + real) to a scratch dir (~200 MB)
DUMP_OUT=$SCRATCH/dump SEEDS=5 CLIPS_DIR=$CLIPS GUIDED=guided-233104.jsonl,guided-233624.jsonl \
  npx vitest run test/research/dump.test.ts
# 2. Learned models (CPU, seconds to a minute each); needs numpy, torch, scikit-learn
python -I research/models/style_events.py $SCRATCH/dump
python -I research/models/gate_auc.py $SCRATCH/dump
python -I research/models/temporal.py $SCRATCH/dump $SCRATCH/cnn --synth-holdout --tag synthonly
python -I research/models/temporal.py $SCRATCH/dump $SCRATCH/cnn --extra-train guided-guided-233104 --tag plusfriend
python -I research/models/temporal.py $SCRATCH/dump $SCRATCH/cnn --extra-train guided-guided-233624,stock-36564,stock-40256 --tag plususer
# 3. Depth on demand (GPU, ~1 min); needs transformers, opencv
python -I research/models/depth_on_demand.py run $CLIPS $SCRATCH/depth 40256 36564 49576
python -I research/models/depth_on_demand.py analyze $SCRATCH/depth $SCRATCH/dump test/intent/labels
# 4. Pose models (one process per model); needs rtmlib, ultralytics, mediapipe, ai-edge-litert
python -I research/models/pose_compare.py run rtmpose_m $CLIPS $SCRATCH/pose $WEIGHTS 40256 36564 49576
python -I research/models/pose_compare.py analyze $CLIPS $SCRATCH/pose test/intent/labels $SCRATCH/sheets
python -I research/models/pose_bench.py $WEIGHTS/rtmlib/hub/checkpoints/*.onnx
```
