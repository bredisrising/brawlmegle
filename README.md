# Brawlegle

Working name. DubHacks '26.

Get scanned, get forged into a caricatured fighter, then fight a stranger using your own body as the controller.

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run typecheck
```

Copy `.env.example` to `.env` to configure. `?input=camera` switches this machine's input from the mock and enables MediaPipe pose tracking. Camera access works on `localhost` or HTTPS. The default Lite model is tuned for fast response: it uses 640×480 capture, processes each camera frame once at up to 30 FPS, and applies an adaptive One Euro filter that removes jitter without delaying fast punches. The first camera start downloads MediaPipe's WASM runtime and model.

Use `?poseModel=full` when lighting, framing, or body visibility requires more accuracy and the device has GPU headroom. Lite is the recommended setting for fighting controls. `?poseCount=2` enables two-person detection for a shared camera; one person per camera remains faster and more reliable.

In development, press **D** or click **Pose debug** to open the live camera monitor. It overlays the detected body skeleton on the mirrored camera feed and lists each landmark's normalized image coordinates, hip-centered world coordinates, and visibility score. Add `&debugPose=1` to the URL to open the panel automatically.

The intent reader has initial heuristics for jabs/crosses, hooks, uppercuts, blocking, slips, and ducks. These thresholds still need calibration with real players. The fight engine is currently a stub, so recognized commands are produced but do not yet resolve into hits or damage.

## 2.5D pose axes

The game uses MediaPipe world landmarks for control: **X** is the lateral dodge lane, **Y** is vertical body movement, and **+Z** is a strike moving toward the opponent. MediaPipe reports smaller Z values closer to the camera, so the game flips this value before using it. Punch recognition is gated by wrist movement along this forward Z axis; X and Y classify dodges and punch height.

In dev, press `1` / `2` to fake a hit on P1 / P2 (hold Shift for a counter). That lets you test the HUD, popups and KO screen before the fight engine exists.

To try a basic 3D avatar, select **Host → Choose existing → default**. This built-in low-poly human uses a static boxing guard pose (no rig or animations yet). Its model is `public/models/default.glb`; regenerate it with `node scripts/create-default-avatar.mjs`.

## Docs

- [SPEC.md](SPEC.md): the full design.
- [architecture.md](architecture.md): the short version, plus what each folder still needs.
