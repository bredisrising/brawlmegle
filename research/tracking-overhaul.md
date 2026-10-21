# Tracking and move detection: what's wrong and how to make it much better

_2026-10-20. Research only; no game code changed. Five research passes: a code audit with browser measurements, outside research,
tracking forensics on the hackathon recordings, a move-read audit against the round videos, and a pose-model pass
that only got as far as alignment. This doc is the merged result. The full reports, labels and scripts are kept
**off the repo** (they name players and the video frames show faces); see the end._

## Bottom line

1. **Tracking isn't the main problem. The reader's rules and the fight design are.** On the round videos, 318 errors
   were tagged with a cause: reader rules 54%, low frame rate 19% (all in the first part of the night), tracking 9%,
   style ambiguity 6%. MediaPipe is good enough to say *when* someone swings and *with which hand* (it had the right
   arm on 187 of 193 caught strikes).
2. **The reader catches about half of what people really throw.** Live it read 53% of 362 real strikes, with 83%
   precision. It had the arm *and* the style right on only 21%. People swing; they don't box: 32% overhands
   (a style the game doesn't have), 31% hooks, 16% straights, 7% uppercuts, and only 18% of all swings were clean.
3. **Volume wins, and the engine guarantees it.** The side that threw more won 53 of 63 rounds. 73% of attacks hit
   and 1.3% whiffed. A defender sees the attacker's tell 114–200 ms before the hit lands, but reacting takes
   ≥ 500 ms, so defense can't be reactive. In simulation through the real engine, a patient "punish the whiff" player
   loses 40–0 to someone throwing 3 punches a second.
4. **Defense inputs are broken in opposite directions.**
   - Guard: the guard needs both hands near the face, but players hold theirs at the chest (median far wrist
     0.88 torso lengths from the nose against a 0.5 radius). On half the sides the guard never went up once.
   - Slips and ducks: 0 real ones in 374 s of labeled video, yet 24 were read, so they were 100% fake.
   - Raising your guard can make things worse. On labeled block moments the reader still fired a punch 64 times
     out of 101. A phantom punch turns blocking off and turns the incoming hit into a 1.5× counter.
5. **Every punch is the same punch.**
   - Damage is speed relative to *your own* recent average, times a wind-up factor that is effectively random:
     a hidden 2.2× spread.
   - Reach, raw speed and form are all dropped. A 0.24-unit twitch does the same as a full extension.
   - 37% of strike reads never became attacks: hit-stun wiped them or the queue overflowed.
6. **The tracker itself has a few real, fixable failures.**
   - **Frame rate:** 7.9 poses/s on the host before the worker build, now ~25.
   - **Dropouts:** 5.5 a minute of 250 ms or more, on fast crosses and fists-over-face.
   - **Bystanders:** 6 rounds with repeated whole-skeleton swaps.
   - **Framing:** head cut off in 11 recordings; ankles in view in ~0% of frames, so kicks can't work.
   - **Blur:** every punch is motion-blurred, and the game never shortens the exposure.
7. **No new pose model will save us.** Measured in Edge, MediaPipe is the fastest browser body tracker:
   - **MediaPipe full:** 15 ms single-pose and 25–28 ms two-pose on a Radeon 780M.
   - **Every alternative is slower:** RTMPose 27–31 ms, YOLO26n-pose 42–48 ms, RTMO-s ~90 ms.
   - **On accuracy:** Oct 17 found no alternative more accurate on blurred punches. That was on stock clips; the
     real-footage comparison didn't finish.

## The data

| | |
|---|---|
| Match recordings | 162 sides (81 rounds, Oct 17 22:06 → Oct 18 04:13 PDT), 52.6k pose frames, ~13 usernames, ~15 people (usernames were shared) |
| Round videos | 162, one per side, 640×480. **Every live pose lines up exactly with its video frame**: pose `t` is the frame's capture time; the residual is 0.2 ms after one offset per round |
| Labels (new) | 20 sides from 15–16 people: 509 real strikes (onset, peak, limb, style, clean/flail), 21 blocks, 0 slips/ducks, and a cause for every reader error. About 4× the real events the Oct 17 study had. Saved in `test/intent/real.ts` label format |
| Device telemetry | None real: all 66 "depth reports" came from one headless Edge on the dev laptop |
| Recording now | Off by default for the public (`MatchRecorder.ts:14`), so no new data is flowing in |

## What's wrong, ranked

Impact: **S** = kills skill expression, **F** = fake moves, **M** = missed moves, **L** = lag, **U** = unfair.

### A. The fight can't reward skill (design, not tracking)

| # | Problem | Evidence | Hurts |
|---|---|---|---|
| A1 | Defense can't be reactive | Tell → hit 114–200 ms on the defender's screen against ≥ 500 ms needed. `Cpu.ts:29-31` already says so. Sim: patient play loses 40–0 to 3 punches/s | S |
| A2 | Volume wins | Thrower-more won 53 of 63 rounds; host won 28 of 30 when out-throwing by > 0.5/s. Rate caps and removing the queue don't fix it (replay) | S |
| A3 | The guard people hold isn't a guard | Chest-level hands; guard never up on 68 of 136 sides. Replay with a 0.9 radius: hit rate 79% → 65%, blocked 11% → 26%, "more reads wins" 65% → 56% | S, M |
| A4 | Phantom strikes break your guard | 64/101 block moments fire a strike; startup sets `canBlock=false` (`FightEngine.ts:299`), the hit becomes a 1.5× counter (`:323`) | F, S |
| A5 | No analog quality | Damage = relative speed × random wind-up (p10–p90 0.74–1.64). Reach, raw speed, form, accuracy dropped. Auto-lunge makes spacing moot; any punch at a ducker becomes an uppercut | S |
| A6 | Input gets eaten | 37% of strike reads never became attacks (182 wiped by hit-stun, 274 expired or overflowed the 2-slot queue). Hits come in streaks (mean 3) | S, M |
| A7 | Fake tells | 51–65% of wind-up tells get cancelled (~50–60 a minute), so the opponent can't trust them | F |
| A8 | Legs advertised but unreachable | Ankles in view in ~0% of frames, knees 4%; every leg read in the labeled sample but one was fake | F, S |

### B. The reader misses how people actually swing

| # | Problem | Evidence | Hurts |
|---|---|---|---|
| B1 | Arcs, windmills and overhands aren't read | ~40% of misses (masher aside): the tip never moves "outward from the anchor" enough (median 1.9 vs 2.2 needed). Overhead swings hit the over-the-head veto; "both hands up" fires when the other hand was already in guard. In 2 of 6 fully labeled rounds, reader misses decided the winner | M |
| B2 | Style decided on the wind-up | Style is fixed 60 ms in. Straights read as uppercuts 10/37 (low camera), hooks as straights 16/66, overhands land anywhere. Style right on 21% | M (type), S |
| B3 | Slips and ducks are all fake | 22 slips + 2 ducks read, 0 real. Causes: the player's own swing twisting the torso, walking, a bystander, the skeleton collapsing in a forearm block. 3.9 fake slips a minute across all play | F |
| B4 | Hands rising into guard read as punches | ~15 of 47 fake strikes | F |
| B5 | Today's reader isn't better on real play | Re-run on the same poses: 51% vs 53% live, same precision, 27 fake slips vs 22. The synthetic tests didn't see it because they don't contain these behaviours (C8) | — |

### C. The tracking pipeline

| # | Problem | Evidence | Hurts |
|---|---|---|---|
| C1 | Pose rate far below camera rate (mostly fixed) | Host 7.9 poses/s before the worker build (26% of camera frames), 24.9 after (94%). P2 6.8 → 20.5. At 6–8 fps recall fell to 33% and the host's whole fight ran at 0.44× speed (dt clamped to 1/20 s). Joining laptops on stale builds kept the old code. The host reader samples P1 once per rAF, tying reads to render load | M, L |
| C2 | Dropouts | 5.5 gaps ≥ 250 ms a minute after the fix, 14 over 1 s in 21 min, plus a 0.2–0.4 s hole at round start in a third of host rounds. Causes: fast crosses smearing, both fists over the face, head out of frame | M |
| C3 | Bystanders | Near bystander in 38 of 162 recordings; repeated whole-skeleton swaps in 6 (up to 20 per round). The picker takes hips nearest the center (x *and* y, no size), so a standing person behind a seated player wins. The anchor check that rejects swaps only exists in one-pose mode | F |
| C4 | Framing | Laptops on tables, camera low looking up. Head cut off in 11 recordings (skeletons change size 2–6× between frames), body too low in 8, a wrist missing > 25% of the time in 26 | M, F |
| C5 | Motion blur, exposure never set | Every punch smears; the wrist lands mid-streak. `setShortExposure` is only called from the tuner. MediaPipe's visibility stays ~0.92 on blurred wrists and 0.998 on a covered nose, so confidence doesn't flag it. PoseBench: blur costs light models 28–32 AP, more than darkness | M |
| C6 | Model settings | Auto-switch to lite gives up accuracy for nothing on GPU (lite 25.8 vs full 29.5 ms on the 4070, *slower* on the 780M). Two-pose mode costs ~10 ms/frame; one-pose mode cuts pose delay to 24–26 ms and halves jitter (its smoothing adds only 5–8 ms) but locked onto the wrong person 47% of frames on a two-person clip. CPU fallback silently runs at 9 poses/s | L, M |
| C7 | P2 stream | Intents ride the reliable-ordered channel (one lost packet holds up the rest) next to a ~1.7 Mbps pose stream; one laptop pair lost ~50% of poses | U, L |
| C8 | The tests don't model reality | Synthetic clips have no 5–10 fps stretches, no multi-frame losses, no bystander swaps, no head-cut garbage, players at half the real size, legs fully visible, wrists 2–3× too calm. Jitter at rest is *not* a problem (1–1.5% of shoulder width, lower than the synthetic model's) | all |

### D. Latency

| Stage (host, straight punch, 30 fps camera) | ms | |
|---|---|---|
| Camera: photons → frame (exposure, readout, USB) | 35–70 (70–140 at 15 fps in dim light) | estimated |
| Frame → pose result (MediaPipe full, worker, two-pose) | 39 on the 4070, 46 on the 780M | measured |
| Motion start → reader's tell | 104 for straights, 154 across punches (synthetic); ~49 of it is One Euro lag | measured |
| Tell → confirm | 80 median (p90 192) on real rounds | measured |
| Confirm → first active frame | 50 jab … 120 uppercut | computed |
| Render → panel | 25–50 | estimated |
| **Real fist starts → hit on screen** | **~330–450 straights, ~470–600 hooks/uppercuts** | mixed |

On labeled video, the real onset → hit landing median is 265 ms (p90 623; the tail is punches waiting in the queue).
A real straight is fully out at 100–220 ms, so the hit lands about 200 ms after the player's fist does. Note:
`performance.now() − captureTime` can't see the camera stage, because Chrome stamps `captureTime` near arrival.
P2 also gets +½ RTT to the engine and a full RTT to see outcomes, with nothing equalizing it. P1 won 43 of 68 rounds.

## The plan

### Phase 1: cheap fixes with measured or near-measured gains (~2–3 days)

| Fix | For | Expected |
|---|---|---|
| **Guard where people hold it**: "show me your guard" calibration in the lobby, or a ~0.9 radius with both wrists above the chest line; ~60 ms hold | A3 | Replay: hit rate 79 → 65%, blocked 11 → 26% |
| **Guard beats a phantom punch**: if the guard comes up during an attack's startup (or within 150 ms), cancel the attack and block | A4 | Removes the worst fake-move outcome |
| **Slip/duck need the hips to move**; no head moves for 600 ms after any arm burst; a forearm-block collapse isn't a duck | B3 | All 24 observed fakes gone at no recall cost (nobody really dodged) |
| **Lock onto the player**: score by size + continuity, not center; reuse the one-pose anchor gate in two-pose mode; hold the last pose instead of jumping to someone else | C3 | Removes the bystander swaps and their fakes |
| **Short exposure in the game**, brightness-aware; restore auto on hide/stop (UVC settings can stick into the next Zoom call); warn "add light" under 24 fps | C5 | Less blur on every punch (not measured in-game yet) |
| **Drop the lite auto-switch on GPU**; warn on CPU fallback; show the pose rate on screen; feed the reader from every pose, not once per rAF; sim time not clamped by render fps | C1, C6 | Full accuracy kept; no 0.44× fights |
| **Version check on join** (refuse stale builds) | C1 | No more old code on P2 |
| **Framing gate before the round**: head + hips in view, shoulder width 0.15–0.30 of frame; "tilt the screen back" / "step back" | C4 | Fewer garbage skeletons |
| **Stop advertising legs** unless knees are tracked; give guard-break to a reachable input (two-hand shove or a big wind-up) | A8 | No fake kicks; restores block/break/strike |

### Phase 2: make it a skill game (~1–2 weeks with playtests)

1. **Defense redesign around visible travel.** Heavy shots get readable wind-ups (300–450 ms tell → impact) and
   big damage; jabs stay fast and weak. Add a **parry** (guard raised in a ~150–200 ms window before impact, judged
   against the attacker's tell). Slip/duck windows anchored to the incoming strike. Clean defense gives a short
   slow-mo and a highlighted counter window (Wii Sports' dodge → counter; Kinect Sports' block charges). This is
   the biggest lever, and it doesn't depend on better tracking. Acceptance: in the sim, patient beats 3 punches/s.
2. **Read swings, not just punches.** Onset from tip speed/curvature instead of "outward from the anchor";
   over-the-head veto only for *slow* rises; drop "both hands up" when the other hand was already up; add an
   overhand style (mapped to hook). Estimated recall 53% → 65–70%.
3. **Revise the style at the peak**, while the move is still in startup (6–12 frames of room). Estimated style
   21% → 40–50%.
4. **Grade every strike**: damage from *absolute* peak speed, extension vs the player's reach, and a clean return to
   guard (+20%) vs chained flails (−20%). Show it ("CLEAN!"). Personal max speed rises instantly and decays only
   between rounds (Thrill of the Fight) so flukes and glitches don't inflate it. Hit-stun keeps one buffered input.
   No auto-uppercut on ducks; cap the lunge so spacing matters.
5. **Enrollment during the forge wait** (the player is already in front of the camera for a minute): guard pose,
   3 punches of each kind, idle. Sets guard, reach, speed, noise floor and framing; feeds the existing but unused
   `calibrate()` and `StyleMatcher`.
6. **Feints instead of fake tells**: show a generic "ready" twitch at onset, the move-specific tell only when
   confident; a cancelled tell becomes a cheap visible feint.
7. **Real-data regression**: put the 509 labels (pose-only clips) into the eval with time-axis metrics
   (hit within 100/200/333 ms of the peak, phantoms per minute), and turn recording back on as an opt-in so data
   keeps coming.

### Phase 3: the architecture that makes it great (~3–4 weeks)

```
camera (short exposure, rVFC) → MediaPipe full, one-pose + periodic re-detect, identity by anchor
  → per-keypoint constant-velocity Kalman in body units, visibility as noise   (~40–60 ms earlier onsets)
  → per-frame soft scores: p(strike L/R), p(style), p(guard), p(slip/duck), quality features, per-player normalized
  → onset (p>0.5): provisional startup, nothing spent │ confirm (p>0.85): commit │ reject: feint / roll back
  → pure engine with 10–20 frames of snapshots: resimulate on a late confirm, cancel or remote input
     stamped with capture time → hides confirm lag and makes P2 fair at the root
```

- **Learned confirm gate**: a tiny model at confirm only (no published online detector decides earlier than our
  80 ms confirm). A 9k-parameter CNN costs 0.09 ms/arm/frame in plain TS, so skip ONNX Runtime. Training:
  - the 509 labels;
  - free hard negatives: every real strike gives two, the other arm's window and the strike played in reverse.
    The other arm firing is 38% of real fakes.
  - Oct 17's bar: reject ≥ 50% of fakes while keeping ≥ 95% of strikes, leave-one-person-out.
- **Interim fairness**: delay P1's commands by the measured one-way latency (cap 60 ms); send intents redundantly
  on the lossy channel; shrink the pose stream to ~0.1 Mbps.
- **Per-device loop test**: a 5 s screen-flash check (the webcam sees the room brighten) gives each player's real
  camera delay.

### Research directions (ideas only; none tested yet)

These could turn into papers. A pass to prototype the pixel ideas was started and then stopped.

- **The dataset is a contribution.** It is real webcam fighting play from strangers at an event, frame-exactly
  aligned with the live tracker, with 509 labeled strikes and a cause for every read error. Paired finding: players
  swing rather than box, nobody dodges, and guards sit at the chest, which is not what pose-based game readers
  assume (CHI PLAY / CHI angle).
- **Speculative input for body-controlled games.** A probabilistic reader plus a commit/rollback engine, evaluated
  on felt latency and fairness between two webcams of different speeds (UIST angle).
- **Pixel cues where pose fails.**
  - Optical flow in a forearm box placed by the last pose, for onset 1+ frames before the landmarks move.
  - Looming (the fist's image growing; time-to-contact) as the missing depth cue for punches straight at the
    camera.
  - Blur-streak length and direction as a one-frame velocity reading.
  - Rolling-shutter skew for timing within a frame.
- **The forge as a synthetic data engine.** We already make rigged 3D people. Retarget CC0 strike mocap
  (e.g. 3,229 Kyokushin strikes) onto forged fighters, render them at laptop-webcam angles with blur, and run
  MediaPipe on the renders. That gives exactly labeled training data with realistic tracker noise; rendering and
  re-estimating beat clean projected joints in the literature. Mixamo animations reportedly can't be used for ML,
  and BoxingVI has no license.
- **Few-shot personal templates.** Jackknife-style direction-vector DTW from 2–3 examples as a confirm-time style
  picker. It reported F1 96% on our exact move set on Kinect. Their code is non-commercial, so reimplement it.

## Progress on the `skill` branch (2026-10-20, later)

### Reading moves

Measured with `test/intent/hackathon.test.ts` (the 509 video-verified labels; set `HACKATHON_DIR`) on the 19 sides
without the masher. The synthetic matrix and both guided sessions were checked at every step, and they held: matrix
mean recall stayed at 89–90%, and the guided sessions' head moves stayed at 5/5.

| | Start of the day | Now |
|---|---|---|
| Real strikes read | 50.6% | **63.5%** (15 of 20 sides better, 2 worse) |
| Precision | 82.8% | 84.9% |
| Style right, of all real strikes | 20.4% | 29.0% (24% at confirm, the rest from the peak `restyle`) |
| Fake slips/ducks a minute | 4.7 / 2 | **0.3** / 1 |
| Labeled blocks read as guard | 14/18 | 17/18 (guard up 61% of the time, was 34%) |

What changed in `IntentReader` (each change was measured on its own; anything that didn't help was reverted):

- **No slip or duck within 600 ms of a fast hand.** Every fake dodge followed one: hand speed median 6, against 1.3
  in real slips.
- **Overhead swings count.** Only slow rises are hair fixing.
- **"Both hands up" needs the other hand to really rise.** In a big overhead swing the other shoulder dips, and a
  hand held still in guard looked like it was rising.
- **Overhand chops and looping swings start a read.** A third of real swings are overhands.
- **A long sweep across the body is a hook** even with the elbow low.
- **The other hand has to move at least 70% as far** to cancel a punch.
- **A chest-level guard counts** as a guard: both hands up in front of the chest, elbows bent.
- **A `restyle` at the strike's peak** fixes the style picked on the wind-up, and the engine swaps the move while it's
  still in startup.

- **Punch type, measured where players feel it:** of the caught punches with a clear type, the game plays the right move
  for 78% (it was 70%). Straights are right 41 of 49, hooks 74 of 85, uppercuts 13 of 20, and overhands come out as
  hooks 62 of 89 (was 43). The rules called a third of real overhands uppercuts. Now an uppercut needs the elbow to
  stay a quarter torso under the shoulder; an elbow swung up is an overhand coming over the top.
  - Tuning the other type thresholds on real play, with each player held out, didn't beat the current ones.
  - Style examples didn't help either: a shared set from the other players, or each player's own first punches.

Tried and dropped:
- **A shorter confirm wait** (20 ms): 32 ms faster, but one more fake a minute.
- **The cheap pixel check:** frame differencing in the forearm box at 320×240 removes only about 20% of fakes when 95%
  of real reads are kept. The 45% needs optical flow.

### The fight

`test/fight/skill.test.ts` has scripted players fight through the real engine with the camera's measured flaws, at
today's read rates and at a "nearly every punch read" target. Changes:

- **Guard beats the phantom punch.** A guard raised within 9 frames of a punch starting calls the punch off.
- **Holding guard is free.** It used to drain the guard meter, which crushed the only defense that worked at the event.
  Blocked hits still wear it down.
  - Result: turtle vs a 3-punches-a-second masher went from 10–30 to 25–15.
  - Patient play still beats the turtle, 38–2.
- **Damage comes from real speed and form.** It's the same scale for everyone, and punching with the other hand up in
  guard counts more (87% of clean punches had it up, against 66% of flails). The old relative-speed × wind-up formula
  was a hidden coin flip of up to 2×.
- **Heavies are a move you choose.** Pull back, hold a beat, swing: slower, harder, and drawn with a big wind-up. That
  covers 17% of real haymakers.
- **Parry.** A guard raised just before a heavy lands turns it away: the attacker reels, with a callout and a commentator
  line. The CPU throws heavies and parries yours.
- **Getting hit no longer eats the punch you just threw.** One queued punch survives hitstun.
- **Ducks work.** The resolver no longer turns any punch at a ducking opponent into an uppercut.

- **Hits show when you hear them.** A player reported sounds coming before the moves. On every hit the engine's
  hit-stop started and the game stopped drawing, so the freeze held the frame *before* the punch landed. The hit
  sound played 52–200 ms before the screen showed the impact, and the whoosh came after the hit sound.
  - Fix: the impact frame is drawn, then held. The same change went into the client mirror and the K.O. replay.
  - Measured in Edge on the RTX 4070 against the CPU: the screen now changes 2–11 ms after the sound.
  - This one is also on `main` and the live site.

### The learned move model (`src/intent/MoveModel.ts`): on

A 31k-parameter causal TCN in a 3-model int8 ensemble: 130 KB, under 1 ms a frame. It reads the reader's preprocessed
body and runs as a gate and rescue next to the rules (`IntentReader.secondOpinion`):
- rule strikes it doesn't believe are dropped;
- swings only it saw are added, with a wind-up tell;
- the style stays the rules';
- it switches off when the hips aren't in the shot (seated players lost strikes to it).

| | Rules alone (today) | Rules + model |
|---|---|---|
| Held-out real players: strikes read | 64.9% | **74.0%** (+9.1, 95% CI +4.1 to +15.3) |
| Held-out real players: precision | 85.1% | 86.2% |
| Held-out real players: confirm, median after the real onset | 139 ms | **74 ms** |
| Synthetic suites: false positives a minute | 2.5 | 1.5 |
| Synthetic suites: precision | 89% | 94% |

- **Held out** means each person group was left out of training and threshold choice (nested leave-one-person-out).
  Every group reads at least as many strikes as with the rules.
- **The first version** fired on everyday motions it had never seen: hands coming back up, scratches, waves. Retrained
  with the synthetic generator's negatives at a light weight, it doesn't.
- **What it can't do yet:** replace the rules. Its own style is a majority guess, and it fails on seated players.
- **`?model=0`** turns it off in the game, to compare.

Full report: `~/dev/brawlegle-data/clever-2026-10-20/learned.md`.

### Preview

The branch is built at **https://brawlmegle.com/next/**: `vite build --base /next/`, copied to
`/var/www/brawlegle/next/`, sharing the live forge and matchmaker. The live site stays on `main`.

**Real motion vs the CPU** (`test/scratch/realcpu.diag.test.ts`, local). The 52 worker-era host recordings from the
hackathon, each fed through the reader against a normal CPU twice. The players weren't reacting to this CPU, so this
shows what the mechanics do with natural motion, not skill:

| | Old (`main`) | New (`skill`) |
|---|---|---|
| Player punches read | 1,143 | 1,602 |
| Player punches landed | 636 | 608 (more swings miss now: 21% whiff) |
| Player blocked the CPU | 78 | 146 |
| Player's guard up | 18% | 64% |
| CPU heavies parried by players who weren't looking | – | 1 of 31 (3%) |
| Player heavies (players didn't know the move) | – | 40 of 1,602 |
| Rounds that reached a K.O. inside the clip, median time | 33/104, 9.9 s | 18/104, 11.8 s |

- Accidental parries are rare, so a parry is a read, not luck. An extra "deliberate raise" rule made no difference and
  was dropped.
- Guard priority calls off about 3% of the player's own punches.

Still needs playtests:
- **Round length:** rounds are about 7–11 s.
- **How often people parry by accident.**
- **Whether heavies feel too slow.**

## Found along the way (not tracking, but urgent for going viral)

- **Strangers see your webcam by default.** `camHidden` defaults to false (`src/game/store.ts:117`). Omegle shut down
  over child safety, and browser-game audiences skew young. Avatar-only with strangers; camera only between friends
  or after both opt in; a report/block button.
- **MediaPipe telemetry.** tasks-vision 1.1.1 contains a logger that posts to `odml.pa.googleapis.com/v1/log`; Google
  says apps must get consent. It wasn't seen firing. Check it in DevTools, then add a privacy line or block it with CSP.
- **Competition.** motions.games lists a webcam boxing duel ("Shadowbox"), a random 1v1 and a clip feed. Our edge is
  the scanned fighter, the walkout and commentary, and (after Phase 2) real fight depth.

## Not finished

- **Pose models on real footage.** Not run. The reference pipeline (YOLOX-x → RTMW-x + ViTPose++-H, flip test) is
  written and smoke-tested on one round. A full reference run takes ~1.5–4 h on the RTX 4070. "Don't swap models"
  is still untested on real play, but browser cost alone argues against swapping.
- **Pixel-cue prototypes.** Stopped before they started.
- **Latency.** No glass-to-glass number for a built-in laptop webcam anywhere; browser pose timings exist for the
  4070 and the 780M only.

## Where the details are (local only)

`~/dev/brawlegle-data/` on the dev laptop. It isn't in this repo because the repo is public and the material names
players and shows faces.

| Path | What |
|---|---|
| `tracking-2026-10-20/audit.md` | Pipeline audit, latency budget, measured browser timings, 15 ranked fixes, baseline numbers |
| `tracking-2026-10-20/moves.md` | Move reads vs video: accuracy, confusion, latency, error causes, engine replay variants |
| `tracking-2026-10-20/forensics.md` | Raw tracking quality: frame rate, dropouts, bystanders, framing, blur, synthetic-vs-real |
| `tracking-2026-10-20/external.md` | Outside research with sources: browser pose models (measured), shipped games, online detection, latency, skill design |
| `tracking-2026-10-20/models.md` | Alignment method and the unfinished bake-off plan |
| `tracking-2026-10-20/moves/dataset/` | The 509 labels (`real.ts` format) and pose-only clips |
| `tracking-2026-10-20/models/rounds.json` | Per-round video ↔ pose offsets |
| `hackathon-samples-2026-10-18/` | The raw recordings and round videos from the server |
