# Brawlmegle

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

## End-to-end tests

`npm run test:e2e` drives the live site (https://54-149-60-196.sslip.io) in headless Chromium with a fake webcam, like a stranger would: every screen and button, username validation, Welcome back, the roster, camera denied / missing / nobody in view, the forge API with bad input, the matchmaker smoke test, and the hosted tuner and scan pages. It never starts a paid forge unless asked. Results print as `ok`, `FAIL`, or `KNOWN` (a reported issue in `research/e2e-report.md`, which doesn't fail the run unless `E2E_STRICT=1`). Screenshots go to `research/e2e-shots/`.

```sh
npx playwright install chromium-headless-shell   # once
(cd matchmaker && npm install)                    # once, for the matchmaker smoke test
npm run test:e2e                                  # api, matchmaker, ui, camera, tools (~10 min)
npm run test:e2e -- api ui                        # just some files

# A person on the fake webcam (the scan page then has to capture front/left/right):
ffmpeg -i turn.mp4 -vf scale=640:480 -pix_fmt yuv420p -r 30 turn.y4m
E2E_VIDEO=$PWD/turn.y4m npm run test:e2e -- tools

# One real scan + forge through the game (spends OpenAI + Tripo credits):
E2E_PAID=1 E2E_VIDEO=$PWD/turn.y4m npm run test:e2e -- forge-live
```

`E2E_BASE` points it at another deployment (e.g. `http://localhost:5173`), `CHROME_PATH` at another Chrome. MediaPipe runs at a few fps on the software GL in headless Chrome, so the suite uses `?pose=lite` and waits patiently.

## Docs

- [SPEC.md](SPEC.md): the full design.
- [architecture.md](architecture.md): the short version, plus what each folder still needs.
