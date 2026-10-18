// Screenshots of "Find a fight" and the opponent camera at a laptop size, from two browsers playing strangers.
// Run by scripts/matchmaking-shots.sh, which starts a local matchmaker, the dev server (mock forge) and two Windows
// Edges (each with its own profile and a fake camera playing a clip of a person), then this on Windows' node:
//   node matchmaking-shots.mjs --base http://localhost:5199/ --a 9351 --b 9352 --out <dir> [--width 1366 --height 657]
import fs from "node:fs";
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const base = arg("base");
const out = arg("out");
fs.mkdirSync(out, { recursive: true });
const size = { width: Number(arg("width", 1366)), height: Number(arg("height", 657)) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ba = await chromium.connectOverCDP(`http://127.0.0.1:${arg("a")}`);
const bb = await chromium.connectOverCDP(`http://127.0.0.1:${arg("b")}`);
const page = async (browser, name) => {
  const p = await (await browser.newContext({ viewport: size })).newPage();
  p.on("pageerror", (e) => console.log(`[${name}] ${e.message}`));
  await p.goto(`${base}?input=camera&pose=lite&walkout=0&perf=1&voices=0`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await p.waitForFunction(() => window.__brawl, null, { timeout: 90_000 });
  // The perf overlay is for scripts, not the pictures.
  await p.evaluate(() => (window.__brawl.perf.overlay.style.display = "none"));
  return p;
};
const shot = async (p, name) => {
  await p.screenshot({ path: `${out}/${name}.png`, timeout: 90_000 });
  console.log(`shot ${name}`);
};
const store = (p, fn) => p.waitForFunction(new Function(`return (${fn})(window.__brawl.store.getState())`), null, { timeout: 120_000, polling: 200 });
const pick = async (p) => {
  await p.getByRole("button", { name: /Load fighter/ }).click();
  await p.locator("[data-fighter]").first().click();
};

try {
  const a = await page(ba, "a");
  const b = await page(bb, "b");
  await sleep(1500);
  await shot(a, "01-title");
  await a.getByRole("button", { name: /Play a friend/ }).click();
  await sleep(600);
  await shot(a, "02-title-play-a-friend");
  await a.getByRole("button", { name: /Join with a code/ }).click();
  await sleep(500);
  await shot(a, "03-title-join");
  if (argv.includes("--title-only")) throw Object.assign(new Error("title only"), { done: true });
  await a.reload({ waitUntil: "domcontentloaded" });
  await a.waitForFunction(() => window.__brawl);
  await a.evaluate(() => (window.__brawl.perf.overlay.style.display = "none"));

  // Find a fight: A picks a fighter and waits.
  await a.getByRole("button", { name: /Find a fight/ }).click();
  await sleep(800);
  await shot(a, "04-find-a-fight-pick");
  await pick(a);
  await store(a, (s) => s.searching && s.players.p1.status === "ready");
  await sleep(1500);
  await shot(a, "05-searching");

  // B finds A: matched, straight into the fight.
  await b.getByRole("button", { name: /Find a fight/ }).click();
  await pick(b);
  await store(b, (s) => s.role === "client" && s.connection === "open");
  await store(a, (s) => s.connection === "open");
  await store(a, (s) => s.opponentVideo !== null);
  await shot(a, "06-matched-host");
  await store(a, (s) => s.phase === "fighting" && s.countdown === null);
  await sleep(2500);
  await shot(a, "07-fight-host");
  await shot(b, "07-fight-client");

  // A K.O. (the dev keys: Shift+2 is a 15-damage hit on P2), its replay, then the K.O. screen with votes.
  for (let i = 0; i < 8 && (await a.evaluate(() => window.__brawl.store.getState().phase)) === "fighting"; i++) {
    await a.keyboard.down("Shift");
    await a.keyboard.press("Digit2");
    await a.keyboard.up("Shift");
    await sleep(500);
  }
  await store(a, (s) => s.phase === "ko");
  await store(a, (s) => s.nextAt !== null);
  await sleep(300);
  await shot(a, "08-ko-countdown-host");
  await store(b, (s) => s.nextAt !== null);
  await b.getByRole("button", { name: /^Rematch/ }).click();
  await store(a, (s) => s.votes.p2);
  await sleep(250);
  await shot(a, "09-ko-opponent-wants-rematch");
  await shot(b, "09-ko-waiting-for-opponent");
  // Nobody else voted: both go find someone new, and (alone) get paired again.
  await store(a, (s) => s.phase !== "ko");
  await sleep(400);
  await shot(a, "10-after-countdown-searching");
  await store(a, (s) => s.connection === "open" && s.phase === "fighting" && s.countdown === null);
  await store(a, (s) => s.opponentVideo !== null);
  await sleep(2500);
  await shot(a, "11-repaired");
  await shot(b, "11-repaired-other");
  // Hide my camera, from the Esc menu mid-fight: both sides say so.
  await a.keyboard.press("Escape");
  await a.getByRole("button", { name: /My camera/ }).click();
  await sleep(300);
  await shot(a, "12-esc-menu-open");
  await a.keyboard.press("Escape");
  await store(b, (s) => s.opponentCamHidden);
  await sleep(400);
  await shot(a, "12-you-hid-your-camera");
  await shot(b, "12-opponent-hid-their-camera");

  // Room code: create a room, the code to send.
  const c = await page(ba, "c");
  await c.getByRole("button", { name: /Play a friend/ }).click();
  await c.getByRole("button", { name: /Create a room/ }).click();
  await pick(c);
  await store(c, (s) => s.roomCode && s.players.p1.status === "ready");
  await sleep(1500);
  await shot(c, "13-create-a-room");
} catch (err) {
  if (!err.done) {
    console.log("failed:", err.message.split("\n")[0]);
    process.exitCode = 1;
  }
} finally {
  await ba.close().catch(() => {});
  await bb.close().catch(() => {});
}
