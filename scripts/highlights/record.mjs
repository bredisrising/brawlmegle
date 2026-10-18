// Real K.O.s in a Practice fight, CPU vs CPU, on a browser started with scripts/highlights/edge.sh: records the
// highlights the game makes and measures what recording costs (rounds alternate recording on and off).
// The game's uploads are caught here and saved to --out (clip .webm + .json); --forward <forge base> also sends them on.
//
//   node record.mjs --url http://localhost:5181/ --out C:\...\clips --rounds 6 [--fighters id,id] [--hp 40]
//     [--throttle 4] (CPU slowdown, a weaker laptop) [--pairs p1id:p2id,...] (the page only sees those two fighters, so the CPU wears p2) [--port 9444] [--width 1536 --height 864 --dpr 1.25] [--forward http://127.0.0.1:8797] [--measure 1]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const PORT = arg("port", "9444");
const BASE = arg("url", "http://localhost:5181/");
const OUT = arg("out", "clips");
const ROUNDS = Number(arg("rounds", 4));
const HP = Number(arg("hp", 40));
const FIGHTERS = String(arg("fighters", "a6535b14-7e5d-4b33-9685-765e2df703da")).split(",");
const PAIRS = arg("pairs", "") ? String(arg("pairs")).split(",").map((p) => p.split(":")) : null;
const FORWARD = arg("forward", "");
/** --real 1: let the game upload for real (to its own forge) instead of catching the upload here. */
const REAL = arg("real", "0") === "1";
const MEASURE = arg("measure", "1") === "1";
const THROTTLE = Number(arg("throttle", 1));
/** --meter 1: both CPUs start with a full super meter (fireball finishes); --meter odd: every other round. */
const METER = arg("meter", "0");
const KEY = arg("key", "720f66ea6f3cebda14050f8fa706cc1a");
const WIDTH = Number(arg("width", 1536));
const HEIGHT = Number(arg("height", 864));
const DPR = Number(arg("dpr", 1.25));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const results = [];
for (let round = 0; round < ROUNDS; round++) {
  const pair = PAIRS?.[round % PAIRS.length];
  const fighter = pair ? pair[0] : FIGHTERS[round % FIGHTERS.length];
  const recording = !MEASURE || round % 2 === 0;
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: DPR });
  const page = await context.newPage();
  if (THROTTLE > 1) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  page.on("console", (m) => /highlight/i.test(m.text()) && console.log("console", m.text()));
  page.on("crash", () => console.log("PAGE CRASHED"));
  page.on("close", () => console.log("page closed"));
  let uploaded = null;
  await page.route("**/api/highlights", async (route) => {
    const req = route.request();
    if (req.method() !== "POST" || REAL) return route.fallback();
    const body = req.postDataBuffer();
    const meta = JSON.parse(decodeURIComponent(req.headers()["x-highlight-meta"]));
    const name = `${Date.now()}-${meta[meta.winner].name.replace(/\W+/g, "")}-${meta.move}`;
    fs.writeFileSync(path.join(OUT, `${name}.webm`), body);
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(meta, null, 2));
    uploaded = { name, bytes: body.length, meta };
    if (FORWARD) {
      const res = await fetch(`${FORWARD.replace(/\/$/, "")}/api/highlights`, {
        method: "POST",
        headers: { "content-type": req.headers()["content-type"], "x-forge-key": KEY, "x-highlight-meta": req.headers()["x-highlight-meta"] },
        body,
      });
      console.log("forwarded", res.status);
    }
    await route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
  });
  if (pair) {
    await page.route("**/api/fighters", async (route) => {
      const res = await route.fetch();
      const all = await res.json();
      await route.fulfill({ response: res, json: pair.map((id) => all.find((f) => f.id === id)).filter(Boolean) });
    });
  }
  await page.goto(`${BASE}${BASE.includes("?") ? "&" : "?"}perf=1&input=mock&record=0`, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => window.__brawl, null, { timeout: 60000 });
  await page.getByRole("button", { name: /^03 Practice/ }).click();
  await page.getByRole("button", { name: /Load fighter/ }).click();
  await page.locator(`[data-fighter="${fighter}"]`).click();
  // The walkout plays first: any key skips it.
  await page.waitForFunction(() => window.__brawl.store.getState().phase === "countdown", null, { timeout: 120000, polling: 250 });
  await sleep(1500);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => { const s = window.__brawl.store.getState(); return s.phase === "fighting" && s.countdown === null; }, null, { timeout: 120000, polling: 250 });
  // P1 becomes a CPU too (the mock player barely fights), and both start low so a K.O. comes quickly.
  await page.evaluate(({ hp, recording, seed, meter }) => {
    const { game, store } = window.__brawl;
    const Cpu = game.cpu.p2.constructor;
    game.cpu.p1 = new Cpu("p1", "hard", seed);
    for (const id of ["p1", "p2"]) game.fight.fighters[id].hp = hp;
    store.setState((s) => ({ players: { p1: { ...s.players.p1, hp }, p2: { ...s.players.p2, hp } } }));
    if (!recording) game.highlight.start = () => {};
    // Time starting and stopping the recorder (one-offs at the replay's start and end).
    window.__once = {};
    for (const name of ["start", "finish"]) {
      const fn = game.highlight[name].bind(game.highlight);
      game.highlight[name] = (...a) => {
        const t = performance.now();
        const r = fn(...a);
        window.__once[name] = +(performance.now() - t).toFixed(2);
        return r;
      };
    }
    // Time each copy into the clip (the only main-thread work recording adds per frame).
    const h = game.highlight;
    const frame = h.frame.bind(h);
    window.__copy = [];
    h.frame = () => {
      const t = performance.now();
      frame();
      window.__copy.push(performance.now() - t);
    };
    window.__long = [];
    new PerformanceObserver((list) => window.__long.push(...list.getEntries().map((e) => e.duration))).observe({ type: "longtask" });
    if (meter) for (const id of ["p1", "p2"]) game.fight.fillMeter(id);
  }, { hp: HP, recording, seed: 1000 + round * 77, meter: METER === "1" || (METER === "odd" && round % 2 === 1) });
  await page.waitForFunction(() => window.__brawl.store.getState().phase === "ko", null, { timeout: 120000, polling: 50 });
  const ending = await page.evaluate(() => window.__brawl.store.getState().ending);
  if (ending !== "ko") {
    console.log(`round ${round}: ended by ${ending}, no replay`);
    await context.close();
    continue;
  }
  await page.waitForFunction(() => window.__brawl.store.getState().replay, null, { timeout: 30000, polling: 16 });
  await page.evaluate(() => {
    window.__brawl.perf.reset();
    window.__long.length = 0;
  });
  const t0 = Date.now();
  await page.waitForFunction(() => !window.__brawl.store.getState().replay, null, { timeout: 30000, polling: 50 });
  const replaySeconds = (Date.now() - t0) / 1000;
  // The window runs on past the replay: stopping the recorder, the Blob and the upload happen then.
  await sleep(2000);
  const stats = await page.evaluate(() => {
    const r = window.__brawl.perf.report();
    const copy = window.__copy.slice().sort((a, b) => a - b);
    const q = (p) => copy.length ? copy[Math.min(copy.length - 1, Math.floor(p * copy.length))] : NaN;
    return { frames: r.frames, fps: r.fps, interval: r.interval, cpu: r.cpu, gpu: r.gpu, hitches: r.hitches, longTasks: window.__long.slice(), once: window.__once, copyMs: { n: copy.length, p50: q(0.5), p95: q(0.95), max: copy[copy.length - 1] } };
  });
  const entry = { round, fighter, recording, replaySeconds, ...stats, uploaded: uploaded && { name: uploaded.name, bytes: uploaded.bytes, meta: uploaded.meta } };
  results.push(entry);
  const f = (v) => (Number.isFinite(v) ? v.toFixed(2) : "-");
  console.log(`round ${round} rec=${recording} ${replaySeconds.toFixed(1)}s fps ${f(stats.fps)} frame p50 ${f(stats.interval.p50)} p95 ${f(stats.interval.p95)} p99 ${f(stats.interval.p99)} max ${f(stats.interval.max)} hitches ${stats.hitches} cpu p50 ${f(stats.cpu.p50)} p95 ${f(stats.cpu.p95)} gpu p50 ${f(stats.gpu.p50)} copy p50 ${f(stats.copyMs.p50)} p95 ${f(stats.copyMs.p95)} max ${f(stats.copyMs.max)} start/finish ${JSON.stringify(stats.once)} long ${stats.longTasks.map((d) => d.toFixed(0)).join(",") || "none"} ${uploaded ? `clip ${(uploaded.bytes / 1e6).toFixed(2)} MB ${JSON.stringify(uploaded.meta)}` : "no clip"}`);
  await context.close();
}
fs.writeFileSync(path.join(OUT, `results-${Date.now()}.json`), JSON.stringify(results, null, 2));
// Leave the browser running (closing a CDP-connected browser ends it): just disconnect.
process.exit(0);
