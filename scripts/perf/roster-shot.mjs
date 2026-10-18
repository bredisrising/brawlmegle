// Visual check of the fighter select (memory card) screen.  node roster-shot.mjs <port> <out prefix> <width> <height>
import { chromium } from "playwright-core";
const [port, out, w = "1366", h = "657"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) } });
const page = await ctx.newPage();
await page.goto("http://localhost:5173/?input=mock&perf=1&walkout=0&record=0&video=0", { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => window.__brawl, null, { timeout: 60000 });
await page.getByRole("button", { name: /Practice/ }).click();
await page.getByRole("button", { name: /Load fighter/ }).click();
await sleep(4000);
await page.screenshot({ path: `${out}-${w}x${h}.png` });
const cards = await page.evaluate(() => [...document.querySelectorAll("[data-fighter]")].map((b) => { const r = b.getBoundingClientRect(); return `${b.innerText.replace(/\n/g, " ").slice(0, 20)}@${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; }));
console.log(cards.join("\n"));
await ctx.close();
await browser.close();
