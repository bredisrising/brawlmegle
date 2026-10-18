// Visual check of the forging card's live preview: a host lobby with P2 "forging", fed a real fighter's preview files.
//   node forge-preview-shot.mjs <port> <out prefix> <width> <height>
import { chromium } from "playwright-core";
const [port, out, w = "1366", h = "657"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto("http://localhost:5173/?input=mock&perf=1&walkout=0&record=0&video=0", { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => window.__brawl, null, { timeout: 60000 });
await page.getByRole("button", { name: /Host/ }).click();
await page.getByRole("button", { name: /Load fighter/ }).click();
await page.locator('[data-fighter="a6535b14-7e5d-4b33-9685-765e2df703da"]').click();
await sleep(3000);
const base = "https://54-149-60-196.sslip.io/api/forge/38cbad45-e88b-43bb-99b7-ddbbe40e4606/";
for (const [stage, forge] of [
  ["sheet", { name: "Midnight Drift", archetype: "street boxer", sheetUrl: base + "sheet.webp", sheetFinal: true }],
  ["clay", { name: "Midnight Drift", archetype: "street boxer", sheetUrl: base + "sheet.webp", sheetFinal: true, voxelsUrl: base + "preview-voxels.bin", meshUrl: base + "preview-shape.glb" }],
  ["final", { name: "Midnight Drift", archetype: "street boxer", sheetUrl: base + "sheet.webp", sheetFinal: true, voxelsUrl: base + "preview-voxels.bin", meshUrl: base + "preview-shape.glb", glbUrl: base + "rigged.glb" }],
]) {
  await page.evaluate((forge) => {
    const { store } = window.__brawl;
    store.setState((s) => ({ players: { ...s.players, p2: { ...s.players.p2, name: "phoenix", status: "forging", statusDetail: "Sculpting your fighter", forge } } }));
  }, forge);
  await sleep(stage === "final" ? 5000 : 3500);
  await page.screenshot({ path: `${out}-${w}x${h}-${stage}.png` });
}
await ctx.close();
await browser.close();
