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
config.forgeApi, mocked when empty), roster.ts (memory card: forge server's fighters + localStorage + house).

### game/
Game.ts wires everything on the host and runs the phases (round clock, combos, callouts), or mirrors the
host's fight on the client. store.ts is UI state.
HostSession.ts (host) and ClientSession.ts (client) are the two ends of the P2P link: the host sends
welcome, roster, phase and P2's `fighter` progress; the client sends profile/scan/pick and poses.

### ui/
screens/: TitleScreen (Host / Connect), AvatarScreen (scan new / choose existing / name),
ClientScreen (client's waiting view). Plus HUD, health bars, lobby panels, countdown, popups, K.O.
CameraPip (your camera + skeleton + the last move read; C toggles), MoveGuide (H), ComboCounter + Callout.
