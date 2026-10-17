# Brawlegle

Working name. DubHacks '26.

Get scanned, get forged into a caricatured fighter, then fight a stranger using your own body as the controller.

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run typecheck
```

Copy `.env.example` to `.env` to configure. `?tracker=mediapipe` switches the pose tracker from the mock.

In dev, press `1` / `2` to fake a hit on P1 / P2 (hold Shift for a heavy hit). That lets you test the HUD, popups and KO screen before combat detection exists.

## Layout

```
src/
  App.tsx              full-screen Three.js canvas + UI overlays
  ui/                  HUD, health bars, player slots, countdown, popups, KO screen
  engine/              Three.js renderer/loop (Engine), stage (Arena), Effects (stub)
  game/
    Game.ts            orchestrator: phases, fixed-step sim, applying hits
    store.ts           zustand store the UI reads from
    combat.ts          hit detection + damage (stub)
    constants.ts
  player/Fighter.ts    fighter entity, placeholder model driven by a Pose
  vision/              Pose type, PoseTracker interface, mock + MediaPipe (stub) trackers
  services/forge.ts    scan -> hero image (OpenAI) -> 3D model pipeline (mocked)
```

Flow: **Detect Player** → `Game.detectPlayer` → tracker starts → forge pipeline → fighter spawns → once both are ready: countdown → fight → KO → rematch.
