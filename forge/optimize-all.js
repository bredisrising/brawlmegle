// One-off: optimizes every fighter already saved (new forges are optimized by the pipeline). On the server:
//
//   cd /opt/brawlegle/forge && sudo -u brawlegle node optimize-all.js /var/lib/brawlegle/forge
//
// Each fighter's GLB is replaced in place (same URL, so nothing else changes) and the original kept next to it as
// rigged.orig.glb; the card and sheet get .webp copies. Safe to rerun: fighters that already have their backup are
// skipped (--force redoes them from the originals). --dry-run lists what it would do. The forge picks the files up
// live, no restart needed.
import fs from "node:fs";
import path from "node:path";
import { optimizeFighter } from "./optimize.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const dry = args.includes("--dry-run");
const data = path.resolve(args.find((a) => !a.startsWith("--")) ?? process.env.FORGE_DATA ?? new URL("./data/", import.meta.url).pathname);
const mb = (n) => (n / 2 ** 20).toFixed(2);

let before = 0;
let after = 0;
let done = 0;
const ids = fs.readdirSync(data).filter((id) => fs.existsSync(path.join(data, id, "fighter.json")));
console.log(`${ids.length} fighters in ${data}${dry ? " (dry run)" : ""}`);
for (const id of ids) {
  const dir = path.join(data, id);
  let fighter;
  try {
    fighter = JSON.parse(fs.readFileSync(path.join(dir, "fighter.json"), "utf8"));
  } catch {
    continue;
  }
  if (fighter.status !== "ready") continue;
  const glb = fighter.glbUrl ? path.basename(fighter.glbUrl) : "-";
  if (dry) {
    console.log(`${id.slice(0, 8)} ${String(fighter.name).padEnd(16)} ${glb}${fs.existsSync(path.join(dir, glb.replace(/\.glb$/, ".orig.glb"))) ? " (done)" : ""}`);
    continue;
  }
  const report = await optimizeFighter(dir, fighter, { force, log: (m) => console.log(`  ${id.slice(0, 8)}: ${m}`) });
  const images = Object.entries(report.images).map(([n, r]) => `${n} ${mb(r.before)} -> ${mb(r.after)} MB`).join(", ");
  if (report.glb) {
    before += report.glb.before;
    after += report.glb.after;
    done++;
  }
  console.log(
    `${id.slice(0, 8)} ${String(fighter.name).padEnd(16)} ${report.glb ? `${glb} ${mb(report.glb.before)} -> ${mb(report.glb.after)} MB in ${report.glb.ms} ms` : `${glb} unchanged`}${images ? `; ${images}` : ""}`,
  );
}
if (!dry) console.log(`optimized ${done} GLBs: ${mb(before)} -> ${mb(after)} MB`);
