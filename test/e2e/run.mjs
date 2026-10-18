// Runs the e2e suite file by file. `npm run test:e2e` (all), or `npm run test:e2e -- api ui` (some).
// The paid forge (forge-live) only runs when named and E2E_PAID=1. See README "End-to-end tests".
import { spawnSync } from "node:child_process";

const ALL = ["api", "matchmaker", "ui", "camera", "tools"];
const picked = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const failed = [];
for (const name of picked) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [new URL(`${name}.mjs`, import.meta.url).pathname], { stdio: "inherit", env: process.env });
  if (r.status !== 0) failed.push(name);
}
console.log(`\n${failed.length ? `failed: ${failed.join(", ")}` : "e2e: all files passed (known issues aside)"}`);
process.exit(failed.length ? 1 : 0);
