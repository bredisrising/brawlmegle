# Brawlegle

Working name. DubHacks '26.

Get scanned, get forged into a caricatured fighter, then fight a stranger using your own body as the controller.

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run typecheck
```

Copy `.env.example` to `.env` to configure. `?input=camera` switches this machine's input from the mock.

In dev, press `1` / `2` to fake a hit on P1 / P2 (hold Shift for a counter). That lets you test the HUD, popups and KO screen before the fight engine exists.

To try a basic 3D avatar, select **Host → Choose existing → default**. This built-in low-poly human uses a static boxing guard pose (no rig or animations yet). Its model is `public/models/default.glb`; regenerate it with `node scripts/create-default-avatar.mjs`.

## Docs

- [SPEC.md](SPEC.md): the full design.
- [architecture.md](architecture.md): the short version, plus what each folder still needs.
