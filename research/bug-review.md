# Bug review (2026-10-17)

Rigorous pass over the forge server, the matchmaker and its deploy config, intent, the fight engine and the
host-side game/forge/UI code, ordered by what would hurt a live demo most (a judge walks up, types a username,
gets scanned and fights). Branch `bug-review`. Fixed items have a regression test where one was practical; the
ones without say "no test".

How things were confirmed:
- **Forge server:** `test/server/forge.test.ts` runs the real `forge/server.js` with OpenAI and Tripo mocked
  (`test/server/mock-fetch.mjs`), so it never spends credits. Run with `npx vitest run test/server`. The tests
  landed in `a2f2fc2`, right after the fixes; each one failed on the old server (except the aborted-upload one, which
  guards the new slot counter).
- **Matchmaker:** `cd matchmaker && npm test` (the smoke test now also covers sample uploads and room reclaim).
- **Live server:** read-only checks only (no forge was triggered). The `/samples` crash was reproduced locally,
  never against the live box.

Line numbers point at the code before the fix (`main` at `09d549e`); for unfixed items they're current `main`.

Severity: **critical** = one anonymous request breaks the demo for everyone; **high** = likely to break or leak
during the demo; **medium** = real bug with a narrower trigger; **low** = edge case or hardening.

## Summary

| # | Sev | Where | What | Status |
|---|---|---|---|---|
| M1 | critical | `matchmaker/server.js:63` | `POST /samples` with body `null` crashes the matchmaker, dropping every room | fixed `c039645` |
| F1 | high | `forge/server.js:36` | Raw webcam photos of everyone scanned are downloadable by anyone | fixed `5da3bb8` |
| F2 | high | `forge/server.js:161-169` | Parallel requests bypass the active/hourly/daily forge caps | fixed `7b62f6f` |
| F3 | high | `forge/pipeline.js:172-189` | A failed card art fails the whole fighter (and wastes the 3D model) | fixed `b269c27` |
| M2 | high | `matchmaker/server.js` `host()` | Host socket drop = new room code; the client can never rejoin | server fixed `02e3c33`, client still to do |
| G1 | high | `src/director/FighterView.ts:149-150` | `normalize()` before `length()`: default fighter's limbs scaled 4-8x | not fixed (FighterView is being reworked) |
| G2 | high | `src/game/Game.ts:147` | A GLB that won't load bounces the player off a finished fighter | fixed `65d48e8` |
| F7 | medium | `forge/server.js` caps | Public key + global caps: one script can lock judges out for an hour | not fixed (suggestion) |
| M4 | medium | `matchmaker/server.js:25` | 2000 idle sockets lock everyone out; no per-IP limits possible behind the stream proxy | not fixed (suggestion) |
| D1 | medium | `matchmaker/deploy/setup.sh` nginx | Stale cached `index.html` after a redeploy gives a blank page | fixed `8d53b0a` (re-run setup.sh) |
| G3 | medium | `src/forge/forge.ts:62,76,109` | No request timeouts: a stalled request hangs "Forging fighter" forever | fixed `5843b2d` |
| G4 | medium | `src/ui/screens/AvatarScreen.tsx:163` | Enter during the username lookup starts a paid forge for a returning player | fixed `6a33d98` |
| G5 | medium | `src/input/sources/CameraSource.ts:145` | One throw in a frame stops camera tracking for good | fixed `df06e17` |
| I1 | medium | `src/intent/IntentReader.ts:156` | A player who left the frame flickers back to "tracked" with a frozen pose | fixed `df569d2` |
| I2 | medium | `src/intent/IntentReader.ts:535` | Lost players drop their guard (SPEC: hold guard) | fixed `df569d2` |
| I3 | medium | `src/intent/preprocess.ts:151` | A null/NaN landmark crashes the tick or kills intent | fixed `635b843` |
| I4 | medium | `src/intent/IntentReader.ts:173` | Phantom strikes after a gap in frames | fixed `df569d2` |
| I5 | medium | `src/intent/IntentReader.ts:147` | No ducks/jumps/dodges for minutes after a peer reloads | fixed `df569d2` |
| - | medium | `src/game/Game.ts:266` | Hit-stop applied twice (renderer freeze + engine hitstop) | not fixed |
| - | medium | `src/game/constants.ts:8` | No 60 s round timer: fights only end on K.O. | not fixed |
| - | medium | `src/game/Game.ts:79-83` | A failed `peer.host()` leaks the signaling socket on retry | not fixed (networking) |
| F4 | medium | `forge/pipeline.js:40` | One dropped Tripo poll throws away a paid model | fixed `b269c27` |
| F5 | low | `forge/pipeline.js:127` | Vision refusal becomes "Cannot read properties of null" | fixed `b269c27` |
| F6 | low | `forge/server.js` | `null` body → 500, bad `%` → 500, unhandled stream/save errors can crash | fixed `32a8b10`, `7b62f6f` |
| F8 | low | `forge/server.js` profiles | Anyone can forge under any username | by design, noted |
| F9 | low | `forge/server.js:35` | 25 MB bodies vs `MemoryMax=400M` | not fixed (suggestion) |
| M3 | low | `matchmaker/server.js:64` | Sample storage cap overshot by parallel uploads | fixed `c039645` |
| G6 | low | `src/game/Game.ts:174` | `dispose()` left camera + forge polling running (HMR) | fixed `deaba25` |
| I6-I9 | low | intent / hub / engine | Lost-hand re-pickup, hub clock restart, P1 wins trades, NaN in attacks | fixed `635b843`, `5575bf5`, `7675955` |
| - | low | various | Smaller items listed under each section | not fixed |

## Forge server (`forge/`)

### F1. Raw scan photos of every judge are public (high, privacy)
`forge/server.js:36` (before the fix): `FILES` allowed `front|left|right.(jpg|png)`, and `/api/fighters`
lists every fighter id. So anyone could do `GET /api/fighters` → `GET /api/forge/<id>/front.jpg` and download
the raw webcam photos of everyone scanned. Confirmed on the live server: `front.jpg` of a listed fighter came back
`200 image/jpeg` (45 KB, discarded unread). SPEC "Consent": don't store raw photos past the forge. No client
reads these files.
**Fixed** in `5da3bb8`: only `sheet.png`, `card.png`, `model.glb`, `rigged.glb` are served. The photos stay on
disk for re-forging; delete `/var/lib/brawlegle/forge/*/{front,left,right}.*` after the event as the consent
text promises. Test: "never serves the raw scan photos".

### F2. Parallel requests blow straight through every cap (high, cost/abuse)
`forge/server.js:161-169` (before): the active/hourly/daily checks ran, then `await readJson(req)` (the upload),
and only then was the fighter added to the map the checks count. Every request that arrives while others are
still uploading sees the old count. Repro: `FORGE_MAX_ACTIVE=1`, four parallel uploads → four `202`s and four
paid forges. The access key ships in the page (`src/config.ts:23`), so the caps are the only real limit on spend.
**Fixed** in `7b62f6f`: an `uploading` counter holds the slot during the upload and counts against all three caps
(and `scanning` now counts as active too). Test: "parallel requests cannot get past the active-forge cap", plus
"an upload cut off halfway gives its slot back".

### F3. A failed card fails the whole fighter (high)
`forge/pipeline.js:172-189` (before): `Promise.all([cardJob, modelJob])` rejected when only the card failed
(moderation refusal on "holding {prop}", a timeout, a 5xx), so the fighter went `failed` even though the sheet and
the paid Tripo model were fine, and the judge got the fallback fighter. The Tripo job also kept running in the
background for nothing. SPEC wants the card off the critical path.
**Fixed** in `b269c27`: card errors are caught into `cardError`; the fighter goes `ready` without `cardUrl` (every
client already handles a missing card). Test: "a failed card keeps the fighter (and its 3D model)".

### F4. One dropped Tripo status poll throws away the 3D model (medium)
`forge/pipeline.js:40-50` (before): `tripoWait` polled every 2 s for up to 5 minutes, and any single failed poll
(network blip, Tripo 5xx, 60 s timeout) aborted the model or rig step. The model is already paid for by then.
**Fixed** in `b269c27`: up to 3 consecutive poll failures are retried. Not covered by a test.

### F5. Vision refusal turns into a confusing crash (low)
`forge/pipeline.js:127` (before): a refusal comes back as `content: null`; `JSON.parse(null)` returns `null`, and
the next line died with "Cannot read properties of null (reading 'name')". A brief `name` that isn't a string was
also copied straight into `fighter.name`.
**Fixed** in `b269c27`: a clear `brief: <refusal>` error, and the brief name is only used if it's a string (cut to 40). No test.

### F6. Bad request bodies are 500s with internal messages; stream and save errors are unhandled (low)
- `POST /api/forge` with the JSON body `null` → `500 {"error":"Cannot read properties of null (reading 'frames')"}`
  (confirmed live, no forge started). Now `400`.
- `GET /api/profiles/%E0%A4%A` threw `URIError` inside the handler (500 locally; nginx happens to reject it first
  on the live box). Now `400`.
- `fs.createReadStream(file).pipe(res)` had no error handler on the read stream: a read error would be an uncaught
  `error` event and crash the server, and a download cut off mid-way left the file descriptor open. Now `pipeline()`.
- `runForge(...).then(...)` had no `.catch`, and the final `store.save()` sat outside the try: one `ENOSPC` while
  saving would be an unhandled rejection, which kills Node 22 (and every forge in flight with it). Both guarded.

**Fixed** in `32a8b10` (and the `null` body in `7b62f6f`). Test: "answers a JSON null body with 400, not 500".

### F7. Anyone with the public key can spend the whole hourly cap (medium, not fixed)
The caps are global (40/hour, 200/day) and the key is in the bundle, so one script can burn 40 forges in a minute
and lock judges out for the next hour (`429 forge limit reached`). Per-IP limits don't work as deployed: nginx's
`stream` block on 443 proxies TCP to `127.0.0.1:8443`, so the http server and the forge see every client as
`127.0.0.1`, and the booth laptops share one venue IP anyway.
**Suggested fix:** for the event, rotate `FORGE_ACCESS_KEY` to a value that isn't in the bundle and type it once
into the booth laptops (store it in `localStorage`, send it as `x-forge-key`), keeping the public key for a small
separate cap. If per-IP limits are wanted later: `proxy_protocol on` in the stream block, `listen ... proxy_protocol`
plus `real_ip_header proxy_protocol` in the https block (coturn would need its own port then).

### F8. Usernames are claimable by anyone (low, by design)
`/api/fighters` lists every `username`, and a forge sent with someone else's username becomes their "latest ready
fighter" on `/api/profiles/:username`. Fine for a hackathon "light login"; worth knowing if a judge's fighter
suddenly changes.

### F9. Memory headroom with big uploads (low, not fixed)
`MAX_BODY_BYTES` is 25 MB and the forge runs under `MemoryMax=400M`. One max-size forge holds roughly 6 copies of
the photos (raw chunks, string, parsed JSON, decoded buffers, base64 for the brief, form blobs), so three at once
can get OOM-killed, and systemd's restart marks every forge in flight `failed`. Real scans are ~50-100 KB per frame,
so this only matters for abuse or the dev page with phone photos. With F2 fixed, at most `FORGE_MAX_ACTIVE`
uploads are in memory at once. **Suggested fix:** cap the body at ~8 MB (and nginx `/api/` at 10m).

## Matchmaker (`matchmaker/`)

### M1. One anonymous request crashes the matchmaker (critical)
`matchmaker/server.js:63` (before): `POST /samples` with the body `null` parsed the header as `null`, then
`header.labels` threw inside the request's `end` handler: an uncaught exception that exits the process. `/samples`
is public through nginx, so `curl -X POST https://54-149-60-196.sslip.io/samples -d null` kills signaling for
everyone. systemd restarts it in 2 s, but every hosted room is gone, so a client that drops mid-fight can never
rejoin (its code no longer exists). Reproduced locally (not against the live server).
**Fixed** in `c039645`. Test: smoke "sample uploads".

### M2. A host that drops its socket loses its room code for good (high)
The room lives only as long as the host's WebSocket (`stopHosting` on close). A Wi-Fi blip on the host laptop, nginx
timing out the socket, or a matchmaker restart (see M1) gives the host a brand-new code on reconnect, while the
client keeps retrying the old one forever ("No room with code ...", `ClientSession.reconnect` backs off to 8 s and
never gives up). SPEC "Disconnects" promises a rejoin with the same room code.
**Fixed server-side** in `02e3c33`: `room` now carries a `token` (HMAC of the code with `TURN_SECRET`, so it
survives restarts), and `{type: "host", code, token}` gets the same code back, even taking it over from a stale
socket that hasn't timed out yet. Documented in `matchmaker/README.md`. **Still needed client-side** (`src/net`
wasn't touched): the `Peer.host()` that just landed on `main` reopens with a plain `{type: 'host'}` and shows a new
code, so the client still can't rejoin. See "Notes for the networking work" below for the 3-line change. Test:
smoke "host reclaims its code".

### M3. Sample storage cap can be overshot by parallel uploads (low)
`matchmaker/server.js:64-68` (before): `samplesBytes` only grew after `writeFile` finished, so N parallel 12 MB
uploads all passed the 2 GB check. **Fixed** in `c039645` (space is reserved before the write, released on error;
no test).

### M4. 2000 sockets lock everyone out (medium, not fixed)
`MAX_CLIENTS = 2000` is global and there's no per-IP limit (and, as in F7, every client looks like `127.0.0.1`
behind the stream proxy). A script opening 2000 idle WebSockets makes `verifyClient` reject the booth laptops. Room
codes (32^4 ≈ 1M) can also be brute-forced from many sockets to hijack a waiting room before the real client joins.
**Suggested fix:** PROXY protocol from the stream block (see F7), then `limit_conn` per IP on `/ws` (~20), and a
per-IP cap on failed `join` attempts.

## Deploy (`matchmaker/deploy/setup.sh`)

### D1. A redeploy during the event can blank the page on laptops that already loaded it (medium)
The game's `index.html` had no `Cache-Control`, only `Last-Modified`/`ETag` (confirmed live), so browsers cache it
heuristically (10% of its age). After a redeploy that removes old hashed bundles, a cached `index.html` asks for
`/assets/index-<old>.js`, and `try_files ... /index.html` answers that with `200 text/html` (confirmed live for a
missing asset), which the browser refuses to run as a module: blank screen.
**Fixed** in `8d53b0a`: `index.html` (and everything outside `/assets/`) is `no-cache` (revalidated, so 304s), and
`/assets/` is immutable with a real 404 for missing files. Checked with `nginx -t` on the generated config. Needs
`sudo DOMAIN=... TURN_DOMAIN=... deploy/setup.sh` re-run on the box to take effect.

## Game, forge client, screens, camera, director (`src/game`, `src/forge`, `src/ui`, `src/input/sources`, `src/director`)

### G1. Default fighter's limbs stretch 4-8x with live pose (high, not fixed: FighterView is being reworked)
`src/director/FighterView.ts:149-150` (current `main`):
```ts
part.quaternion.setFromUnitVectors(UP, direction.normalize());
part.scale.set(1, direction.length() / restLength, 1);
```
`normalize()` changes `direction` in place, so `direction.length()` is always 1 and every limb's y-scale is
`1 / restLength` instead of `length / restLength`. Checked in node: even in the guard pose the upper arm comes out
7.69x instead of 1.0x. **Fix:** read the length first:
`const len = direction.length(); part.quaternion.setFromUnitVectors(UP, direction.normalize()); part.scale.set(1, len / restLength, 1);`

### G2. A model that fails to load throws the player off a finished fighter (high)
`src/game/Game.ts:147` (before): `setFighter` throws when the GLB won't load (404, network, a corrupt or huge
file, a saved fighter whose server is gone). `setupPlayer`'s catch then stopped the camera and sent the player back
to the avatar screen with an error, after a 3-minute forge that worked.
**Fixed** in `65d48e8`: `loadFighter()` retries with `glbUrl: undefined`, so they fight as the default model (SPEC
fallback ladder). Found by reading; needs WebGL, so no test.

### G3. Forge client requests had no timeouts (medium)
`src/forge/forge.ts:62,76,109` (before): the profile lookup, the submit and each status poll had no timeout. On
venue Wi-Fi a stalled request never settles, so the 5-minute fallback never fires (the loop is stuck in an
`await`) and the player sits on "Forging fighter" forever. Separately, 5 failed polls in ~7.5 s failed a forge that
was still running fine on the server.
**Fixed** in `5843b2d`: 10 s per poll (also cancelled by the caller's signal), backoff between failed polls up to
15 s, a 45 s submit timeout with a clear "Couldn't reach the forge" error, 4 s for the profile lookup. Same commit:
`readSaved()` (`src/forge/roster.ts:25`) drops junk from localStorage (a stored `null` made the memory card hang
on "Loading fighters…"), and all-dot usernames are rejected (`/api/profiles/..` collapses to `/api/`, so that
fighter could never be found again; the server mirrors it in `69bfbe9`). Test: `test/forge/forgeRobustness.test.ts`.

### G4. Enter during the username lookup starts a paid forge for a returning player (medium)
`src/ui/screens/AvatarScreen.tsx:163,219` (before): during the 300 ms debounce plus the lookup, `found` is
`undefined`, so Enter (or "Yes, scan me") started a brand-new scan and forge for someone who already has a fighter.
**Fixed** in `6a33d98`: submit is blocked and the button disabled while checking (bounded by G3's 4 s timeout; a
failed lookup counts as "no fighter"). Found by reading; no test (React).

### G5. One throw stops camera tracking for good (medium)
`src/input/sources/CameraSource.ts:145-177` (before): if `detectForVideo` or any frame listener threw, `schedule()`
was never reached, and tracking stopped silently. The likely trigger is the client's pose `send` throwing during a
P2P drop, which would freeze P2 even after the reconnect.
**Fixed** in `df06e17`: detection and each listener are guarded, the loop always reschedules, errors are logged at
most every 5 s. Test: `test/input/cameraSource.test.ts`.

### G6. Disposing the game left the camera and forge polling running (low, dev/HMR)
`src/game/Game.ts:174` (before): `dispose()` unassigned the sources without stopping them (camera + MediaPipe kept
running), and in-flight scans and polls kept writing to the store. **Fixed** in `deaba25` (a `lifetime`
AbortController feeds `captureScan`/`forgeFighter`; `dispose` aborts it and stops the sources; no test).

### Not fixed (game / UI)
- **Medium**, `src/game/Game.ts:79-83` (host networking, someone else's area): if `peer.host()` throws,
  `this.peer` stays set and is never closed, so each retry leaks a signaling socket.
- **Low**, `CameraSource.start()` (`:62`): no guard against a second concurrent `start()` or a `stop()` while it's
  still starting; either leaks a camera stream. No current caller does this.
- **Low**, camera track has no `ended` handler: unplugging the camera (or another app grabbing it) leaves
  `tracking` stuck at its last value with no message.
- **Low**, `src/game/ClientSession.ts:70,82`: sends a scan even when every frame is empty, and shows a generic
  "Something went wrong" instead of the reason (the host side already shows the real one).
- **Low**, the profile's `forging` id is ignored: a returning player whose forge is still running gets offered a
  new paid scan instead of waiting for that one.
- **Low**, `Game.ts:264` debug keys change the store's HP but not the engine's.
- **Low**, `CameraPip.tsx:61`: the "tracking" label only refreshes when something else re-renders.
- **Low**, local dev: the default mock input plus the live forge means "Scan new" always fails with "nobody was in
  view" (use `?input=camera`).
- **Low**, `disposeObject` doesn't free skeleton bone textures or ImageBitmaps, and `Renderer.dispose` doesn't
  force WebGL context loss (matters on HMR only).

## Intent, input hub, fight engine (`src/intent`, `src/input`, `src/fight`)

Confirmed with new tests: `test/intent/edge.test.ts`, `test/intent/inputHub.test.ts`, `test/fight/rules.test.ts`.
Synthetic eval recall is unchanged or slightly better (89/87/63% before, 89/87/65% after; bad lighting improved).

### I1. A player who walks out of frame keeps flickering back to "tracked" with a frozen pose (medium)
`src/intent/IntentReader.ts:156-168` (before): `InputHub.latest()` keeps handing over the last frame forever.
After the 300 ms stale reset the preprocessor's state is cleared, so it accepts that same old frame as new: tracked
for 300 ms, untracked for one tick, tracked again. Walking out of frame read as tracked 113 of 120 ticks, guard
down, and the "step back in" path never really fired.
**Fixed** in `df569d2`: the frame that was current at the loss is remembered (`lostFrameT`) and ignored afterwards.

### I2. Lost players drop their guard (medium)
`src/intent/IntentReader.ts:535` (before): `untracked()` returned `guard: false`. SPEC "Tracking loss" says the
fighter holds guard (and Game's own no-frame stance already used `guard: true`), so a P2 whose client dropped
mid-fight stood there open. **Fixed** in `df569d2`.

### I3. One bad frame crashes the game loop or kills a player's intent until a long gap (medium)
`src/intent/preprocess.ts:151,292` (before): a `null` landmark (from a peer) threw a TypeError inside `Game.tick`,
and a NaN landmark or NaN `t` got into the One Euro filters and never left. **Fixed** in `635b843`: a new exported
`usableFrame()` (33 finite image + world points, finite `t`) drops bad frames; a bad `aspect` falls back to 4/3.

### I4. Phantom strikes after a gap in frames (medium)
`src/intent/IntentReader.ts:173` (before): when the camera clock jumps more than 300 ms but the host clock doesn't
trip the stale check (main thread blocked by a GLB load, a suspended tab), the preprocessor restarts but limb state
from before the gap stays, so a wind-up cut off by the gap fires as a strike. 124 phantom strikes over synthetic
punches before, 0 after. **Fixed** in `df569d2` (limb and core state reset when the preprocessor restarts).

### I5. No ducks, jumps or dodges for minutes after a peer reloads (medium)
`src/intent/IntentReader.ts:147` (before): the `lastCore` cooldowns live on the peer's frame clock and were never
reset; a reloaded client's clock restarts near 0, so `t - lastCore` stays negative for as long as the old session
ran. **Fixed** in `df569d2`.

### I6. A hand that reappears far from where it was lost is ignored indefinitely (low)
`src/intent/preprocess.ts:179` (before): the glitch check divided the jump by one frame's `dt`, so a hand blurred
out mid-swing and seen again more than ~1.33 torso lengths away was rejected every frame. **Fixed** in `635b843`
(the jump is judged over the time since the point was last seen; one-frame glitches are still rejected).

### I7. Input hub drops a source's frames forever after its clock restarts, and loses early subscribers (low)
`src/input/InputHub.ts:5,19,30` (before): frames older than the newest were dropped, so a source that kept feeding
after its clock restarted was ignored for good; and `subscribe()` before `assign()` (or across a reassign) silently
lost its callbacks. **Fixed** in `5575bf5` (a frame more than 5 s "older" is a clock reset; subscribers follow the
player, not the source).

### I8. P1 always wins a same-tick trade (low)
`src/fight/FightEngine.ts:50,161` (before): P1's swing resolved first, put P2 in hitstun and cancelled P2's punch.
**Fixed** in `7675955`: both swings resolve against a snapshot taken before either lands; hit-stop is the larger of
the two and each event reports its own. Remaining edge: if both hits would be lethal, P1 still wins (a fighter
K.O.'d that tick doesn't land), which matches Game's single-winner handling.

### I9. NaN speed/windup/lunge corrupts the fight (low)
`src/fight/FightEngine.ts:98-106` (before): NaN made HP NaN (never K.O.) and position NaN (always in range). Each now
falls back to a safe default. **Fixed** in `7675955`.

### Not fixed (intent / fight / game loop)
- **Medium, hit-stop is applied twice.** `src/game/Game.ts:266` calls `renderer.freeze(hitstopFrames)`, which stops
  sim ticks, and when ticks resume the engine freezes itself for its own `hitstop` frames: 2x SPEC, up to 28 frames
  (~467 ms) per big hit. The visible freeze is the renderer's (views don't update while it's frozen), so the fix is
  to keep one: drop the engine's hitstop when the host freezes the renderer, or stop freezing the renderer for
  engine hits and have FighterView hold the pose while `fight.state` is in hit-stop.
- **Medium, there is no 60 s round timer.** `ROUND_SECONDS` (`src/game/constants.ts:8`) is never used and nothing
  emits `timeout`, so a fight only ends on a K.O.: two careful blockers can stall a judge's slot. Count down in
  `Game.tick` during `fighting`, higher HP wins, and show it in the HUD.
- **Low**, `InputHub.latest()` returns a lost player's last frame forever (`src/input/InputHub.ts:32`), so the
  live-pose layer freezes on it. Game/FighterView should check `stance.tracked`.
- **Low**, `RemoteSource` emits peer frames unchecked; FighterView and CameraPip read raw frames, so run
  `usableFrame()` on them in `RemoteSource` too.
- **Low**, `src/fight/Cpu.ts:257`: the block timing subtracts the attacker's frame within the active phase from the
  startup count (only makes the guard last longer) and ignores the gassed startup.
- **Low**, `src/intent/StyleMatcher.ts:27,41`: templates with different feature lengths give a NaN distance and an
  arbitrary vote (`styleModel.json` is empty today, so nothing hits this yet).

## Notes for the networking work (`src/net`, just landed on `main`)

- `Peer.reopenRoom()` asks for a fresh room after a signaling drop, so the host shows a **new** code while the
  client keeps retrying the old one. With `02e3c33` the matchmaker can hand the same code back: keep `token` from
  the `room` message and send `{type: 'host', code: this.roomCode, token}` in place of `{type: 'host'}` at
  `src/net/Peer.ts:168` when reopening. The token is an HMAC with `TURN_SECRET`, so it also survives a
  matchmaker restart.
- Don't send `host` twice on a live socket: the server's `host()` starts with `reset()`, which kicks the paired
  client with `peer-left`.
