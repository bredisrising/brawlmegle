// Upload saved highlights (<name>.webm + <name>.json, as record.mjs saves them) to a forge server, through the same
// POST /api/highlights the game uses. Seeds the title screen's reel: `node scripts/highlights/upload.mjs` once the
// forge with highlights is deployed. Uploads oldest first, so the reel shows them newest first as recorded.
//   node scripts/highlights/upload.mjs [dir=scripts/highlights/seed] [--to https://54-149-60-196.sslip.io] [--key <x-forge-key>]
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv.splice(i, 2)[1];
};
const TO = flag("to", "https://54-149-60-196.sslip.io").replace(/\/+$/, "");
// The game's key (src/config.ts): not a secret, a speed bump against other sites.
const KEY = flag("key", process.env.FORGE_KEY ?? "720f66ea6f3cebda14050f8fa706cc1a");
const DIR = argv[0] ?? path.join(path.dirname(new URL(import.meta.url).pathname), "seed");

const clips = fs.readdirSync(DIR).filter((f) => f.endsWith(".webm")).sort();
if (!clips.length) throw new Error(`no .webm clips in ${DIR}`);
for (const file of clips) {
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, file.replace(/\.webm$/, ".json")), "utf8"));
  const res = await fetch(`${TO}/api/highlights`, {
    method: "POST",
    headers: { "content-type": "video/webm", "x-forge-key": KEY, "x-highlight-meta": encodeURIComponent(JSON.stringify(meta)) },
    body: fs.readFileSync(path.join(DIR, file)),
  });
  console.log(res.status, file, res.ok ? "" : await res.text());
}
