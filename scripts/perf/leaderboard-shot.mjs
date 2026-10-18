// Visual check of the title screen's leaderboard.  node leaderboard-shot.mjs <port> <out prefix> <width> <height>
import { chromium } from "playwright-core";
const [port, out, w = "1366", h = "657"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) } });
const page = await ctx.newPage();
await page.goto("http://localhost:5173/?record=0&video=0", { waitUntil: "load", timeout: 120000 });
await page.getByRole("button", { name: /Leaders/ }).click();
await sleep(4000);
await page.screenshot({ path: `${out}-${w}x${h}.png` });
await page.evaluate(() => document.querySelector('[aria-label="Leaderboard"] .overflow-y-auto')?.scrollBy(0, 400));
await sleep(800);
await page.screenshot({ path: `${out}-${w}x${h}-list.png` });
await ctx.close();
await browser.close();
