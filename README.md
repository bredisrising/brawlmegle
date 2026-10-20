# Brawlmegle

> Get scanned, get forged into a caricatured fighter, then fight a stranger using your own body as the controller.

Brawlmegle is a two-player browser fighting game built for DubHacks 2026. A webcam feeds MediaPipe pose tracking; the intent reader turns movement into fighting commands; a deterministic TypeScript engine resolves the fight; and Three.js presents the result. Players can scan themselves into a custom fighter, play a friend over WebRTC, find an online opponent, or spar against the CPU.

## What you can do

- **Fight with your body.** Jabs, crosses, hooks, uppercuts, blocks, slips, and ducks are read from the webcam. The camera reports intent; the game engine decides hits and damage.
- **Forge a fighter.** A guided front/side scan can be turned into card art and a 3D fighter through the optional forge service. Existing fighters and a built-in fallback are also available.
- **Play together online.** Create a room code, join a friend, or use quick matchmaking. After signaling, match traffic is peer-to-peer over WebRTC; TURN is available for restrictive networks.
- **Practice locally.** Use mock input during development or fight the CPU from a hosted lobby.

## Quick start

**Prerequisites:** Node.js 22+ is recommended (the forge requires Node.js 22+; the matchmaker requires Node.js 20+).

```sh
npm install
Copy-Item .env.example .env    # PowerShell; configuration is optional for mock mode
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Local development defaults to mock input, so the game can be explored without a webcam or services.

To use a camera, set `VITE_INPUT=camera` in `.env` or open `http://localhost:5173/?input=camera`. Browsers allow camera access on `localhost` or HTTPS. The first start downloads MediaPipe's WASM runtime and pose model. On slower hardware, use `?pose=lite`.

## Local configuration

Copy `.env.example` to `.env`. The client is usable with the defaults; these variables enable optional integrations:

| Variable | Purpose |
| --- | --- |
| `VITE_INPUT` | `mock` for keyboard/test input or `camera` for MediaPipe pose tracking. |
| `VITE_FORGE_API` | URL of a forge API. Leave empty to use local mock responses. |
| `VITE_SIGNAL_URL` | WebSocket signaling endpoint for friend rooms and matchmaking. |
| `VITE_TURN_URL`, `VITE_TURN_USER`, `VITE_TURN_PASS` | Optional TURN server configuration for WebRTC fallback. |

Never put OpenAI or other server-side credentials in `VITE_*` values: Vite exposes them to the browser.

## Running the supporting services

The production deployment combines the game, forge API, and signaling server on one domain. For a fully local setup, run the services separately.

### Forge API

The forge holds API keys, accepts scan frames, creates fighter assets, validates and optimizes a rigged GLB, and serves the roster.

```sh
cd forge
npm ci
npm start
```

It listens at `http://127.0.0.1:8787`. Set `VITE_FORGE_API=http://127.0.0.1:8787` in the root `.env`, then restart Vite. Add server-only credentials such as `OPENAI_API_KEY` to the root `.env` only when running a real paid forge. See [forge/README.md](forge/README.md) for the API, pipeline, and environment settings.

### Matchmaker

The matchmaker only brokers WebRTC signaling and issues TURN credentials; gameplay travels directly between peers after connection.

```sh
cd matchmaker
npm install
npm start
```

It exposes `ws://127.0.0.1:3000/ws`. Point `VITE_SIGNAL_URL` at that endpoint to test local friend rooms. Details and a protocol reference are in [matchmaker/README.md](matchmaker/README.md).

## Development controls

- Press **D** or click **Pose debug** to inspect the mirrored camera feed, skeleton, landmarks, and visibility values. Add `&debugPose=1` to open it automatically.
- Press **1** or **2** in development to simulate a hit for P1 or P2; hold **Shift** for a counter. This exercises the HUD, popups, and K.O. flow.
- Press **C** to toggle the camera picture-in-picture during a fight, and **H** for the move guide.
- Select **Choose existing → default** to load the built-in low-poly fighter. Regenerate it with `node scripts/create-default-avatar.mjs`.

## Verify changes

```sh
npm run typecheck
npm run build
npx vitest run
npm run test:p2p
```

`npm run test:p2p` starts the local matchmaker and Vite app, then uses a browser to exercise the peer-to-peer path. It uses an installed Chrome by default; set `CHROME_PATH` to override it.

### End-to-end suite

The browser suite checks the deployed site by default, including the API, matchmaker, UI, camera states, and hosted tools. It does not start a paid forge unless explicitly enabled.

```sh
npx playwright install chromium-headless-shell  # once
(cd matchmaker && npm install)                  # once, for matchmaker checks
npm run test:e2e                                # all standard suites
npm run test:e2e -- api ui                      # selected suites
```

Set `E2E_BASE=http://localhost:5173` to target a local deployment and `CHROME_PATH` to choose another Chrome binary. For a real scan/forge run—which spends provider credits—supply a Y4M turn video and opt in explicitly:

```sh
E2E_PAID=1 E2E_VIDEO=turn.y4m npm run test:e2e -- forge-live
```

Screenshots are written to `research/e2e-shots/`; documented non-blocking issues appear as `KNOWN` unless `E2E_STRICT=1` is set.

## Project map

| Path | Contents |
| --- | --- |
| `src/input/` | Camera, mock, and remote pose sources. |
| `src/intent/` | Pose preprocessing and movement-intent recognition. |
| `src/fight/` | Deterministic fighting rules, commands, resolver, and CPU. |
| `src/director/` | Three.js arena, fighter animation, effects, and ragdolls. |
| `src/game/` | Match orchestration, P2P host/client sessions, replay, recording. |
| `src/ui/` | React screens, HUD, scanning, roster, and forge UI. |
| `src/forge/` | Browser-side scan capture, forge client, and fighter roster. |
| `forge/` | Server-side forge pipeline and GLB rig/asset tooling. |
| `matchmaker/` | Standalone WebSocket signaling/TURN-credential service. |
| `test/` | Unit, integration, P2P, intent, and browser end-to-end tests. |
| `research/` | Evaluation notes, performance measurements, and test artifacts. |

## Documentation

- [SPEC.md](SPEC.md) — complete product and technical specification.
- [architecture.md](architecture.md) — system flow and codebase guide.
- [forge/README.md](forge/README.md) — forge service, asset pipeline, and configuration.
- [matchmaker/README.md](matchmaker/README.md) — signaling service, protocol, and deployment notes.
