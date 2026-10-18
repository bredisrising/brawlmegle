# Architecture

Full details live in SPEC.md. This is the short version.


## Two laptops

    HOST laptop  = the game. Tracks + scans P1, runs everything, shows the big screen.
    CLIENT laptop = a scanner. Tracks + scans P2, sends it all to the host.
    AWS server   = only the handshake (room codes). Game data never goes through it.

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
InputSource interface, InputHub (the wrapper), CameraSource, RemoteSource, MockSource.
- TODO: InputHub, CameraSource (MediaPipe), RemoteSource, a replay source.

### net/
Signaling (AWS WebSocket), Peer (WebRTC), protocol.ts (message types).
Peer.join answers the host's offer, chunks big control messages, and game/ClientSession.ts sends
profile/scan/pick, streams poses, and rejoins on drop. Peer.host keeps the room open, makes a fresh
connection (both channels + offer) per peer-joined, watches the RTCPeerConnection for drops, and
reopens the room if signaling drops; game/HostSession.ts feeds P2's poses into a RemoteSource and sets
P2 up from what the client sends. The matchmaker lives in matchmaker/.

### intent/
IntentReader, one per player, runs on the host.
- TODO: turn PoseFrames into Commands + Stance (SPEC.md "Intent reader").

### fight/
FightEngine. Pure TypeScript, no Three.js or React, no randomness.
- TODO: frame data, range, blocks, stamina, hit-stop (SPEC.md "Fight engine").

### director/
Renderer (Three.js), Arena, FighterView, Effects, pose helpers.
- TODO: forged GLB + animation in FighterView, hit effects, camera moves.

### forge/
scanBuckets.ts (pure: facing from landmarks, front/left/right buckets, sharpness), scan.ts (live capture
from the camera's video + pose frames), forge.ts (captureScan, submitForge/getForge/forgeFighter against
config.forgeApi, mocked when empty), roster.ts (memory card: forge server's fighters + localStorage + house).

### game/
Game.ts wires everything on the host and runs the phases. store.ts is UI state.
HostSession.ts (host) and ClientSession.ts (client) are the two ends of the P2P link: the host sends
welcome, roster, phase and P2's `fighter` progress; the client sends profile/scan/pick and poses.

### ui/
screens/: TitleScreen (Host / Connect), AvatarScreen (scan new / choose existing / name),
ClientScreen (client's waiting view). Plus HUD, health bars, lobby panels, countdown, popups, K.O.
- TODO: scan progress ring, tutorial, VS cards, camera preview on the client.
