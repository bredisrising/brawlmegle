// Trailer footage: drives the real game in an Edge started with scripts/trailer/edge.sh and records it with CDP
// screencast frames (JPEG + the compositor's timestamp per frame; assemble.py turns them into constant-rate video).
// Run with the Windows node (paths are Windows paths):
//   node capture.mjs --scene fight --out C:\...\shot1 [--url http://localhost:4291/] [--port 9555]
//     [--p1 <fighter id>] [--p2 <fighter id>] [--input mock|camera] [--cpu1 hard|none] [--hp 100] [--ko 1]
//     [--walkout 1] [--seconds 20] [--demo 1] [--warp 0.333]
//   node capture.mjs --scene forge --out C:\...\forge --name <username> --input camera   (a real forge: costs credits)
//   node capture.mjs --scene title --out C:\...\title --seconds 8
//
// --warp k slows the page's clock to k (performance.now, Date.now, rAF, timers, video frame callbacks, the audio
// clock and CSS animations), so the screencast (~40 fps of 1080p JPEGs) samples 40/k frames per game second: smooth
// 60 fps footage after assemble.py. A camera file for a warped run must be slowed to match (make-cam.sh --slow).
// Nothing is uploaded: ?record=0&video=0, the K.O. highlight upload is caught (saved next to the frames), and any
// other POST to /samples is refused here.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const PORT = arg("port", "9555");
const BASE = arg("url", "http://localhost:4291/");
const OUT = arg("out", "shot");
const SCENE = arg("scene", "fight");
const P1 = arg("p1", "740b3eaf-55be-4abe-9870-e1fd03289ea3");
const P2 = arg("p2", "454c8159-aeb4-442e-8b15-21ce29c936aa");
const INPUT = arg("input", "mock");
const CPU1 = arg("cpu1", "hard");
const CPU2 = arg("cpu2", "hard");
const HP = Number(arg("hp", 100));
const KO = arg("ko", "1") === "1";
const WALKOUT = arg("walkout", "1") === "1";
const SECONDS = Number(arg("seconds", 20));
const DEMO = arg("demo", "1") === "1";
const NAME = arg("name", "");
const QUALITY = Number(arg("jpeg", 90));
const WIDTH = Number(arg("width", 1920));
const HEIGHT = Number(arg("height", 1080));
/** --dsf 2: render at 2x (3840x2160 frames), for sharp crops and zooms in the edit. */
const DSF = Number(arg("dsf", 1));
const WARP = Number(arg("warp", SCENE === "fight" ? 1 / 3 : 1));
const SEED = Number(arg("seed", 4242));
/** --cast 0: no screencast (measures the game alone). */
const CAST = arg("cast", "1") === "1";
const EXTRA = arg("params", "");
/** --hype 1: CPUs that attack more and block less (same engine, same rules): more hits per second of footage. */
const HYPE = arg("hype", "0") === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Real seconds for `s` seconds of game time. */
const real = (s) => (s * 1000) / WARP;
fs.mkdirSync(OUT, { recursive: true });

/** Runs in the page before anything else: the clock runs at K. */
function warpClock(K) {
  if (K === 1) return;
  const perf = performance.now.bind(performance);
  const R0 = perf();
  const warp = (t) => R0 + (t - R0) * K;
  performance.now = () => warp(perf());
  const dateNow = Date.now;
  const W0 = dateNow();
  Date.now = () => Math.round(W0 + (dateNow() - W0) * K);
  window.__warp = { K, W0, R0 };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => cb(warp(t)));
  const st = window.setTimeout.bind(window);
  const si = window.setInterval.bind(window);
  window.setTimeout = (fn, d = 0, ...a) => st(fn, (Number(d) || 0) / K, ...a);
  window.setInterval = (fn, d = 0, ...a) => si(fn, (Number(d) || 0) / K, ...a);
  const rvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
  if (rvfc) {
    window.__cam = [];
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) {
      return rvfc.call(this, (now, meta) => {
        const m = { ...meta, expectedDisplayTime: warp(meta.expectedDisplayTime) };
        if (meta.captureTime !== undefined) m.captureTime = warp(meta.captureTime);
        if (this.srcObject && window.__cam.length < 200000) window.__cam.push([Math.round(warp(now)), meta.presentedFrames]);
        cb(warp(now), m);
      });
    };
  }
  const desc = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, "currentTime");
  Object.defineProperty(BaseAudioContext.prototype, "currentTime", {
    configurable: true,
    get() {
      const t = desc.get.call(this);
      if (this.__c0 === undefined) this.__c0 = t;
      return this.__c0 + (t - this.__c0) * K;
    },
  });
  // Media (the highlight reel) plays at K too.
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    if (!this.srcObject) {
      this.playbackRate = K;
      this.defaultPlaybackRate = K;
    }
    return play.apply(this, a);
  };
}

/** CDP screencast to numbered JPEGs + frames.txt ("index timestamp" per line, wall seconds). */
class Recorder {
  constructor(page) {
    this.page = page;
    this.n = 0;
    this.lines = [];
    this.marks = [];
  }
  async start() {
    this.t0 = Date.now();
    if (!CAST) return;
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", (f) => {
      this.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      const i = this.n++;
      fs.writeFile(path.join(OUT, `f${String(i).padStart(6, "0")}.jpg`), Buffer.from(f.data, "base64"), () => {});
      this.lines.push(`${i} ${f.metadata.timestamp}`);
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: QUALITY, maxWidth: WIDTH * DSF, maxHeight: HEIGHT * DSF, everyNthFrame: 1 });
  }
  /** Note a moment ("ko", "replay", ...) by wall clock; assemble.py puts it on the video's timeline. */
  mark(label) {
    this.marks.push(`${label} ${Date.now() / 1000}`);
    console.log("mark", label, ((Date.now() - this.t0) / 1000).toFixed(2));
  }
  async stop(extra = {}) {
    const warp = await this.page.evaluate(() => window.__warp ?? null).catch(() => null);
    const cam = await this.page.evaluate(() => window.__cam ?? []).catch(() => []);
    const hits = await this.page.evaluate(() => window.__hits ?? []).catch(() => []);
    fs.writeFileSync(path.join(OUT, "hits.json"), JSON.stringify(hits));
    if (CAST) await this.cdp.send("Page.stopScreencast").catch(() => {});
    await sleep(800);
    const secs = (Date.now() - this.t0) / 1000;
    fs.writeFileSync(path.join(OUT, "frames.txt"), this.lines.join("\n") + "\n");
    fs.writeFileSync(path.join(OUT, "marks.txt"), this.marks.join("\n") + "\n");
    fs.writeFileSync(path.join(OUT, "warp.json"), JSON.stringify({ K: WARP, W0: warp ? warp.W0 / 1000 : null, R0: warp ? warp.R0 : null, ...extra }));
    if (cam.length) fs.writeFileSync(path.join(OUT, "cam.json"), JSON.stringify(cam));
    console.log(`frames ${this.n} in ${secs.toFixed(1)} s = ${(this.n / secs).toFixed(1)} fps real, ${(this.n / secs / WARP).toFixed(1)} per game second`);
  }
}

let rec = null;
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: DSF });
await context.addInitScript(warpClock, WARP);
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
page.on("console", (m) => (m.type() === "error" || m.type() === "warning" || /highlight|forge/i.test(m.text())) && console.log("console", m.text().slice(0, 300)));
// Never upload: the K.O. highlight is kept here instead, and match samples are refused.
await page.route("**/api/highlights", async (route) => {
  const req = route.request();
  if (req.method() !== "POST") return route.fallback();
  fs.writeFileSync(path.join(OUT, "highlight.webm"), req.postDataBuffer() ?? Buffer.alloc(0));
  console.log("caught highlight upload (not sent)");
  await route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
});
// Leaderboard results from staged fights would skew the real one.
await page.route("**/api/matches", async (route) => {
  if (route.request().method() === "GET") return route.fallback();
  console.log("blocked match result");
  await route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
});
// Commentary voices cost credits and the capture has no sound: captions only.
await page.route("**/api/tts**", (route) => route.fulfill({ status: 404, body: "" }));
await page.route("**/samples**", async (route) => {
  if (route.request().method() === "GET") return route.fallback();
  console.log("blocked sample upload", route.request().url());
  await route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
});
/** These fighters from the server's list, or straight from the forge when the list has moved on (a re-forge). */
async function pick(all, ids) {
  const out = [];
  for (const id of ids) {
    const f = all.find((x) => x.id === id) ?? (await (await fetch(`https://54-149-60-196.sslip.io/api/forge/${id}`)).json().catch(() => null));
    if (f?.status === "ready") out.push(f);
  }
  return out;
}
// Only these two fighters on the memory card, so the CPU wears P2's.
if (SCENE === "fight") {
  await page.route("**/api/fighters", async (route) => {
    const res = await route.fetch();
    const all = await res.json();
    await route.fulfill({ response: res, json: await pick(all, [P1, P2]) });
  });
}
if (SCENE === "forge") {
  // The CPU opponent after the forge: P2's fighter.
  await page.route("**/api/fighters", async (route) => {
    const res = await route.fetch();
    const all = await res.json();
    await route.fulfill({ response: res, json: await pick(all, [P2]) });
  });
}

/**
 * --replay <forge id>: the forging card replays a finished forge instead of starting one (no credits spent, nothing
 * uploaded): the scan runs for real, then POST /api/forge answers with that id and its status reveals the real
 * forge's own outputs (brief, sheet, voxels, clay, model) on the timeline that forge took.
 */
const REPLAY = arg("replay", "");
/** The replayed forge's steps on its own timeline (its recorded step timings, seconds after the scan was sent). */
function replaySteps(final) {
  const t = final.timings ?? {};
  const brief = (t.brief ?? 2100) / 1000;
  const sheet = brief + (t.sheet ?? 11700) / 1000;
  const model = sheet + (t.model ?? 19500) / 1000;
  const span = model - sheet;
  return [
    [0, { status: "forging", step: "brief" }, []],
    [brief, { step: "sheet" }, ["brief"]],
    [brief + (sheet - brief) * 0.55, {}, ["sheetPartialUrl"]],
    [sheet, { step: "model" }, ["sheetUrl", "cardUrl"]],
    [sheet + span * 0.35, {}, ["previewVoxelsUrl"]],
    [sheet + span * 0.55, {}, ["previewMeshUrl"]],
    [sheet + span * 0.9, { step: "rig" }, []],
    [model + 1, { status: "ready" }, ["glbUrl", "modelUrl", "rigged"]],
  ];
}
if (SCENE === "forge" && REPLAY) {
  const final = await (await fetch(`https://54-149-60-196.sslip.io/api/forge/${REPLAY}`)).json();
  const REPLAY_STEPS = replaySteps(final);
  console.log("replay steps", JSON.stringify(REPLAY_STEPS.map(([t, set, keys]) => [+t.toFixed(1), set, keys])));
  let t0 = 0;
  await page.route("**/api/profiles/**", (route) => route.fulfill({ json: { username: NAME, fighter: null, forging: null } }));
  await page.route("**/api/forge", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    t0 = Date.now();
    rec?.mark("submit");
    console.log("forge submit caught (not sent), replaying", REPLAY);
    await route.fulfill({ json: { id: REPLAY } });
  });
  await page.route(`**/api/forge/${REPLAY}`, async (route) => {
    const at = ((Date.now() - t0) / 1000) * WARP;
    const status = { id: final.id, name: final.name, username: final.username };
    for (const [t, set, keys] of REPLAY_STEPS) {
      if (at < t) break;
      Object.assign(status, set);
      for (const k of keys) if (final[k] !== undefined) status[k] = final[k];
    }
    if (status.status === "ready") delete status.step;
    await route.fulfill({ json: status });
  });
}

const params = new URLSearchParams({ perf: "1", input: INPUT, record: "0", video: "0", quality: "high" });
if (DEMO) params.set("demo", "1");
if (!WALKOUT) params.set("walkout", "0");
for (const kv of EXTRA.split("&").filter(Boolean)) params.set(...kv.split("="));
await page.goto(`${BASE}?${params}`, { waitUntil: "load", timeout: 120000 });
if (WARP !== 1) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: WARP });
}
await page.waitForFunction(() => window.__brawl, null, { timeout: 60000 });
// Every hit as it's shown (page clock, ms): hits.json, to find the shots in the footage.
await page.evaluate(() => {
  const g = window.__brawl.game;
  const show = g.showHit.bind(g);
  window.__hits = [];
  g.showHit = (e, by, ko, replaying) => {
    if (!replaying) window.__hits.push({ t: performance.now(), type: e.type, attacker: e.attacker, move: e.move, damage: e.damage ?? null, ko: !!ko, guardBreak: !!e.guardBreak });
    return show(e, by, ko, replaying);
  };
});
// ?perf=1 is only for window.__brawl: hide its frame-time overlay.
await page.evaluate(() => { const o = window.__brawl.perf?.overlay; if (o) o.style.display = "none"; });
/** Under the warp, draw every display frame (the cap counts game time): 60/k frames per game second. */
const uncap = () => page.evaluate((fps) => {
  const r = window.__brawl.game.renderer;
  if (r) r.maxFps = fps;
}, 60 / WARP);
if (WARP !== 1) {
  await uncap();
  setInterval(() => uncap().catch(() => {}), 2000);
}
rec = new Recorder(page);
const state = () => page.evaluate(() => {
  const s = window.__brawl.store.getState();
  return { phase: s.phase, countdown: s.countdown, replay: !!s.replay, ending: s.ending, screen: s.screen, p1: s.players.p1.status, p2: s.players.p2.status };
});
const noHighlight = () => page.evaluate(() => {
  // Recording the replay costs frames and is never uploaded from here anyway.
  window.__brawl.game.highlight.start = () => {};
});
const stripCpu = async () => {
  const p2 = await page.evaluate(() => window.__brawl.store.getState().players.p2.name);
  console.log("p2 is", p2);
  if (/sparring/i.test(p2)) throw new Error("the CPU got the placeholder fighter, not P2's: run again");
  return stripName();
};
const stripName = () => page.evaluate(() => {
  const { store } = window.__brawl;
  store.setState((s) => ({ players: { ...s.players, p2: { ...s.players.p2, name: s.players.p2.name.replace(/\s*\(CPU.*\)$/, "") } } }));
});

/** Fight until SECONDS of game time pass (or someone falls), then finish with a K.O. and wait out the replay. */
async function fightAndFinish() {
  await page.waitForFunction(() => { const s = window.__brawl.store.getState(); return s.phase === "fighting" && s.countdown === null; }, null, { timeout: real(120), polling: 50 });
  rec.mark("fight");
  await page.evaluate(() => window.__brawl.perf.reset());
  await page.evaluate(({ hp, cpu1, cpu2, seed, hype }) => {
    const { game, store } = window.__brawl;
    const Cpu = game.cpu.p2.constructor;
    if (cpu1 !== "none") game.cpu.p1 = new Cpu("p1", cpu1, seed);
    if (cpu2 !== "hard") game.cpu.p2 = new Cpu("p2", cpu2, seed + 1);
    if (hype) {
      for (const id of ["p1", "p2"]) {
        const c = game.cpu[id];
        if (c?.spec) c.spec = { ...c.spec, cooldown: [24, 60], telegraph: [8, 12], defendChance: 0.3, shellChance: 0.15, comboChance: 0.85, still: 30 };
      }
    }
    if (hp < 100) {
      for (const id of ["p1", "p2"]) game.fight.fighters[id].hp = hp;
      store.setState((s) => ({ players: { p1: { ...s.players.p1, hp }, p2: { ...s.players.p2, hp } } }));
    }
  }, { hp: HP, cpu1: CPU1, cpu2: CPU2, seed: SEED, hype: HYPE });
  const until = Date.now() + real(SECONDS);
  while (Date.now() < until && (await state()).phase === "fighting") await sleep(100);
  if (KO && (await state()).phase === "fighting") {
    // Finish it: P2 down to one hit point, the next clean hit is the K.O.
    rec.mark("finish");
    await page.evaluate(() => {
      const { game, store } = window.__brawl;
      game.fight.fighters.p2.hp = 1;
      store.setState((s) => ({ players: { ...s.players, p2: { ...s.players.p2, hp: 1 } } }));
    });
  }
  await page.waitForFunction(() => window.__brawl.store.getState().phase !== "fighting", null, { timeout: real(60), polling: 16 });
  rec.mark("ko");
  const perf = await page.evaluate(() => { const r = window.__brawl.perf.report(); return { fps: r.fps, p95: r.interval.p95, hitches: r.hitches }; });
  console.log("fight perf (game clock)", JSON.stringify(perf));
  const st = await state();
  console.log("ended", JSON.stringify(st));
  if (st.ending === "ko") {
    await page.waitForFunction(() => window.__brawl.store.getState().replay, null, { timeout: real(30), polling: 16 }).catch(() => {});
    rec.mark("replay");
    await page.waitForFunction(() => !window.__brawl.store.getState().replay, null, { timeout: real(30), polling: 50 }).catch(() => {});
    rec.mark("replay-end");
  }
  await sleep(real(2.5));
}

if (SCENE === "title") {
  await rec.start();
  await sleep(real(SECONDS));
  await rec.stop();
} else if (SCENE === "fight") {
  await noHighlight();
  await page.getByRole("button", { name: /^03 Practice/ }).click();
  await page.getByRole("button", { name: /Load fighter/ }).click();
  await page.locator(`[data-fighter="${P1}"]`).click();
  await page.waitForFunction(() => window.__brawl.store.getState().players.p2.status === "ready", null, { timeout: real(120), polling: 100 });
  await stripCpu();
  await rec.start();
  rec.mark("start");
  await fightAndFinish();
  await rec.stop();
} else if (SCENE === "forge") {
  if (!NAME) throw new Error("--name <username> for the forge");
  await noHighlight();
  await sleep(real(1.5));
  await rec.start();
  rec.mark("title");
  await sleep(real(1.5));
  await page.getByRole("button", { name: /^03 Practice/ }).click();
  await sleep(real(1.2));
  await page.getByRole("button", { name: /Enter/ }).first().click();
  await sleep(real(0.8));
  await page.locator("#fighter-name").pressSequentially(NAME, { delay: real(0.11) });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /Yes, scan me/.test(b.textContent) && !b.disabled), null, { timeout: real(20) });
  const welcome = await page.getByText("Welcome back").count();
  if (welcome) throw new Error(`${NAME} already has a fighter: pick a new username`);
  await sleep(real(0.7));
  await page.getByRole("button", { name: /Yes, scan me/ }).click();
  rec.mark("scan");
  await page.waitForFunction(() => window.__brawl.store.getState().players.p1.status === "forging", null, { timeout: real(60), polling: 100 });
  rec.mark("forging");
  await page.waitForFunction(() => window.__brawl.store.getState().players.p1.status === "ready", null, { timeout: real(360), polling: 100 });
  rec.mark("ready");
  await page.waitForFunction(() => window.__brawl.store.getState().players.p2.status === "ready", null, { timeout: real(60), polling: 100 });
  await stripCpu();
  rec.mark("countdown");
  if (arg("fight", "1") === "1") await fightAndFinish();
  else await sleep(real(Number(arg("tail", 14))));
  await rec.stop();
}
await context.close();
process.exit(0);
