# Brawlegle: notes for agents

Read `SPEC.md` (what we're building) and `architecture.md` (how the code is laid out) first.

## Git

- Commit and push often: small commits, each one working.
- Commit messages: brief, lowercase, no body. Like `fix guard flicker`, `add tuner page`, `forge prompt tweaks`.
- No `Co-Authored-By`, no "Generated with" lines, nothing but the one-line message.
- Pull before you push (`git pull --rebase`). Teammates push to `main` all the time.
- Big experiments go on a branch (e.g. `orchestrator`), then merge.

## Running things

| What | Command | Where |
|---|---|---|
| Game | `npm run dev` | http://localhost:5173/ (`?input=camera` for the webcam, `?pose=lite` on slow laptops) |
| Intent tuner | `npm run dev` | http://localhost:5173/test/tuner/: live webcam → detected moves, live threshold sliders, record/replay clips |
| Forge server | `cd forge && npm start` | http://127.0.0.1:8787/ (dev page for likeness tests) |
| Matchmaker | deployed at `wss://54-149-60-196.sslip.io/ws` | see `matchmaker/README.md` |
| Tests | `npx vitest run` | intent accuracy on synthetic clips, recorded-clip runs |
| Video → pose clip | `node test/pose/extract.mjs --model full video.mp4` | writes `video.full.jsonl` (needs Chrome; `CHROME_PATH` to override) |

## Rules

- API keys live in the root `.env` (gitignored) and only the forge server reads them. Never put a key in browser code or a `VITE_` variable.
- The fight engine is pure TypeScript: no Three.js, no React, no randomness.
- The camera reports intent; it never decides a hit. Tracked poses go through `src/intent/` (preprocess → IntentReader); the engine decides outcomes.
- Thresholds live in `DEFAULT_INTENT` (`src/intent/intents.ts`). Tune them in the tuner, then paste the copied config back.
