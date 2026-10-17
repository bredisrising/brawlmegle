# Brawlegle spec

Working name. This is a living doc, so edit it whenever a decision changes.

First there was Omegle: talking to strangers. Then there was Omoggle: talking and mogging against strangers. Brawlegle is the pose- and camera-based version for fighting. You get scanned into an exaggerated video-game version of yourself, then fight the other player with your real body.

## The demo, start to finish

1. Two players step up to the booth. Each half of the screen says "Waiting for player." Each player taps **Detect**.
2. A "Save fighter to memory card?" prompt asks for consent. Yes starts the scan. No gives them the masked mystery fighter.
3. Each player turns slowly in front of their camera for about 10 seconds, and three frames get captured.
4. While their fighter forges (expect 2–4 minutes; measure it), they move around freely as a stock mannequin. A quick tutorial teaches guard, jab, cross, block and slip, and measures their reach and speed.
5. The forged fighters swap in. VS cards, then the walk-in, then 3, 2, 1, FIGHT.
6. A 60-second fight with real punches. K.O., a slow-motion replay, then a rematch button.

A judge slot is about 5 minutes and the forge eats most of it. So scan the judge first and pitch while it forges, and keep pre-forged house fighters ready as opponents.

## Decided

- Both players are at the booth together. No voice or video chat.
- One laptop, two cameras: the built-in camera plus a USB webcam (or a phone running a webcam app), one camera per player. One game, one screen, no networking. Pending one test: can the laptop run two pose trackers at a smooth frame rate?
- The screen splits 50/50 before the fight. During the fight, about 95% of the screen is the 3D game.
- Stack: React, Tailwind CSS, Three.js, MediaPipe, and the ChatGPT image API.
- Every fighter is scaled to 1 m tall.
- 100 HP per player.
- Damage comes from wind-up and speed: how far you pull back and how fast you swing.
- How far the head rocks back scales with damage.
- Freeze frames (hit-stop) on hits.
- On-screen movement isn't 1:1 with MediaPipe. The game orchestrates the fight, so knockback and impact can override your tracked pose.
- Animation is stepped, limited-frame movement like arcade fighters. The visual style is still open.

## Booth setup

- Laptop raised to about chest height. Borrow an external monitor or TV if possible.
- Two cameras at chest height, each aimed at one player's spot. Players stand side by side about 1.5 m apart and about 2 m back. Each camera should frame its player at least head to hips; head to knees is better.
- Tape marks on the floor for both spots.
- Light from the front (a cheap clip-on LED works). Keep bright windows out from behind the players.
- A small speaker so the game cuts through the hall.
- Use 640×480 per camera. That's plenty for MediaPipe and avoids USB bandwidth limits with two cameras.

## Architecture

```
camera 1 ─▶ Vision ─▶ Intent ─┐
                              ├─▶ Fight engine ─▶ Director ─▶ Three.js scene
camera 2 ─▶ Vision ─▶ Intent ─┘   (rules, 60 Hz)   (animation, VFX, camera)
                                       │
                                       └─▶ events ─▶ Commentary (stretch)

Forge server: 3 scan frames ─▶ brief ─▶ model sheet ─▶ 3D ─▶ cleanup ─▶ rig ─▶ fighter GLB
```

**The core rule:** the camera reports what you meant, the engine decides what happens, and the director makes it look good. Tracked pose never decides a hit.

### Module contracts

Agree on these first so all four people can build in parallel against mocks.

```ts
type PlayerId = 1 | 2;

// Vision → Intent, once per camera frame (~30 fps)
type Landmark = { x: number; y: number; z: number; visibility: number };
type PoseFrame = {
  player: PlayerId;
  t: number;              // performance.now() in ms
  image: Landmark[];      // 33 MediaPipe landmarks, normalized image coords
  world: Landmark[];      // 33 world landmarks, meters, hip-centered
};

// Intent → Engine
type Command =
  | { kind: "anticipate"; player: PlayerId; t: number; hand: "L" | "R" }   // first ~100 ms of a throw
  | { kind: "attack"; player: PlayerId; t: number;
      move: "jab" | "cross" | "hook" | "uppercut"; hand: "L" | "R";
      height: "head" | "body";
      speed: number;      // 0.8–1.3, relative to this player's calibrated max
      windup: number }    // 0.8–1.3
  | { kind: "defend"; player: PlayerId; t: number; move: "block" | "slip" | "duck"; dir?: "L" | "R" };

// Intent → Engine, continuous, every frame
type Stance = {
  player: PlayerId;
  guard: boolean;
  advance: number;        // -1 (backing off) to 1 (stepping in)
  lean: { x: number; y: number };
  tracked: boolean;       // false when the player is lost
};

// Engine → Director and Commentary
type FighterState = {
  x: number;              // position on the fight line, meters
  hp: number;
  stamina: number;
  phase: "idle" | "startup" | "active" | "recovery" | "hitstun" | "blockstun" | "ko";
  move?: string;
  frame: number;          // frame within the current phase
};
type FightEvent = {
  t: number;
  type: "startup" | "hit" | "blocked" | "whiff" | "counter" | "ko" | "timeout";
  attacker: PlayerId;
  move: string;
  damage?: number;
  hitstopFrames?: number;
};

// Forge → Game
type Fighter = {
  id: string;
  name: string;
  status: "scanning" | "forging" | "ready" | "failed";
  step?: "brief" | "sheet" | "model" | "cleanup" | "rig";
  glbUrl?: string;        // rigged, Mixamo bone names, 1 m tall
  cardUrl?: string;       // VS card art
  brief?: Brief;
};
```

Build two dev tools on day one:
- **Keyboard input** that emits `Command` and `Stance` for both players. P1 uses WASD plus F/G/R; P2 uses the arrows plus K/L/O. The engine and director can then be built and tuned before vision works.
- **A debug overlay** showing the skeleton on each camera feed, the recognized command, both `FighterState`s and a frame-data timeline. All the tuning happens here.

Keep the engine pure TypeScript: no Three.js or React imports, a fixed 60 Hz tick, and no randomness. The same commands then always give the same fight. That makes it testable, and K.O. replays come free: re-run the engine on the logged commands and render it in slow motion.

## Screens and flow

Each player moves through join → ready on their own half of the screen. The match starts when both are ready.

| Screen | What's on it | Moves on when |
|---|---|---|
| Title / attract | Logo, last fight's replay on loop | Anyone taps Detect |
| Join (50/50 split) | [Waiting for player 1] [Waiting for player 2], camera preview, Detect button | That side's player is tracked |
| Consent | Memory-card prompt: Save fighter? Yes / Masked fighter | Choice made |
| Scan | "Turn slowly", progress ring with front/left/right ticks | All 3 angles captured (~10 s) |
| Forge + tutorial | Stock mannequin following the player; tutorial prompts; forge step badges (brief → sheet → model → rig) | Tutorial done and fighter ready (or timeout fallback) |
| VS + walk-in | Flaming VS cards, fly-through, side-by-side walk-out | ~10–12 s, skippable on rematch |
| Countdown | 3, 2, 1, FIGHT | Automatic |
| Fight | Arena, HUD | K.O. or 60 s timer |
| Result | Slow-mo K.O. replay, winner, Rematch / New players | Button |

HUD during the fight:
- Top bar: P1 name and HP bar (left), timer (center), P2 name and HP bar (right).
- A thin stamina bar under each HP bar.
- A combo counter.
- Commentary captions at the bottom.

## Forge: scan to fighter

### Capture (browser)

- During the turn, estimate which way the player faces from pose landmarks: shoulder width shrinks as they turn, and the nose's offset from the shoulder midpoint gives the direction.
- Bucket frames into front, left and right. Keep the sharpest frame in each bucket (highest variance of the Laplacian).
- Send the three JPEGs to the forge server.

### Pipeline (server)

API keys only ever live on the server.

| Step | What | Tool options | Target time |
|---|---|---|---|
| 1. Brief | Vision model reads the 3 frames and returns JSON (below) | OpenAI or Gemini vision; Perceptron if we enter that track | 3–5 s |
| 2. Model sheet | Full-body A-pose caricature for the 3D step. This is on the critical path. | ChatGPT image API (Gemini image as backup) | 15–40 s |
| 3a. 3D model | Model sheet → textured mesh | Tripo, Rodin Gen-2, Meshy, or TRELLIS.2 on our own GPU (Modal/RunPod, not the public HF Space) | 45–90 s |
| 3b. Card art | Same character in a dynamic stance, for the VS card. Runs in parallel with 3a. | Same image API, with the sheet as reference | 15–40 s |
| 4. Cleanup | `gltf-transform`: simplify to 5–8k triangles, textures to 512 px; normalize to 1 m tall, feet at y = 0, facing +z | gltf-transform CLI | ~2 s |
| 5. Rig | Auto-rig onto a Mixamo-named skeleton, then force the head and fists to 100% weight on their own bones | Tripo rig (`spec: "mixamo"`) or Meshy Rigging API | 1–3 min |

Generating the sheet before the card art keeps the card off the critical path. Time every step in the first test and update the table.

API:

```
POST /api/forge        { player, frames: [front, left, right] }  →  { id }
GET  /api/forge/:id    →  Fighter
```

### Prompts (v1, tune them)

**Brief** (vision model, JSON mode):

```
You're casting a fighting game. From these photos of one person, return JSON:
{
  "name": a playful 2–3 word fighter name, never about their body,
  "distinctive": the 3 most distinctive things about how they look (hair, eyebrows, jaw, glasses, beard, build, outfit),
  "archetype": "brawler" | "speedster" | "tank" | "showboat",
  "outfit_upgrade": one sentence turning their outfit up to 11,
  "prop": one signature prop that fits their style,
  "palette": 3 hex colors from their outfit,
  "scout_report": one fighting-game scouting line, nothing about their body or face
}
```

**Model sheet** (scan frames + brief as input):

```
Turn the person in these photos into a playable fighter from a 2003 PS2 fighting game:
cartoonish and caricatured (think Ready 2 Rumble Boxing or Rockstar's Bully), not realistic.
Push these features 2-3x so their friends would recognize them instantly: {distinctive}.
Body type: {archetype}. Keep their real hairstyle, skin tone, facial hair, glasses and outfit,
upgraded like this: {outfit_upgrade}. Head about 1.3x normal size.

Layout: a 3D model reference sheet. One full-body view, head to feet, facing the camera.
A-pose with arms 45 degrees out from the body, legs slightly apart, closed fists.
Neutral expression. No props, no capes, no long coats. Plain light gray background,
even lighting, no shadows, no text.
```

**Card art** (model sheet as reference):

```
The exact same character as the reference image: same proportions, outfit and exaggerations.
Dynamic fighting stance, slightly low camera angle, cocky expression, holding {prop}.
PS2-era 3D game render: low-poly, low-res textures, hard rim light.
Plain dark background, no text.
```

The A-pose, closed fists, spread arms and no capes exist for the rigger: no fingers to rig and no limbs fused to the body. The attitude lives in the card art and the animations. The brief JSON also feeds the scout report and the commentators.

### Fallback ladder

If a step fails, or the fighter isn't ready 5 minutes after the scan, drop down a level:

1. The full generated, rigged fighter.
2. Generated mesh, but the rig looks rubbery: **action-figure mode**, with the mesh cut into rigid pieces, each locked to one bone.
3. 3D or rigging failed: a stock rigged body recolored to the palette, with the generated head (or the card-art face as a texture).
4. No consent, or everything failed: the masked mystery fighter.

Before judging, forge all four of us plus a few volunteers as house fighters, so a judge always has an opponent.

### 3D generator: picking one

Run each candidate on all four of us by 4 PM. Judge three things:
- Does it look like the person from 2 m away?
- Are the arms clear of the body, so the rig works?
- How long does it take?

What we know so far:
- Tripo takes multiview input and can auto-rig to Mixamo bone names. Its prompt doesn't steer the shape; exaggeration has to happen in the 2D sheet.
- Rodin Gen-2 takes images plus a text prompt and has a T/A-pose option.
- TRELLIS.2 gave a good result in an early test on the HF Space.
- Meshy's Rigging API accepts outside GLBs by URL (about $0.20 per fighter through fal.ai).

Budget about $50–100 in API credits.

## Vision

- `@mediapipe/tasks-vision` PoseLandmarker, `runningMode: "VIDEO"`, GPU delegate. One instance per camera.
- Try the lite model first and switch to full only if tracking is poor.
- Set `numPoses: 2` and keep the pose closest to the frame center, so a passerby or the other player doesn't steal the tracking.
- Pick the two cameras with `enumerateDevices()` in a settings panel, and remember the choice in localStorage.
- Smooth every landmark with a One Euro filter. Tune it in the debug overlay: too little smoothing jitters, too much lags.
- **Body units.** Measure everything in the player's own arm length L (shoulder → elbow → wrist, calibrated in the tutorial). Distance from the camera and body size then don't matter, and standing closer doesn't hit harder.
- **Calibration** happens in the tutorial: arm length, torso size, guard position, and the speed of the player's hardest jab.
- **Tracking loss.** If visibility drops for more than 300 ms, set `tracked: false`. The fighter holds guard and a "step back into frame" hint shows.

## Intent reader

v1 is hand-tuned rules on the landmark signals. v2, if there's time, is a small classifier trained on recordings of the four of us; add a record button with labels to the debug panel. The thresholds below are starting guesses, so tune them.

Signals per frame, in body units:
- arm extension: shoulder-to-wrist distance ÷ L
- wrist speed in L per second
- elbow angle
- wrist height vs. the shoulder line
- head offset from the guard position
- torso size vs. calibrated, to detect stepping in or out

| Command | Trigger (starting values) |
|---|---|
| anticipate | Extension rising fast for ~100 ms. Lets the director start the wind-up before the move is confirmed. |
| jab / cross | Lead / rear hand. Extension goes from under 0.6 to over 0.85 within 250 ms, with the elbow nearly straight at the peak. |
| hook | Elbow stays bent (70–120°) while the wrist sweeps across the body more than 0.6 L. |
| uppercut | Wrist rises more than 0.6 L from below the chest with the elbow bent. |
| height | Wrist above the shoulder line at the peak means head; below means body. |
| block | Both wrists within 0.5 L of the nose for 120 ms or more. |
| slip | Head moves sideways more than 0.35 L in under 250 ms. |
| duck | Head drops more than 0.35 L in under 250 ms. |
| advance | Torso size above 112% of calibrated means stepping in; below 90% means backing off. |

Both players default to orthodox (left hand leads). Add a southpaw toggle.

**Speed** is the peak wrist speed ÷ the player's calibrated max, mapped to 0.8–1.3, so skill gets judged against your own body, not athleticism.

**Wind-up** combines how far the wrist goes behind the shoulder (world z) with torso rotation in the ~400 ms before the throw, mapped to 0.8–1.3. Single-camera depth is rough, so lean on torso rotation and expect this to need tuning.

## Fight engine

- Fixed 60 Hz tick. A 1D fight line: positions in meters, fighters start 1 m apart, arena from −1.5 m to 1.5 m.
- **Hits resolve by range and timing, not mesh collisions.** A hit lands if the attack's active frames happen while the defender is in range and not defending correctly. Geometry is visual only: IK puts the fist on the target.
- Range bands (distance between fighters, at 1 m tall): close up to 0.5 m, mid up to 0.7 m, long up to 0.9 m.

| Move | Startup | Active | Recovery | Base damage | Range | Chip on block |
|---|---|---|---|---|---|---|
| jab | 8 | 3 | 10 | 5 | long | 1 |
| cross | 14 | 3 | 18 | 10 | long | 2 |
| hook | 12 | 4 | 18 | 9 | mid | 2 |
| uppercut | 16 | 3 | 22 | 13 | close | 3 |

Frames are at 60 fps. These are starting values for playtesting.

**Defense:**
- **Block:** while guard is up, attacks do only chip damage, with 8 frames of blockstun and no head rock.
- **Slip:** 15 frames where straight punches (jab, cross) miss.
- **Duck:** 15 frames where head hooks miss. Uppercuts beat ducks.
- **Counter:** an attack that lands during the opponent's startup or recovery gets ×1.5 damage.

**Damage** = base × windup × speed × counter (1.5) × gassed (0.6), rounded. Blocked hits do chip damage only.

**Rules that reward skill over flailing:**
- **Return to guard:** a hand can't throw again until its wrist comes back near the face.
- **Stamina:** 100 max. Jab costs 6, cross and hook 12, uppercut 15, and a whiff costs 6 extra. It regenerates 15/s after 0.6 s without attacking. Below 20 you're gassed: +4 startup frames and ×0.6 damage.
- **Buffering:** an attack thrown during recovery is buffered for 6 frames, then dropped.

**On hit:**
- **Hit-stop:** 4 + damage ÷ 2 frames, capped at 14 (about 67–233 ms). Both fighters freeze; the camera and VFX keep running.
- **Hitstun:** 10 + damage frames.
- **Knockback:** 0.02 m × damage along the fight line.
- **Head rock:** 3° × damage. A jab is about 15°; a full-power counter uppercut is about 50°.

**End:** K.O. at 0 HP. When the 60 s timer runs out, more HP wins.

**Latency:** camera → landmarks → intent adds roughly 150–250 ms. Don't build a twitch fighter. Build a heavyweight slugfest where big punches can be seen coming, and let anticipation animations hide the gap.

## Director: animation, camera, effects

**Fighters:** rigged GLBs with Mixamo bone names, each with an AnimationMixer and three layers:
- **Locomotion:** idle guard, step forward, step back.
- **Action:** attacks and reactions.
- **Live pose:** the player's tracked spine, head and arms blended in at about 30% during idle and guard, and 0% during attacks and reactions. It keeps the fighter feeling like you without letting webcam noise drive the punches.

**Attack clips** play at a rate set by the command's speed, so a fast punch from you is a fast punch on screen. At contact, two-bone IK pulls the fist onto the target.

**Stepped animation:** the game, camera and VFX run at 60 fps, but fighter poses update at about 12 fps.
- Restart the step clock the instant a new action starts, so the first pose of every move shows immediately with no added latency.
- Hit-stop freezes the poses.
- Fast moves and specials can switch to every frame for a burst of smoothness.

**Live pose → bones:** turn landmark pairs into bone directions and rotate each bone from its rest direction to the tracked one. Kalidokit is an option if it saves time.

**Retargeting:** Mixamo clips assume a T-pose rest and our fighters stand in an A-pose. Fix it with `SkeletonUtils.retargetClip`, or bake a T-pose rest during rigging. Test this early.

**Clips (~15, from Mixamo):**
- idle guard, step forward, step back
- jab, cross, hook L/R, uppercut
- block, slip L/R, duck
- hit to the head (light and heavy), hit to the body, stagger
- K.O. fall, victory, walk-in struts per archetype

**Camera:** a side view framing both fighters, easing to keep them in frame. Punch in close on counters and big hits. On a K.O., a slow-motion orbit.

**Effects** (a distinct look per event):
- **Hit:** sparks sized by damage, screen shake on heavy hits.
- **Block:** cool-colored sparks and a "BLOCK" pop.
- **Whiff:** a motion trail.
- **Counter:** a "COUNTER!" pop and 2–3 high-contrast impact frames.
- **K.O.:** impact frames, slow motion, then the replay.

**Audio:**
- Hits per type: a light jab tick, a heavy thud, a block clack.
- A crowd loop and a K.O. bell.
- A walk-out track with a known BPM, so cuts and pyro land on the beat.

## Visual style

- Characters are exaggerated PS2-era caricatures, set by the forge prompts.
- The overall look is open. Build the scene with a style toggle: one key cycles post-processing presets (raw low-res PS2, toon shading with outlines, a halftone comic look). Pick by comparing them on real forged fighters.
- Stepped animation is decided separately and works with any look.

## Stretch features, in priority order

1. **Walk-in** (10–12 s, on the beat):
   1. Both cards slam in with name, record and scout report.
   2. The camera pushes through the cards into the tunnel. The cards are 3D objects in the same scene, so there's no cut.
   3. A wide handheld shot of both fighters walking out side by side, sparks raining down, each with their archetype's strut.
   4. A low-angle hero shot of each fighter with a name plate and pyro.
   5. A face-off close-up with two lines of AI trash talk, then FIGHT.

   Rematches get a 2-second version.
2. **Commentators.**
   - Inputs: the `FightEvent` log, both briefs, fight history and the clock.
   - A fast LLM writes one-line calls, voiced by two TTS voices with captions always on. A queue keeps them from talking over each other.
   - Walk-in lines get written during the forge, so they land on cue.
   - Rule: roast the fighting, the outfit, the hour and the record, never bodies or faces.
3. **Choreographer.** Jev (TypeSafe, through OpenRouter's Decisions endpoint) or OpenAI's Decisions API picks how each exchange looks: reaction, camera shot, drama level. It never decides outcomes. The default reaction plays instantly and Jev's pick takes over a beat later.
   - Training flow: a fast LLM narrates choreography while we play, and we log it with teammate ratings.
   - Those logs shape a schema of many small, well-defined questions.
   - The same logs can train the intent reader.
4. **Progression.** Fighter profiles in MongoDB Atlas with XP, level, record and rivals, and a QR code to keep your fighter on your phone.

## Consent

Show this before every scan:

> Save fighter to memory card? Your photos go to our AI services to build your fighter and are deleted after the event.

The masked mystery fighter is the no option, so nobody sits out. Don't store raw photos past the forge. Delete everything after the event.

## Plan

**Milestones:**
- **4:00 PM Sat:**
  - Both cameras drive stick figures with commands showing in the debug overlay.
  - The engine runs a keyboard fight with HP and hit-stop.
  - The forge has been run by hand on all four of us, and the 3D generator and rigger are picked.
- **5:00 PM:** likeness verdict. Do at least 3 of 4 look like the person?
- **9:00 PM:** the whole loop end to end, even if ugly: detect → scan → forge → rigged fighter → fight → K.O.
- **10:30 PM:** Devpost draft with tracks listed.
- **2:00 AM:** walk-in, effects, visual style picked, commentators v1.
- **7:00 AM:** tuning, house fighters forged, demo video recorded.
- **10:00 AM Sun:** submit.

Every hour after 9 PM should go into playing it against each other and tuning the numbers. That's what makes it feel good, and it can't be one-shotted.

**Suggested split:**
- **Forge:** capture, server pipeline, prompts, cleanup, rigging, fallbacks.
- **Fight:** vision, intent reader, fight engine, calibration tutorial.
- **Show:** director, animation, camera, effects, HUD, walk-in, visual style.
- **Voice:** commentators, audio, demo video, Devpost.

**Cut order**, first to go: progression → choreographer → commentator voices (keep captions) → full walk-in (keep VS cards and countdown). Never cut the forge or the fight feel.

## Tracks and submission

- **Main track:** Chef's Choice.
- **Sponsored, up to 3:** Cloudforce (Most Viral / Most Interesting), Perceptron (if it powers the brief step), and T-Mobile if its brief fits, otherwise Photon. Read the briefs in the hacker guide before 10:30 PM.
- **Non-sponsored:** DubHacks NEXT; MLH Gemini API (if Gemini is in the forge); MongoDB Atlas (if progression ships); GoDaddy best domain (check whether brawlegle.com is available).

## Risks

| Risk | Mitigation |
|---|---|
| The likeness misses | Test by 5 PM. Fallback: generated face on a stock head. |
| The forge is too slow | Sheet-first critical path, tutorial covers the wait, house fighters, 5-minute timeout fallback. |
| The rig looks rubbery | Rigid head and fists, small move set, action-figure mode. |
| Two trackers are too slow | Lite model, lower resolution, alternate frames between cameras. Worst case: one camera tracking 2 people. |
| It feels laggy | Slugfest pacing, anticipation animations, generous windows. |
| Players flail | Return-to-guard, stamina. |
| Venue Wi-Fi (SSH is already blocked) | The forge needs internet. Keep a phone hotspot as backup. |
| Image API refuses to edit a real person | Second provider (Gemini ↔ OpenAI) as a fallback. |
| The hall is loud | Captions, speaker. |

## Open questions

1. Two-camera frame rate on our laptop. Test this first.
2. Which 3D generator and rigger. Decide by 4 PM.
3. OpenAI vs. Gemini for image generation, on speed and likeness.
4. Laptop OS. On a Mac, an iPhone works as a webcam through Continuity Camera.
5. Can we get an external monitor for the booth?
6. Final name and domain.
