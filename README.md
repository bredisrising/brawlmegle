# Brawlegle

Working name. DubHacks '26.

Get scanned, get forged into a caricatured fighter, then fight a stranger using your own body as the controller.

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run typecheck
```

Copy `.env.example` to `.env` to configure. `?input=camera` switches this machine's input from the mock and enables MediaPipe pose tracking. Camera access works on `localhost` or HTTPS. The first camera start downloads MediaPipe's WASM runtime and the lite pose model.

In development, press **D** or click **Pose debug** to open the live camera monitor. It overlays the detected body skeleton on the mirrored camera feed and lists each landmark's normalized image coordinates, hip-centered world coordinates, and visibility score. Add `&debugPose=1` to the URL to open the panel automatically.

The intent reader has initial heuristics for jabs/crosses, hooks, uppercuts, blocking, slips, and ducks. These thresholds still need calibration with real players. The fight engine is currently a stub, so recognized commands are produced but do not yet resolve into hits or damage.

In dev, press `1` / `2` to fake a hit on P1 / P2 (hold Shift for a counter). That lets you test the HUD, popups and KO screen before the fight engine exists.

To try a basic 3D avatar, select **Host → Choose existing → default**. This built-in low-poly human uses a static boxing guard pose (no rig or animations yet). Its model is `public/models/default.glb`; regenerate it with `node scripts/create-default-avatar.mjs`.

## Docs

- [SPEC.md](SPEC.md): the full design.
- [architecture.md](architecture.md): the short version, plus what each folder still needs.
