# E2E test report: live site, 2026-10-17

Target: https://54-149-60-196.sslip.io (game build from `09d549e`; the host/room-code work that has since landed on `main` was not deployed yet). Driven by the new suite in `test/e2e/` (`npm run test:e2e`, see README) in headless Chromium with a fake webcam: Chrome's test pattern (nobody in view), a person-turning clip (`36564.y4m`), no camera, and camera denied. Screenshots are in `research/e2e-shots/`.

Every issue below has a matching test that prints `KNOWN E2E-xx` until it's fixed (then `FIXED?`).

While this ran, the `bug-review` merge landed on `main` and already fixes E2E-01, 03, 04, 05 and 11 in code. The live site still shows all five, so they need a deploy (forge server + game build); after that the suite should print `FIXED?` for them.

## Top issues

| # | Severity | Issue | On `main` |
|---|---|---|---|
| E2E-01 | High | Everyone's raw scan photos can be downloaded by anyone | fixed, not deployed |
| E2E-02 | High | Anyone can burn the forge credits and lock out the event with the public key (from code, not exercised) | open (junk frames still pass) |
| E2E-03 | Medium | Typing a saved username and pressing Enter quickly starts a new scan instead of loading the fighter | fixed, not deployed |
| E2E-06 | Medium | Camera errors show raw browser text ("Not supported", "Requested device not found") | open |
| E2E-07 | Medium | Without a working camera nobody can play at all, not even a saved or masked fighter | open |
| E2E-14 | Medium | A busy or capped forge is only discovered after the player has done the whole scan (from code) | open |
| E2E-15 | Medium | The tuner's CPU opponent never acts | CPU work in progress |

## What works

- Title → Host → Enter → `demo` → Welcome back (card image loads) → Fight as demo: the rigged 3D fighter loads in the arena (`arena-demo.png`). Usernames are case- and space-insensitive (`DEMO`, ` demo `).
- Username box: odd characters are dropped as you type, 24-character cap with a counter, empty disables both buttons, Enter on empty does nothing, Rescan me switches to the consent prompt (`rescan-consent.png`).
- Load fighter: the roster shows the 3 server fighters plus `default` and the 3 house fighters; picking one loads it (`roster.png`, `arena-house-fighter.png`).
- Go masked: fights without a scan and sends no POST.
- C hides and shows the camera picture-in-picture, and is ignored while typing.
- Refresh mid-flow (on the username step, or while the camera is starting) lands on a working title screen.
- Nobody in view: the scan shows "Step back so the camera sees you, head to hips", gives up after ~30 s with "Couldn't set up your fighter: The scan got no frames: nobody was in view", sends nothing to the forge, and Enter works again (`scan-nobody-during.png`, `scan-nobody-error.png`).
- Forge API: good and bad usernames, unknown ids, `__proto__`, 4000-char ids, traversal (`..%2F`, `%2e%2e%2f`, `%252F`, `%00`) all return 4xx or the SPA page and never leak a server file. No key / wrong key → 403, wrong content type → 415, bad JSON / bad frames → 400, a 26 MB body → 413 and the server stays up. CORS only answers listed origins.
- Matchmaker: `matchmaker/test/smoke.js` against `wss://54-149-60-196.sslip.io/ws` passes all 9 checks (rooms, relay, TURN, rejoin).
- Tools: `/tuner/` and `/scan/` load, start the fake camera and track; the scan page captures and stops at "Ready to forge" without forging.

## Issues

### E2E-01 High: raw scan photos are public
`/api/fighters` lists every fighter id, and `/api/forge/<id>/front.jpg|png`, `left.jpg`, `right.jpg` serve the raw camera crops to anyone. Today: `demo/front.png` (2.5 MB), `bred/front.jpg`, `bred/left.jpg`, `bred/right.jpg`, `e2etest2/front.jpg`, `e2etest2/left.jpg`. The consent text says photos go to "our AI services"; it doesn't say the open internet. The fighter JSON also exposes each player's username and a description of their face.
- Repro: `curl -s https://54-149-60-196.sslip.io/api/fighters | jq -r '.[].id'`, then `curl -O https://54-149-60-196.sslip.io/api/forge/<id>/front.png`.
- Fix idea: drop `front|left|right` from the `FILES` regex in `forge/server.js` (the pipeline reads them from disk, the game never needs them).

### E2E-02 High: anyone can spend the forge credits and lock out the event (from code, not exercised)
The forge key ships in the bundle (`src/config.ts`, by design), and `decodeImage` accepts any base64 that starts with the JPEG/PNG magic bytes. So a script can POST `{"frames":["/9j/"]}` (4 bytes) and start a paid forge. 3 such requests fill `FORGE_MAX_ACTIVE` (every real player gets 429 "3 forges already running") and 40 in an hour hit the hourly cap for everyone. Not tested on purpose (spends credits).
- Fix ideas: decode the image (dimensions, minimum size) before accepting; per-IP limits; check caps before the 15 s scan (see E2E-14).

### E2E-03 Medium: a fast Enter on a saved username starts a new scan
The profile lookup is debounced 300 ms; until it answers, the form's submit is "Yes, scan me". Type `demo` and press Enter right away and you're scanning (and would forge a new fighter over demo's) instead of getting Welcome back. People type a username and hit Enter.
- Repro: Host → Enter → type `demo` → Enter within ~0.3 s → "Turn slowly" (`enter-race.png`).
- Fix idea: disable submit while `found === undefined` (checking), or look up on submit.

### E2E-04 Low: `POST /api/forge` with a JSON `null` body is a 500
`{"error":"Cannot read properties of null (reading 'frames')"}`. Any non-object JSON should be a 400.
- Repro: `curl -X POST -H 'content-type: application/json' -H 'x-forge-key: <key>' -d null https://54-149-60-196.sslip.io/api/forge`

### E2E-05 Low: bad percent-encoding in a username is a 500
`/api/profiles/%FF`, `%C0%AF`, `%ED%A0%80` return 500 `{"error":"URI malformed"}` (`decodeURIComponent` throws). nginx already rejects `%` and `%E0%A4%A` with its own 400.
- Repro: `curl -i https://54-149-60-196.sslip.io/api/profiles/%FF`

### E2E-06 Medium: camera errors are raw browser text
Camera denied shows "Couldn't set up your fighter: Not supported" in this Chrome (real Chrome says "Permission denied"); no camera shows the raw `NotFoundError` text. Neither says "camera" or what to do (`camera-denied.png`, `camera-none.png`). The scan and tuner pages do it right: "camera didn't start (...). Allow camera access, then click Start camera."
- Repro: launch Chrome with `--deny-permission-prompts` (or block the camera in site settings) → Host → Enter → demo → Fight as demo.
- Fix idea: map `NotAllowedError` / `NotFoundError` / `NotReadableError` (camera in use by another app) to plain messages in `CameraSource.start`.

### E2E-07 Medium: no camera, no game
Every path (saved fighter, house fighter, masked) starts the camera first, and a camera error sends you back to fighter select. A judge on a laptop with the camera blocked, or in use by a video call, can't even see a fighter in the arena. Might be by design; a "watch only" or mock-input fallback would help demos.

### E2E-08 Info: Host has no room code, Connect can't join (in progress)
Host shows `ROOM ----` and opens no websocket ("Signaling server not connected yet"); Connect with any code doesn't connect. Expected: the host side is being built (`main` has `d6f5b37`…`124c5d2`, not deployed when tested). The suite's Host/Connect tests flip to `FIXED?` once it's live.

### E2E-09 Low: no way back to the title from fighter select
After Host, step 01 has no Back; only a page reload gets you to the title (and to Connect or the tools).

### E2E-10 Low: double-clicking Host clicks through
The second click of a double click lands on the fighter-select screen that just appeared: the Load fighter card sits under the Host button, so you skip straight into the memory card (`host-dblclick.png`).
- Repro: double-click Host at 1280×800 → "Select fighter, 8 fighters" instead of "Choose your fighter".
- Fix idea: ignore clicks on the new screen for ~300 ms, or trigger the menu on `pointerup` only after a fresh `pointerdown`.

### E2E-11 Low: usernames `.` and `..` are accepted but can never come back
They pass the username regex, but `fetch('/api/profiles/..')` normalizes to `/api/` (404), so a fighter saved under them is never found. Fix: require a letter or digit.

### E2E-12 Low: missing static files return the game page with 200
`/assets/nope.js`, `/favicon.ico`, `/models/nope.glb` all return `index.html` as `200 text/html` (nginx `try_files ... /index.html`). After a redeploy, a stale tab asking for an old chunk gets HTML and fails with a MIME error instead of a clean 404. There's also no favicon.
- Fix idea: a `location /assets/ { try_files $uri =404; }` block.

### E2E-13 Low: D (pose debug) does nothing on the live site
`PoseDebugOverlay` is DEV-only, so D and `?debugPose=1` are dead on the hosted game. (The backquote effects menu does work in production.)

### E2E-14 Medium: a full or busy forge is found out after the scan (from code)
The 429s ("forges already running", "forge limit reached") come back from `POST /api/forge`, which only happens after the player has spent ~15–30 s turning in front of the camera. The player then gets "Couldn't set up your fighter: Forge rejected the scan (429)…" and starts over.
- Fix idea: a cheap `GET /api/forge/status` (or check the 429 conditions) before the scan starts.

### E2E-15 Medium: the tuner's CPU never acts
`/tuner/` fight panel with opponent "hard CPU", player standing still: after 20 s HP is still 100 / 100, the fight log is empty, and the panel reads "distance 0.92 m · you: idle · hard cpu: idle" (`tuner-fight.png`); it never walks in. Same with the person clip tracked on camera. Might just be the CPU work in progress; the test flips to `FIXED?` when the CPU attacks.

### E2E-16 Low: the scan often gets one or two angles and says nothing
With the person clip and MediaPipe at a few fps, the scan page captured only `left` (14 KB) in its 15 s window: "front — · left 14 KB · right —". The game then forges from whatever it got without telling the player it missed angles. On a slow laptop (`?pose=lite`) this will be common.

### E2E-17 Low: anyone can take over any username
Usernames are a light log-in with no secret, so anyone can type `demo` → Rescan me and replace the demo fighter used for judging. Probably fine for the event; worth protecting `demo`.

### E2E-18 Low: the error after a failed setup loses your place
After a camera or scan error you land on fighter-select step 01 and have to click Enter and retype the username.

## Performance

Measured in headless Chromium on software GL (SwiftShader) in WSL, so frame rates are a floor, not what a laptop GPU gets.
- Title: load event ~0.3–1.0 s, DOMContentLoaded under 1 s.
- Forge API: 15–100 ms per GET; `/api/fighters` ~3 KB. Fighter assets: card PNG ~1.4 MB, sheet ~1.4 MB, rigged GLB ~1.2 MB (the card shown on Welcome back is a 1.4 MB PNG; a small JPEG thumbnail would load faster on venue Wi-Fi).
- Arena with demo's fighter and the camera running: ~1–2 fps here (MediaPipe on the CPU plus three.js on SwiftShader).
- Console: no uncaught page errors on any screen. Warnings are only SwiftShader's "GPU stall due to ReadPixels". No 4xx/5xx in the network log on the normal flow (the 404s seen were the deliberate bad requests).

### E2E-19 Low: the camera picture-in-picture covers the P1 name banner
In the arena the bottom-left PiP sits on top of the fighter's name plate (`forge-live-arena.png`: "E2E-MVD3IGM9" reads "VD3IGM9").

## The one real forge (`forge-live`)

New username `e2e-mvd3igm9`, the martial-artist clip as the webcam, `?pose=lite`, under heavy machine load. It passed end to end: consent → scan → forge → rigged 3D fighter in the arena → saved under the username (`/api/profiles/e2e-mvd3igm9`). The fighter is a clear likeness (shirtless, black shorts, short dark hair; `forge-live-arena.png`), and the PiP read "Guard up" from the clip.

| Time from "Yes, scan me" | Status |
|---|---|
| 3 s | Turn slowly (camera + MediaPipe up) |
| 34 s | Forging fighter (scan done) |
| 46 s | Drawing your fighter |
| 56 s | Building your 3D model |
| 137 s | Rigging your fighter |
| 147 s | Fighter ready |
| 160 s | In the arena (rigged.glb 200) |

Server timings: brief 2.2 s, sheet 14.7 s, card 10.5 s, 3D model 85.6 s. The forge took ~113 s, well over the ~70 s target, almost all of it in the Tripo model step. The scan itself took ~30 s here (15 s window plus slow MediaPipe). Step screenshots: `forge-live-0.png` … `forge-live-5.png`.
