// Visual check of the "Choose your fighter" screen and its showcase.  node choose-shot.mjs <port> <out prefix> <w> <h>
import { chromium } from "playwright-core";
const [port, out, w = "1366", h = "657"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto("http://localhost:5173/?record=0&video=0&input=mock", { waitUntil: "load", timeout: 120000 });
await page.getByRole("button", { name: /VS CPU/ }).click();
for (const [t, name] of [[1500, "a"], [3500, "b"], [3000, "c"], [6000, "d"]]) {
  await sleep(t);
  await page.screenshot({ path: `${out}-${w}x${h}-${name}.png` });
}
await ctx.close();
await browser.close();
