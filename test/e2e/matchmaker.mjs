// The deployed matchmaker: runs matchmaker/test/smoke.js against E2E_WS (default: the live site's /ws).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { WS, assert, done, test } from "./lib.mjs";

const dir = new URL("../../matchmaker/", import.meta.url);

await test(`matchmaker smoke against ${WS}`, async () => {
  try {
    createRequire(new URL("package.json", dir)).resolve("ws");
  } catch {
    throw new Error("matchmaker deps missing: run `npm install` in matchmaker/");
  }
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["test/smoke.js"], { cwd: dir, env: { ...process.env, MATCHMAKER_URL: WS } });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, text });
    });
  });
  for (const line of out.text.trim().split("\n")) console.log(`      ${line}`);
  assert.equal(out.code, 0, "smoke test failed");
});

done("matchmaker");
