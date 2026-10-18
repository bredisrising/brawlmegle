# Reader robustness: fast moves, any camera, sitting or standing

Branch `reader-robust`. The reader now catches more moves on the first try in every play condition I could
build, with less than half the fake moves. Fast combos, sitting at a laptop, low frame rates and handheld
phones gained the most. On the two real guided tests it catches the same number of punches. It throws far
fewer fake moves on the user's own session (39 → 20), and the friend's missed lean left now registers. Real
style accuracy is still weak (see the end).

| | before | after |
|---|---|---|
| Synthetic matrix, mean of 25 conditions: recall | 82% | 89% |
| strikes caught | 81% | 88% |
| strikes inside fast combos (150–250 ms apart) | 60% | 75% |
| precision | 74% | 88% |
| false positives per minute | 7.1 | 2.9 |
| effective punch latency, median / p90 (see below) | 165 / 249 ms | 160 / 247 ms |
| Guided test, friend (31 fps): caught / leans+guard+duck / fake moves | 11/12, 4/5, 8 | 11/12, 5/5, 7 |
| Guided test, user (16 fps): caught / fake moves | 10/12, 39 | 10/12, 20 |
| Orchestrator test (camera → reader → resolver → engine): threw / right kind | 22/24, 17/24 | 22/24, 18/24 |
| wind-up seen → strike lands, median / p90 | 176 / 208 ms | 176 / 212 ms |

"Before" is the reader as it was on main before this branch (`test/scratch/base`, i.e. 124c5d2; main's later
bug-review fixes only touch resets and bad frames). The orchestrator "before" numbers are the integrator's run
on main.

## How it's measured

**Synthetic clips** (`test/intent/synth.ts`, `conditions.ts`, `matrix.test.ts`). A procedural body throws
scripted moves in front of a virtual pinhole camera. The landmarks get MediaPipe-like damage, calibrated
against the real recordings:

- **Jitter while still** (`test/scratch`'s noise measurement, high-pass residual, in shoulder widths): the
  friend's session 0.7–1.2%, the user's 2.4–3.9%. Synthetic noise scales with how big the person looks
  (1.8% at noise 1).
- **Frame timing.** The user's session runs at a median 64 ms frame interval (about 16 fps). The friend's runs
  at 32 ms, but its p90 is 64 ms (dropped frames). The free-form tuner clips run at 32 ms with p90 48–64 ms.
- **Depth.** MediaPipe world z barely moves for a fist coming at the camera, and often moves the wrong way.
  On real punches the wrist z went *away* from the camera (research/depth-spike.md agrees). The synthetic
  hands get 10–35% of their true depth motion. Shoulders are better (torso turn shows as about 0.1 m).
- **Scale.** Seated players lean in and out by 20–40% within a 3.5 s prompt.
- **Also simulated:** left/right wrist swaps, one-frame whole-skeleton glitches, low visibility for fast hands
  and for elbows hidden behind a forearm, points out of frame or behind the desk (sitting), and repeated and
  dropped frames.

The bodies are more realistic than before. Punches turn the torso (up to about 20°), push the head toward
the other side, and carry the other hand's guard along. Each punch lands a little high, low or wide. Bladed
orthodox and southpaw stances are covered, along with small and tall bodies.

The new negatives are a wave, a head scratch, a torso twist, both hands down to the keyboard, and a bounce
on the toes. Fast combos chain jab-cross, jab-jab-cross, hook-uppercut and others, 150–250 ms apart, with no
return to guard.

Camera placements: yaw ±25–45°, low and looking up, high and looking down, close with the hips at the edge,
seated at a laptop (hips and legs hidden), and a handheld phone. For the phone, the whole image shifts, rolls
and zooms at 2–8 Hz, with a jolt every 1.5–5 s.

**Latency.**
- **Confirm** is the time from the motion's first frame to the strike intent.
- **Effective** is what the engine feels. Since main's Resolver passes `headStart = strike.t - onsetT`
  (capped at `FIGHT.maxHeadStart`, 6 frames = 100 ms), a strike effectively starts at
  `max(onsetT, t - 100 ms)`.

Confirming later within that 100 ms is therefore free, and the reader uses that time (see `confirmMs`).

**Real clips** (`test/intent/real.ts`, `real.test.ts`; opt-in with `POSE_CLIPS_DIR`, `GUIDED_CLIPS` and
`USER_CLIPS`):

- Hand-labeled stock clips. `labels/36564.json` (side and back view, kicks and punches, 8 strikes) and
  `labels/40256.json` (close handheld boxer, 14 strikes, very bad tracking) were labeled frame by frame from
  the videos. `labels/49576.json` holds the negatives.
- The two guided tests, scored per prompt: caught, style, and fake moves (strikes, dodges, ducks or jumps
  that weren't asked for, including the other arm's).
- The user's free-form recordings, which are unlabeled.

## Condition matrix (before → after)

Recall counts every labeled move (strikes, ducks, slips and jumps). Latency is in ms, for punches.

| condition | recall | strikes | combos | precision | style | FP/min | confirm med/p90 | effective med/p90 |
|---|---|---|---|---|---|---|---|---|
| standing, facing | 90 → 96% | 87 → 96% | – | 80 → 89% | 89 → 90% | 5.0 → 2.7 | 247/294 → 237/295 | 176/230 → 166/228 |
| standing, camera 25° left | 96 → 93% | 94 → 92% | – | 83 → 87% | 73 → 79% | 4.3 → 3.0 | 247/311 → 246/311 | 202/248 → 168/247 |
| standing, camera 45° left | 96 → 96% | 96 → 96% | – | 86 → 89% | 58 → 50% | 3.3 → 2.7 | 212/338 → 246/347 | 168/263 → 168/263 |
| standing, camera 30° right | 82 → 84% | 77 → 83% | – | 80 → 89% | 80 → 81% | 4.7 → 2.3 | 151/318 → 237/380 | 114/248 → 166/315 |
| camera low, looking up | 100 → 97% | 100 → 96% | – | 80 → 88% | 100 → 100% | 5.3 → 2.7 | 151/273 → 233/309 | 108/215 → 144/240 |
| camera high, looking down | 82 → 84% | 77 → 79% | – | 57 → 88% | 75 → 76% | 13.7 → 2.7 | 264/402 → 295/374 | 227/302 → 228/308 |
| standing close, hips at edge | 76 → 94% | 67 → 91% | – | 59 → 80% | 94 → 95% | 11.0 → 5.0 | 195/285 → 220/285 | 149/208 → 149/215 |
| sitting at a laptop | 79 → 92% | 87 → 89% | – | 55 → 82% | 75 → 78% | 13.7 → 4.3 | 206/341 → 229/325 | 165/278 → 159/248 |
| sitting, laptop low, 20° off | 79 → 94% | 91 → 93% | – | 67 → 78% | 86 → 79% | 8.3 → 5.7 | 176/259 → 194/296 | 126/227 → 126/227 |
| sitting, 15 fps | 63 → 81% | 67 → 74% | – | 65 → 86% | 77 → 85% | 7.3 → 2.7 | 289/387 → 248/348 | 207/287 → 174/274 |
| standing, 15 fps | 84 → 88% | 79 → 90% | – | 68 → 89% | 85 → 89% | 8.7 → 2.3 | 269/374 → 256/388 | 200/288 → 184/296 |
| standing, 24 fps | 91 → 94% | 88 → 94% | – | 76 → 89% | 87 → 90% | 6.3 → 2.7 | 241/380 → 269/323 | 176/280 → 186/240 |
| standing, 60 fps | 93 → 97% | 90 → 96% | – | 72 → 88% | 85 → 90% | 8.0 → 3.0 | 246/300 → 218/295 | 157/242 → 145/225 |
| webcam: 20% drops, jitter | 88 → 93% | 85 → 94% | – | 79 → 95% | 89 → 88% | 5.3 → 1.0 | 242/331 → 245/361 | 174/266 → 174/266 |
| bad lighting (noise ×2) | 81 → 76% | 75 → 75% | – | 64 → 78% | 87 → 87% | 10.0 → 4.7 | 249/322 → 249/299 | 196/230 → 183/230 |
| small body, short arms | 81 → 87% | 75 → 85% | – | 75 → 87% | 87 → 84% | 6.0 → 3.0 | 247/299 → 242/299 | 194/245 → 168/232 |
| tall, long arms, broad | 94 → 99% | 92 → 100% | – | 72 → 89% | 88 → 90% | 8.0 → 2.7 | 229/291 → 242/295 | 161/224 → 159/226 |
| orthodox stance | 93 → 99% | 90 → 98% | – | 85 → 90% | 91 → 88% | 3.7 → 2.3 | 243/303 → 232/314 | 175/260 → 148/235 |
| southpaw stance | 85 → 96% | 81 → 96% | – | 84 → 89% | 90 → 88% | 3.7 → 2.7 | 203/291 → 223/301 | 136/232 → 140/232 |
| handheld phone, standing | 84 → 92% | 78 → 91% | – | 73 → 84% | 100 → 100% | 6.7 → 3.7 | 192/309 → 217/309 | 143/225 → 136/222 |
| handheld phone, sitting | 73 → 92% | 83 → 89% | – | 53 → 78% | 82 → 80% | 13.7 → 5.3 | 189/306 → 215/316 | 134/250 → 134/247 |
| shaky handheld, sitting 24 fps | 71 → 84% | 76 → 78% | – | 56 → 84% | 74 → 78% | 11.7 → 3.3 | 214/392 → 244/367 | 169/292 → 164/281 |
| fast combos, standing | 63 → 81% | 62 → 81% | 61 → 81% | 97 → 98% | 99 → 98% | 1.3 → 1.0 | 197/255 → 201/267 | 138/192 → 121/192 |
| fast combos, standing 24 fps | 63 → 74% | 62 → 73% | 61 → 72% | 96 → 99% | 97 → 98% | 1.7 → 0.7 | 204/272 → 223/297 | 147/216 → 134/207 |
| fast combos, sitting 15 fps | 60 → 72% | 61 → 72% | 59 → 71% | 89 → 99% | 85 → 85% | 5.0 → 0.7 | 249/355 → 245/360 | 180/274 → 176/274 |
| **mean** | **82 → 89%** | **81 → 88%** | **60 → 75%** | **74 → 88%** | **85 → 86%** | **7.1 → 2.9** | 222/320 → 236/322 | **165/249 → 160/247** |

Confirm latency goes up by about 15 ms on purpose: strikes now wait at least 60 ms after their onset, so the
style is read from more of the motion. That wait falls inside the engine's head start, so effective latency
went slightly down. Where confirm latency jumps for a condition (camera 30° right, camera low), it's because
strikes that were missed before are now caught late, which raises the median.

## Real clips (before → after)

| clip | before | after |
|---|---|---|
| 36564: side/back view, 8 labeled strikes | 7/8 (any arm 8/8), style 43%, 8 false positives (5 dodges from stepping) | 7/8 (8/8), style 57%, 3 false positives |
| 40256: close handheld boxer, garbage tracking, 14 strikes | 8/14 (any arm 9/14), 14 false positives | 4/14 (any arm 7/14), 7 false positives |
| 49576: slow form, negatives only | 11 fake strikes | 11 fake strikes |
| guided, friend | caught 11/12, style 9, leans/guard/duck 4/5, fakes 8 | caught 11/12, style 8, 5/5, fakes 7 |
| guided, user (16 fps, chaotic tracking) | caught 10/12, style 5, 2/5, fakes 39 | caught 10/12, style 6, 0/5, fakes 20 |
| orchestrator (both guided tests through the engine) | threw 22/24, right kind 17 | threw 22/24, right kind 18 |

- **40256 got worse.** It's 6 s of a boxer filmed very close with a moving handheld camera. MediaPipe guesses
  the hips far off-frame, and the wrists jump and swap from frame to frame. The losses come from the 60 ms
  confirm wait and from judging a strike's direction at its peak. Several of its 2–3-frame punches now peak,
  retract and fail checks. I kept those changes because they help everything else.
- **The user's 0/5 for leans, guard and duck needs reading.** In that session the BLOCK and DUCK windows have
  no usable tracking (hands in front of the face, wrist visibility 0.0–0.1, shoulder width jumping 50% between
  frames). The user leaned *right* during LEAN LEFT, and before the prompt. The "before" hits there were
  lucky reads of glitch frames.
- **Unlabeled clips.** The user's tuner recordings detect more right straights (230411: 1 → 4 right
  straights) and fewer phantom dodges. 47758 (a dense kickboxing pad drill, unlabeled) goes from 26 to 68
  strikes: denser, plausibly real for that drill, but unverified.

Per-prompt guided tables (before | after). Guard up/down events are left out.

**guided-233104 (friend)**

| t (s) | prompt | before | after |
|---|---|---|---|
| 3.0 | RIGHT PUNCH | ok: armR:straight | ok: armR:straight |
| 6.5 | LEFT PUNCH | ok: armL:straight | ok: armL:straight |
| 10.1 | STAY STILL | ok | ok |
| 13.7 | RIGHT HOOK | ok, +1 fake: armR:hook, armL:hook | ok, style straight, +1 fake: armR:straight, armL:straight |
| 17.2 | LEFT HOOK | ok, style straight, +1 fake | ok, style straight, +1 fake |
| 20.8 | BLOCK | ok, +1 fake: armR:upper | ok |
| 24.3 | RIGHT UPPERCUT | ok: armR:upper, armR:straight | ok: armR:upper, armR:straight |
| 27.8 | LEFT UPPERCUT | ok: armL:upper | ok: armL:upper |
| 31.4 | SCRATCH YOUR HEAD | ok | ok |
| 34.9 | DUCK | ok, +2 fake (both arms, tracking flip) | ok, +2 fake |
| 38.5 | LEAN LEFT | **MISS** | **ok: dodge:L** |
| 42.0 | LEAN RIGHT | ok: dodge:R | ok: dodge:R |
| 45.5 | RIGHT PUNCH | ok, +1 fake: dodge:L | ok, +1 fake: dodge:L, second armR:straight |
| 49.1 | LEFT PUNCH | ok | ok |
| 52.5 | WAVE HELLO | 1 fake: armR:hook | 1 fake: armR:straight |
| 56.1 | RIGHT PUNCH | MISS | MISS (reach 0.25, just under) |
| 59.7 | LEFT HOOK | ok, style straight | ok, style straight |
| 63.2 | RIGHT UPPERCUT | ok | ok |
| 66.8 | BLOCK | ok, +1 fake: armR:upper | ok, +1 fake: armR:upper |
| 70.3 | LEFT PUNCH | ok | ok |

**guided-233624 (user, 16 fps)**

| t (s) | prompt | before | after |
|---|---|---|---|
| 3.0 | RIGHT PUNCH | ok, +1 fake: dodge:L | **ok** |
| 6.6 | LEFT PUNCH | ok, +2 fake: dodge:R, armR:hook | **ok** |
| 10.1 | STAY STILL | 2 fake | 1 fake |
| 13.6 | RIGHT HOOK | ok, style straight, +2 fake | **ok (hook)**, +1 fake |
| 17.2 | LEFT HOOK | ok, +1 fake | ok, +2 fake |
| 20.7 | BLOCK | ok, +3 fake | MISS, +1 fake (no tracking) |
| 24.2 | RIGHT UPPERCUT | MISS, +1 fake: duck | MISS, +1 fake: dodge:L (the uppercut comes late, in the next window, as a wide swing) |
| 27.8 | LEFT UPPERCUT | ok, style straight, +3 fake | ok, style hook, +3 fake |
| 31.3 | SCRATCH YOUR HEAD | 2 fake | 1 fake: armR:upper |
| 34.9 | DUCK | ok, +4 fake | MISS, +2 fake (tracking lost mid-duck) |
| 38.4 | LEAN LEFT | MISS, +2 fake | MISS, +1 fake |
| 41.9 | LEAN RIGHT | MISS, +1 fake: dodge:L (glitch) | MISS |
| 45.5 | RIGHT PUNCH | ok (as hook), +2 fake | **MISS** (punch straight up from the lap together with the other hand: read as raising the guard) |
| 49.0 | LEFT PUNCH | ok, +2 fake | ok, +2 fake |
| 52.6 | WAVE HELLO | 1 fake: armR:hook | 1 fake: armR:hook |
| 56.2 | RIGHT PUNCH | MISS, +1 fake: dodge:L | **ok: armR:straight** |
| 59.7 | LEFT HOOK | ok, style straight, +4 fake | ok, style straight, +3 fake |
| 63.2 | RIGHT UPPERCUT | ok, style hook, +1 fake: duck | ok, style hook |
| 66.8 | BLOCK | MISS, +2 fake | MISS |
| 70.3 | LEFT PUNCH | ok, +2 fake | ok, style hook, +1 fake |

## What changed and why

### Preprocessing (`preprocess.ts`)

- **The body unit follows leaning in and out** (`unitSeconds` 0.4 s; it used to be 2.5 s). Players change
  size by 20–40% within seconds. With a slow unit every position drifts: in the user's session the nose
  "dropped" 0.37 units over 2 s, which was a fake duck.
- **`scale` (stepping in or out) keeps a slow 2.5 s home** (`sizeHome`), so `Stance.advance` behaves as before.
- **One-frame skeleton jumps are skipped.** If the torso size jumps more than 20% between frames, that frame is
  dropped, but never two in a row.
- **Hand-only swap fix.** MediaPipe often trades the wrists but keeps the elbows when the hands cross. Groups
  are now checked in order on already-fixed points, so a whole-arm swap isn't undone by the hands check.

### Strikes (`IntentReader.ts`)

- **No 1.3× penalty for punching from guard,** and `strikeDist` goes from 0.26 to 0.24. Players hold guard
  almost all the time, so the penalty was the biggest single cause of missed straights. Combos rose 61 → 77%
  from this alone.
- **Combos re-arm on pull-back.** A limb in recovery is ready again once it has pulled back
  `max(onsetDist, 35%)` of its reach from its furthest point. For 400 ms after that the anchor follows the
  retraction, so the next punch is measured from where the hand turned around, not from guard.
- **Guard hands are measured against the head.** A hand whose rest is up by the face rides along with the
  head. When the torso twists to throw the other hand, slips or ducks, that isn't this hand punching. This
  cut most of the other-arm spill.
- **Both hands moving the same way at the same time is cancelled** (reason `'both hands moved'`). That covers
  ducking or twisting with the guard up, MediaPipe flipping the skeleton, and camera jolts. Legs get the same
  check, so both knees rising in a jump aren't two knees. It runs after all limbs update, so it isn't a frame
  stale.
- **Strikes confirm at least `confirmMs` (60 ms) after onset.** The style is then read from more of the motion
  at no cost under the engine's head start. With this change the orchestrator's "right kind" went 14 → 17.
  Real style accuracy rose slightly.
- **Rejecting things that aren't punches:**
  - A hand going over the head with the elbow up (scratching, waving, fixing hair) is cancelled
    (`'not a punch'`). Rises with the elbow coming up wait for their peak to see where they end. Uppercuts keep
    the elbow down and don't wait.
  - An arm that is already raised (elbow at shoulder height, hand above it) can't start a punch.
  - Raising a guard from the lap needs the other hand up too. One hand shooting up from the lap is a punch:
    seated players rest their hands in their lap.
- **A strike's direction is judged at its peak** ("punches don't go down"), not at the confirm frame.

### Head moves: slip, duck, jump

- **Measured on the whole torso against the slow home,** not against the hips. Seated, the "hips" are
  estimated from the shoulders, so a seated lean was invisible. This fixed the friend's missed lean left.
- **A slip needs the shoulders to come along and the head to lead them** (by at least 15%). If everything
  shifts the same amount, that's the camera moving or a step.
- **Two frames in a row.** A head move starts on a frame that passes its speed check and counts only if the
  next frame still holds it. One-frame glitches threw the whole skeleton around (the user's fake dodge:L
  during LEAN RIGHT).
- **No dodges or ducks from punching.** A right punch swings the head to the player's left (and a left to the
  right), by up to 0.35 units in the user's session. While the throwing arm is out, a dodge to that side needs
  3× the lean, then 2.5× for 500 ms. Any punch within 500 ms raises the bar 1.6× for dodges and ducks. This
  removed about 12 fake dodges and ducks from the user's session.
- **With the feet in view, slips and ducks are measured against the feet,** because a bumped or handheld
  camera moves the feet too. Jumps still use the room, since the feet leave the floor.
- **Jumps need the head to rise with the hips** (a real hop, not a bounce on the toes) and must hold for two
  frames.

### Other

- `StyleMatcher.decide` (the optional calibration) no longer overrules the rules with fewer than 3 examples of
  a style, or when it has no examples of the rules' style.
- New cancel reasons: `'both hands moved'` and `'not a punch'`. New optional config fields:
  `preprocess.unitSeconds` and `arm.confirmMs`. These show up in the tuner automatically.

## Round 2: the other arm, blocks and ducks

research/move-research.md (on origin/main) found that 38% of real fake strikes are the other arm moving
during or after a real punch, and 22% are blocks and ducks with the hands up. A reach threshold can't separate
them from real combos. I tried several rules against both guided tests, the matrix and the orchestrator test,
and kept only the three that helped without costing combos:

- **The other hand moved along.** Over this strike's own wind-up (onset to confirm), if the other hand moved the
  same way by at least half as much (cosine > 0.8), it was both hands moving, not a punch. This catches both
  hands lifting into a block and the body carrying both. Real follow-up punches come while the other hand pulls
  back.
- **Mirror-image strikes on the same frame.** Both arms "striking" on the same frame, with mirror-image hand and
  elbow motion (cosine > 0.8 in each arm's own side-for-side frame), are cancelled. This is mostly both elbows
  coming up as the shoulders drop into a duck with the guard up, which the image-space check missed. The super
  (both fists held overhead) is a separate path and unaffected: `special.test.ts` still passes.
- **A guard tuck isn't a hook.** A hand that sweeps in across the body while its elbow tucks in (moves toward
  the center) and stays down (rises < 0.08) is the guard closing up. That's the other hand's usual move while
  one hand punches. A hook brings the elbow up.

Results (before = main at the start of this round, e8badfa):

| | before | after |
|---|---|---|
| guided, friend: caught / fakes | 11/12 / 7 | 11/12 / 4 |
| guided, user: caught / fakes / double strikes | 10/12 / 20 / 2 | 9/12 / 15 / 0 |
| matrix mean: recall / precision / FP per minute | 89% / 88% / 2.9 | 89% / 89% / 2.5 |
| matrix fast-combo recall: mean, then standing / 24 fps / sitting 15 fps | 75%: 81 / 72 / 71 | 74%: 80 / 71 / 70 |
| orchestrator: threw / right kind | 22/24 / 18 | 22/24 / 18 |
| 36564 / 40256 / 49576 false positives | 3 / 7 / 11 | 3 / 7 / 10 |

- **The fakes removed:**
  - The friend's duck: both arms, now gone.
  - The user's guard pull-ins during left punches and hooks (17.2, 49.0 and 70.3 s).
  - A double strike on the user's right hook.
  - A hook during the user's lean left.
- **The catch lost:** the user's left uppercut at 27.8 s. It was already read as the wrong move: the hand swept
  in with the elbow dropping, which looks like a guard tuck. The orchestrator's "right kind" is unchanged.

**Tried and dropped:**

- **The torso-swing lockout** (within 900 ms of the other arm's punch, cancel a strike whose hand moves the way
  the head moves relative to its shoulder). It cut 3–4 of the user's fakes but lost a right-kind strike in the
  orchestrator test and every strike on 40256. The head barely moves (0.01–0.1 units), so the direction is
  mostly noise, and a camera roll moves hand and head together. Synthetic combos also failed it until it
  required visible head motion.
- **Raising the bar for elbow-led strikes while the other arm is mid-punch.** The friend's fakes dropped 6 → 4,
  but the user lost a catch and gained a fake.
- **No arm strikes while the head drops fast.** It had no effect on these sessions.
- **The other hand moving in mirror image, without the same-frame requirement.** It cut 2 more fakes but lost a
  catch and an orchestrator "threw".

**Note for the integrator:** on the friend's guided test the new super fires on both BLOCK prompts (20.8 and
66.8 s): both fists up by the forehead with the elbows up. The guided scorer doesn't count `special` as a fake,
so it doesn't show in the numbers above. A high block looks like the seated super pose.

## Still weak

- **Style on real players.** Camera-facing seated hooks often read as straights. At confirm time a hook's
  hand has barely started across, and the friend flares his elbow on straights too. The user's "uppercuts"
  are wide outward swings while leaning, so they read as hooks. A shared style model trained on more guided
  sessions (`train.test.ts`, `styleModel.json` is still empty) or a quick per-player calibration is the way
  forward. The rules have run out of signal.
- **The first sweep of a wave** still reads as a strike. Later sweeps don't, because the arm is up.
- **Small seated straights right at the threshold** (the friend's at 56 s, reach 0.25).
- **Punches straight up from the lap while the other hand also comes up** (the user's at 45.5 s) read as
  raising the guard.
- **Tracking loss** (hands in front of the face, ducking out of frame). Nothing downstream can fix it.
  The reader now mostly stays quiet instead of inventing moves.
- **A camera roll looks exactly like a seated lean** from landmarks alone (both tilt the head and shoulders
  together). Handheld rolls of a few degrees are under the threshold, and bigger ones can still fake a slip.
- **40256-style garbage tracking at 24 fps** loses short punches to the 60 ms wait. Watch for this on low-end
  laptops.

## Running it

```
npx vitest run test/intent/matrix.test.ts        # condition matrix (VERBOSE=1 per move, MATRIX_OUT=x.json, ONLY=substring)
POSE_CLIPS_DIR=<dir with 36564.full.jsonl ...> \
GUIDED_CLIPS=<guided-233104.jsonl,guided-233624.jsonl> \
USER_CLIPS=<dir of tuner recordings> npx vitest run test/intent/real.test.ts
npx vitest run test/fight/orchestrator.test.ts   # guided tests through resolver + engine
```

The floors in `eval.test.ts` and `matrix.test.ts` sit a little under the current numbers, so regressions fail.
