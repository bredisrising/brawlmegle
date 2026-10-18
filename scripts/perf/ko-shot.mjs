// K.O. visual check: a Practice fight in a browser with --remote-debugging-port, the CPU finishes P1, and
// screenshots every ~120 ms through the fall and the replay.  node ko-shot.mjs <port> <out prefix>
import { chromium } from "playwright-core";
const [port, out] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = await browser.newContext({ viewport: { width: 1100, height: 620 } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto("http://localhost:5173/?perf=1&input=mock&quality=high", { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => window.__brawl, null, { timeout: 60000 });
await page.getByRole("button", { name: /Practice/ }).click();
await page.getByRole("button", { name: /Load fighter/ }).click();
await page.locator(`[data-fighter="a6535b14-7e5d-4b33-9685-765e2df703da"]`).click();
await page.waitForFunction(() => { const s = window.__brawl.store.getState(); return s.phase === "fighting" && s.countdown === null; }, null, { timeout: 120000, polling: 250 });
await sleep(1500);
await page.evaluate(() => {
  const { game, store } = window.__brawl;
  game.fight.fighters.p1.hp = 1;
  store.setState((s) => ({ players: { ...s.players, p1: { ...s.players.p1, hp: 1 } } }));
});
const t0 = Date.now();
await page.waitForFunction(() => window.__brawl.game.fight.fighters.p1.phase === "ko", null, { timeout: 60000, polling: 16 });
console.log("ko after", Date.now() - t0, "ms");
for (let i = 0; i < 40; i++) {
  await page.screenshot({ path: `${out}-${String(i).padStart(2, "0")}.png` });
  await sleep(60);
}
await context.close();
await browser.close();
