// Two laptops, peer to peer: two Edges (scripts/trailer/edge.sh start <port> <camera.y4m>), each with a recorded
// person as its webcam. One creates a room, the other joins with the code, both pick fighters, and they fight through
// the real matchmaker and WebRTC. Both screens are recorded (CDP screencast, as capture.mjs).
//   node p2p.mjs --out C:\...\p2p [--host-port 9555] [--client-port 9556] [--p1 id] [--p2 id] [--seconds 30]
// Nothing is posted: ?record=0&video=0, and highlights, match results and samples are caught here on both pages.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { warpClock } from "./warp.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const BASE = arg("url", "http://localhost:4291/");
const OUT = arg("out", "p2p");
const P1 = arg("p1", "f879fdf0-4063-4a05-9ac2-0ccec79988b3");
const P2 = arg("p2", "454c8159-aeb4-442e-8b15-21ce29c936aa");
const SECONDS = Number(arg("seconds", 30));
const QUALITY = Number(arg("jpeg", 88));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** --warp k: both pages run at k (cameras must be slowed to match: make-cam.sh slow=1/k). */
const WARP = Number(arg("warp", 1));
/** Real ms for s seconds of game time. */
const real = (s) => (s * 1000) / WARP;

async function pick(all, ids) {
  const out = [];
  for (const id of ids) {
    const f = all.find((x) => x.id === id) ?? (await (await fetch(`https://54-149-60-196.sslip.io/api/forge/${id}`)).json().catch(() => null));
    if (f?.status === "ready") out.push(f);
  }
  return out;
}

class Recorder {
  constructor(page, dir) {
    this.page = page;
    this.dir = dir;
    this.n = 0;
    this.lines = [];
    this.marks = [];
    fs.mkdirSync(dir, { recursive: true });
  }
  async start() {
    this.t0 = Date.now();
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", (f) => {
      this.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      const i = this.n++;
      fs.writeFile(path.join(this.dir, `f${String(i).padStart(6, "0")}.jpg`), Buffer.from(f.data, "base64"), () => {});
      this.lines.push(`${i} ${f.metadata.timestamp}`);
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: QUALITY, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  }
  mark(label) {
    this.marks.push(`${label} ${Date.now() / 1000}`);
  }
  async stop() {
    const warp = await this.page.evaluate(() => window.__warp ?? null).catch(() => null);
    const hits = await this.page.evaluate(() => window.__hits ?? []).catch(() => []);
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await sleep(800);
    fs.writeFileSync(path.join(this.dir, "frames.txt"), this.lines.join("\n") + "\n");
    fs.writeFileSync(path.join(this.dir, "marks.txt"), this.marks.join("\n") + "\n");
    fs.writeFileSync(path.join(this.dir, "hits.json"), JSON.stringify(hits));
    fs.writeFileSync(path.join(this.dir, "warp.json"), JSON.stringify({ K: WARP, W0: warp ? warp.W0 / 1000 : null, R0: warp ? warp.R0 : null }));
    const s = (Date.now() - this.t0) / 1000;
    console.log(`${this.dir}: ${this.n} frames in ${s.toFixed(1)} s = ${(this.n / s).toFixed(1)} fps`);
  }
}

async function open(port, label) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await context.addInitScript(warpClock, WARP);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(label, "pageerror", e.message));
  page.on("console", (m) => m.type() === "error" && !/WebGL|X4122/.test(m.text()) && console.log(label, "console", m.text().slice(0, 200)));
  const block = (what) => async (route) => {
    if (route.request().method() === "GET") return route.fallback();
    console.log(label, "blocked", what);
    await route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
  };
  await page.route("**/api/highlights", block("highlight upload"));
  await page.route("**/api/matches", block("match result"));
  await page.route("**/samples**", block("sample upload"));
  await page.route("**/api/fighters", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: await pick(await res.json(), [P1, P2]) });
  });
  await page.goto(`${BASE}?perf=1&input=camera&record=0&video=0&quality=high&demo=1`, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => window.__brawl, null, { timeout: 60000 });
  if (WARP !== 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Animation.enable");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: WARP });
    const uncap = () => page.evaluate((fps) => { const r = window.__brawl?.game?.renderer; if (r) r.maxFps = fps; }, 60 / WARP).catch(() => {});
    await uncap();
    setInterval(uncap, 2000);
  }
  await page.evaluate(() => {
    const o = window.__brawl.perf?.overlay;
    if (o) o.style.display = "none";
    const g = window.__brawl.game;
    const show = g.showHit.bind(g);
    window.__hits = [];
    g.showHit = (e, by, ko, replaying) => {
      if (!replaying) window.__hits.push({ t: performance.now(), wall: Date.now(), type: e.type, attacker: e.attacker, move: e.move, damage: e.damage ?? null, ko: !!ko });
      return show(e, by, ko, replaying);
    };
    g.highlight.start = () => {};
  });
  return { browser, context, page };
}

const host = await open(Number(arg("host-port", 9555)), "host");
const client = await open(Number(arg("client-port", 9556)), "client");
const recH = new Recorder(host.page, path.join(OUT, "host"));
const recC = new Recorder(client.page, path.join(OUT, "client"));
await recH.start();
await recC.start();
const mark = (l) => {
  recH.mark(l);
  recC.mark(l);
  console.log("mark", l);
};
mark("title");
await sleep(real(1.5));
await host.page.getByRole("button", { name: /^02 Play a friend/ }).click();
await sleep(real(0.7));
await host.page.getByRole("button", { name: /Create a room/ }).click();
await host.page.waitForFunction(() => window.__brawl.store.getState().roomCode, null, { timeout: real(30) });
const code = await host.page.evaluate(() => window.__brawl.store.getState().roomCode);
console.log("room", code);
mark("room");
await client.page.getByRole("button", { name: /^02 Play a friend/ }).click();
await sleep(real(0.6));
await client.page.getByRole("button", { name: /Join with a code/ }).click();
await sleep(real(0.5));
await client.page.locator("#room-code").pressSequentially(code, { delay: real(0.16) });
await sleep(real(0.4));
await client.page.keyboard.press("Enter");
mark("join");
await sleep(real(2.5));
for (const [side, id] of [[host, P1], [client, P2]]) {
  await side.page.getByRole("button", { name: /Load fighter/ }).click();
  await sleep(real(1.2));
  await side.page.locator(`[data-fighter="${id}"]`).click();
  await sleep(real(0.8));
}
mark("picked");
const st = () => host.page.evaluate(() => {
  const s = window.__brawl.store.getState();
  return { phase: s.phase, countdown: s.countdown, replay: !!s.replay, ending: s.ending };
});
await host.page.waitForFunction(() => window.__brawl.store.getState().phase === "countdown", null, { timeout: real(120), polling: 100 });
mark("countdown");
await host.page.waitForFunction(() => { const s = window.__brawl.store.getState(); return s.phase === "fighting" && s.countdown === null; }, null, { timeout: real(120), polling: 50 });
mark("fight");
const until = Date.now() + real(SECONDS);
while (Date.now() < until && (await st()).phase === "fighting") await sleep(real(0.1));
if ((await st()).phase === "fighting") {
  mark("finish");
  await host.page.evaluate(() => {
    const { game, store } = window.__brawl;
    game.fight.fighters.p2.hp = 1;
    store.setState((s) => ({ players: { ...s.players, p2: { ...s.players.p2, hp: 1 } } }));
  });
}
await host.page.waitForFunction(() => window.__brawl.store.getState().phase !== "fighting", null, { timeout: real(90), polling: 16 });
mark("ko");
console.log("ended", JSON.stringify(await st()));
await host.page.waitForFunction(() => window.__brawl.store.getState().replay, null, { timeout: real(30), polling: 16 }).catch(() => {});
mark("replay");
await host.page.waitForFunction(() => !window.__brawl.store.getState().replay, null, { timeout: real(30), polling: 50 }).catch(() => {});
mark("replay-end");
await sleep(real(2.0));
await recH.stop();
await recC.stop();
await host.context.close();
await client.context.close();
process.exit(0);
