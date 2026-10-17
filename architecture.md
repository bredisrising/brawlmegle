# Architecture

## Flow

    Camera
      -> vision/       makes a Pose (14 joints, 1m tall)
      -> player/       Fighter shows the Pose in the world
      -> game/         Game checks hits, updates HP + phase, writes to the store
      -> ui/           React reads the store, draws the HUD over the 3D canvas
      -> engine/       Three.js renders the scene every frame

Game phases: lobby -> countdown -> fighting -> ko -> rematch


## Folders

### ui/
HUD, health bars, "Detect Player" panels, countdown, popups, K.O. screen.
- TODO: nothing required (maybe a webcam preview per player).

### engine/
Three.js renderer, camera, stage, render loop, freeze frames, camera shake.
- TODO: `Effects.ts` - hit sparks and impact rings for each hit type.

### game/
`Game.ts` runs the phases and applies hits. `store.ts` holds UI state.
- TODO: `combat.ts` - detect punches (wrist speed + touching head/body), blocks, damage.

### player/
`Fighter.ts` places a player in the world and draws a placeholder skeleton.
- TODO: load the generated 3D model, drive its rig from the Pose, add knockback in `hit()`.

### vision/
`Pose` type, `PoseTracker` interface, mock tracker (just stands there).
- TODO: `MediaPipePoseTracker.ts` + `normalize.ts` - webcam -> MediaPipe -> Pose, two cameras for 3D.

### services/
`forge.ts`: scan -> hero image -> 3D model (fake delays for now).
- TODO: real calls through a backend to the ChatGPT image API and an image-to-3D service.
