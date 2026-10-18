# Architecture

Full details live in SPEC.md. This is the short version.


## Two laptops

    HOST laptop  = the game. Tracks + scans P1, runs the fight, draws it.
    CLIENT laptop = tracks + scans P2, sends poses to the host, and draws the host's fight (mirror).
    AWS server   = the handshake (room codes, TURN) and the forge. Game data never goes through it.

No one around? The P2 panel has "Fight the CPU" (easy / normal / hard, fight/Cpu.ts): the CPU borrows a
forged fighter from the server and plays through the same engine commands a player's reader produces.

Connecting: Host taps "Host" -> gets a room code. Client taps "Connect" -> types the code.
Then the two laptops talk directly over WebRTC (P2P).


## Flow (on the host)

    any input source       CameraSource (P1), RemoteSource (P2 over P2P), MockSource, replay
      -> InputHub          the wrapper: maps a source to a player, hands out PoseFrames
      -> IntentReader      PoseFrames -> what the player meant (jab, block, ...)
      -> FightEngine       pure rules at 60 Hz, decides hits, HP, K.O.
      -> Director          Three.js: fighter visuals, animation, effects, camera
      -> UI                React overlays read the store

Rule: the camera says what you meant, the engine decides what happens,
the director makes it look good.

The orchestrator in practice (camera -> on screen, ~180 ms from the first sign of a punch to it landing):
- IntentReader sends `anticipate` at a wind-up's first frame (the fighter shows a tell immediately), then a
  `strike` when it's sure (>= 60 ms after onset), with `onsetT`.
- Resolver picks the move from the intent + fight state (lunge from range, knee vs kick, uppercut on a duck)
  and passes `headStart` = frames the wind-up has already been on screen; the engine counts them toward
  startup (FIGHT.maxHeadStart / minStartup).
- FightEngine queues attacks thrown while busy (FIGHT.bufferFrames, queueSize) and lets punches chain out of
  recovery (immediately on hit/block, from half recovery on a whiff), so fast combos all come out.
- test/fight/orchestrator.test.ts runs real guided recordings through all of it and prints what was thrown.

Also in the fight:
- Walkout (director/Walkout.ts, walkoutPose.ts, walkoutFx.ts, ui/Walkout.tsx, beats in walkoutTiming.ts): the
  countdown's first beat is a ~9.5 s SF6-style in-stage entrance. The arena goes dark (spotlights, haze, neon), the
  fighters walk up to their marks, each gets a slow low push-in during a signature action (shadowbox, knuckles,
  neckroll, beckon, chestpound, gloves or flex, picked from the name) while the other waits arms folded, then a
  two-shot as they turn to each other into their stance, a white flash and a fire VS, then ROUND 1 and FIGHT. Both
  laptops run it off the countdown and the music's clock, so the host's skip (any key/click) carries over;
  `?walkout=0` skips it. Music: public/walkout/walkout.mp3 (original, scripts/make-walkout-music.mjs); drop in
  public/walkout/custom.mp3 (+ optional custom.json `{"start": s, "drop": s, "beats": {"p1","p2","two","vs","end"}}`:
  where to start, and when after that fighter 1's shot or every cut lands) to use your own track (both gitignored).
- Super: a meter fills from landing hits (FIGHT.meterOn*); with it full, holding both fists up over the head (the
  reader's `special` intent) throws a fireball, a projectile the engine flies, that can be blocked or ducked.
- Commentators (game/Commentary.ts): the host picks the moments (react/callIntro/callFinish in Game.ts): instant
  template lines for big moments, LLM-written intro and K.O. lines from the forge server (POST /api/commentary, using
  the fighters' forge briefs), voiced through GET /api/tts (OpenAI TTS, cached) with captions; mirrored as `call` events.
- K.O. replay: both laptops keep the last ~4 s as drawn and replay the finish slowly from a sweeping camera.
- Highlights (game/HighlightRecorder.ts): the laptop running the fight (host or Practice; not Training, the client or
  phones) records the K.O. replay off the WebGL canvas (960x540 VP9, ~1.2 MB) and uploads it with who, the move and
  the combo to POST /api/highlights; the title screen's reel (ui/HighlightReel.tsx) cycles the newest.
  scripts/highlights/ has the Edge test driver and the seed clips (upload.mjs).
- Match recording (game/MatchRecorder.ts, menu toggle or `?record=1`): both players' poses, intents and fight events
  per round, uploaded to /samples for improving the reader (`?video=1` also saves each laptop's camera locally).
  test/intent/match.test.ts re-reads recorded matches.

Mirror: the host sends the client `match` (who's fighting as what), a `frame` of engine state every tick
(lossy channel) and `events` (hits, wind-ups, moves read). Game.mirrorTick draws it; the client runs no fight.

Screens: title (Host / Connect) -> pick fighter -> lobby (host) or waiting (client)
Game phases: lobby -> countdown -> fighting -> ko -> rematch


## Picking a fighter

    Scan new         -> type name + consent -> turn 360 (3 frames) -> forge -> saved to memory card
                                            \-> "go masked" -> masked fighter, nothing saved
    Choose existing  -> pick from memory card (saved + house fighters)

On the client, the choice (name + frames, or the picked fighter id) goes to the host over P2P.
Only the host talks to the forge server and keeps fighters.
Memory card = the forge server's fighters + localStorage + house fighters (forge/roster.ts).


## Folders (src/)

### types.ts
All shared contracts: PoseFrame, Command, Stance, FighterState, FightEvent, ForgedFighter.

### input/
InputSource interface, InputHub (the wrapper), CameraSource (MediaPipe; lite model on phones, and drops to
lite by itself when full can't keep up), RemoteSource, MockSource.

### net/
Signaling (AWS WebSocket), Peer (WebRTC), protocol.ts (message types).
Peer.join answers the host's offer, chunks big control messages, and game/ClientSession.ts sends
profile/scan/pick, streams poses, and rejoins on drop. Peer.host keeps the room open, makes a fresh
connection (both channels + offer) per peer-joined, watches the RTCPeerConnection for drops, and
reopens the room if signaling drops; game/HostSession.ts feeds P2's poses into a RemoteSource and sets
P2 up from what the client sends. The matchmaker lives in matchmaker/.

### intent/
IntentReader, one per player, runs on the host: preprocess (filters, body units, camera-shake checks) ->
limb bursts -> intents + Stance. Thresholds in DEFAULT_INTENT. research/reader-robustness.md has the eval
matrix (test/intent/matrix.test.ts) and what's still weak.

### fight/
FightEngine (pure TypeScript, no Three.js or React, no randomness), moves.ts (frame data + FIGHT tunables),
Resolver (intent + fight state -> command), Cpu (seeded CPU opponent).

### director/
Arcade fighters, not puppets: fightPose.ts draws what the engine decided (bladed stance with an idle,
strikes timed to the engine's frames with lunges, hit reactions, blocks, evades, K.O. fall, taunt, victory);
the player's live pose is blended in lightly (config.liveBlend, `?live=`). Animation steps at 12 fps like a
fighting game (config.animFps, `?fps=`), key frames snap on time. skeletonPose.ts drives the forged Mixamo
rig; livePose.ts maps camera frames to the display skeleton (sitting or standing). FighterView adds the
rim light, ink outline (`?outline=0`), hit flash and the materialize-in. Renderer: tracking camera, shake,
punch-in, slow-mo, ImpactPass (anime impact frames, `?fx=low` off). Effects (sparks, rings, spikes, beam,
dust), Sfx (synthesized sounds, M mutes).

### forge/
scanBuckets.ts (pure: facing from landmarks, front/left/right buckets, sharpness), scan.ts (live capture
from the camera's video + pose frames), forge.ts (captureScan, submitForge/getForge/forgeFighter against
config.forgeApi, mocked when empty), roster.ts (memory card: forge server's fighters + localStorage + house),
models.ts (every GLB load: the meshopt-capable loader, and preloadModel() to start a fighter's download as soon as
it's known; forge/optimize.js shrinks fighters on the server, vite.config.ts the arena at build).

### game/
Game.ts wires everything on the host and runs the phases (round clock, combos, callouts), or mirrors the
host's fight on the client. store.ts is UI state.
HostSession.ts (host) and ClientSession.ts (client) are the two ends of the P2P link: the host sends
welcome, roster, phase and P2's `fighter` progress; the client sends profile/scan/pick and poses.

### ui/
screens/: TitleScreen (Host / Connect, the highlight reel), AvatarScreen (scan new / choose existing / name),
ClientScreen (client's waiting view). Plus HUD, health bars, lobby panels, countdown, popups, K.O.
CameraPip (your camera + skeleton + the last move read; C toggles), MoveGuide (H), ComboCounter + Callout.
