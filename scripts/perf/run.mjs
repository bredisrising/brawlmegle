// Runtime perf run: drives a Practice fight (you vs the CPU) in a browser started with --remote-debugging-port
// and measures frame times, GPU time, draw stats, main-thread time, React renders, GC and MediaPipe time.
// Start the browser with scripts/perf/edge.sh (it runs this). Needs the game built with ?perf support.
//
//   node run.mjs --url "http://localhost:4173/?perf=1&input=mock" --label 4070 --out result.json
//     [--fighter <id>] [--phases fight,hits,ko] [--seconds 12] [--width 1536 --height 864 --dpr 1.25]
//     [--throttle 1] [--ablate]   (--ablate: GPU ms with bloom / shadows / hills / outlines / MSAA turned off one at a time)
import fs from "node:fs";
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? true : argv[i + 1];
};
// Never record perf runs into the team's training samples (recording is on by default) unless asked to.
const URL_ = ((u) => (/[?&]record=/.test(u) ? u : `${u}${u.includes("?") ? "&" : "?"}record=0`))(arg("url", "http://localhost:4173/?perf=1&input=mock"));
const LABEL = arg("label", "run");
const OUT = arg("out", null);
const FIGHTER = arg("fighter", "a6535b14-7e5d-4b33-9685-765e2df703da"); // rico, a forged (Tripo) fighter
const PHASES = String(arg("phases", "fight,hits,ko")).split(",");
const SECONDS = Number(arg("seconds", 12));
const WIDTH = Number(arg("width", 1536));
const HEIGHT = Number(arg("height", 864));
const DPR = Number(arg("dpr", 1.25));
const THROTTLE = Number(arg("throttle", 1));
const ABLATE = !!arg("ablate", false);
const PORT = arg("port", "9222");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${LABEL}]`, ...a);

/** Counts React commits and the components that rendered in each (a stand-in DevTools hook; works in production builds). */
const INIT = () => {
  // Same CPU fighter and CPU play every run (the game picks with Math.random).
  let seed = 12345;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const stats = { commits: 0, renders: 0, byName: {} };
  window.__reactStats = stats;
  const isComponent = (f) => f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 14 || f.tag === 15;
  const nameOf = (f) => {
    const t = f.type;
    return (t && (t.displayName || t.name || (t.type && (t.type.displayName || t.type.name)) || (t.render && t.render.name))) || `tag${f.tag}`;
  };
  const visit = (root) => {
    const stack = [root];
    while (stack.length) {
      const next = stack.pop();
      const prev = next.alternate;
      // A fiber rendered this commit if it's new, or was cloned and ran (PerformedWork = 1).
      if (isComponent(next) && (!prev || next.flags & 1)) {
        stats.renders++;
        const n = nameOf(next);
        stats.byName[n] = (stats.byName[n] || 0) + 1;
      }
      // Children were reconciled only if the child pointer changed (else the whole subtree bailed out).
      if (!prev || next.child !== prev.child) for (let c = next.child; c; c = c.sibling) stack.push(c);
    }
  };
  let id = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(r) {
      this.renderers.set(++id, r);
      return id;
    },
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      stats.commits++;
      try {
        visit(root.current);
      } catch {}
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
  // Long animation frames (> 50 ms) with script attribution, for hitches.
  window.__loaf = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__loaf.push({
          t: e.startTime, duration: e.duration, blocking: e.blockingDuration,
          scripts: (e.scripts || []).map((s) => ({ invoker: s.invoker, duration: s.duration, source: (s.sourceFunctionName || "") + " " + (s.sourceURL || "").split("/").pop() })),
        });
      }
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch {}
};

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: DPR });
await context.addInitScript(INIT);
const page = await context.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(`[${m.type()}] ${m.text().slice(0, 200)}`);
  if (/switching to lite|\[quality\]/.test(m.text())) log("console:", m.text());
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message.slice(0, 200)}`));
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

const result = { label: LABEL, url: URL_, viewport: `${WIDTH}x${HEIGHT}@${DPR}`, throttle: THROTTLE, phases: {} };
try {
  await page.goto(URL_, { waitUntil: "load", timeout: 120_000 });
  await page.waitForFunction(() => window.__brawl, null, { timeout: 60_000 });
  result.gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  log("gpu:", result.gpu);

  await page.getByRole("button", { name: /Practice/ }).first().click();
  await page.getByRole("button", { name: /Load fighter/ }).click();
  await page.locator(`[data-fighter="${FIGHTER}"]`).click();
  await page.evaluate(() => window.__brawl.perf.reset());
  const t0 = Date.now();
  await page.waitForFunction(() => {
    const s = window.__brawl.store.getState();
    return s.phase === "fighting" && s.countdown === null;
  }, null, { timeout: 180_000, polling: 250 });
  result.toFightMs = Date.now() - t0;
  log(`fighting after ${result.toFightMs} ms`);
  // Frames from picking a fighter to the fight (both fighters loading and spawning in): the worst ones are load hitches.
  result.loadPerf = await page.evaluate(() => window.__brawl.perf.report());
  log(`load window: max frame ${result.loadPerf.interval.max?.toFixed(0)} ms, p99 ${result.loadPerf.interval.p99?.toFixed(0)}, hitches ${result.loadPerf.hitches}`);
  // GPU memory, roughly: every texture the scene's materials use (with mipmaps) and the composer's render targets.
  result.gpuMemory = await page.evaluate(() => {
    const { game } = window.__brawl;
    const R = game.renderer;
    const seen = new Set();
    let textures = 0;
    R.scene.traverse((o) => {
      for (const m of [].concat(o.material || [])) {
        for (const v of Object.values(m)) {
          if (!v || !v.isTexture || seen.has(v)) continue;
          seen.add(v);
          const img = v.image;
          const w = img?.width || img?.videoWidth || 0, h = img?.height || img?.videoHeight || 0;
          if (v.isCompressedTexture) continue;
          textures += w * h * 4 * (v.generateMipmaps !== false ? 4 / 3 : 1);
        }
      }
    });
    const gl = R.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const rt = R.composer.renderTarget1;
    // Two HalfFloat targets (8 bytes/px) with their MSAA buffers and depth, plus the bloom chain (~1/3 of a target).
    const samples = rt.samples || 0;
    const targets = 2 * w * h * (8 + 4) * (1 + samples) + (w * h * 8) / 3;
    let shadow = 0;
    R.scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow) shadow += o.shadow.mapSize.x * o.shadow.mapSize.y * 4; });
    return { texturesMB: +(textures / 1e6).toFixed(0), targetsMB: +(targets / 1e6).toFixed(0), shadowMB: +(shadow / 1e6).toFixed(0), textureCount: seen.size };
  });
  log(`gpu memory ~ textures ${result.gpuMemory.texturesMB} MB (${result.gpuMemory.textureCount}), render targets ${result.gpuMemory.targetsMB} MB, shadow ${result.gpuMemory.shadowMB} MB`);
  // Keep the round going: HP and the clock topped up (rarely, so it barely touches the store).
  await page.evaluate(() => {
    const { game, store } = window.__brawl;
    window.__keepAlive = setInterval(() => {
      if (store.getState().phase !== "fighting") return;
      for (const id of ["p1", "p2"]) {
        const f = game.fight.fighters[id];
        if (f.hp < 40) f.hp = 100;
        const p = store.getState().players[id];
        if (p.hp < 40) store.setState((s) => ({ players: { ...s.players, [id]: { ...s.players[id], hp: 100 } } }));
      }
      if (game.clock < 20) game.clock = 60;
    }, 500);
  });
  await sleep(3000); // warm up: shaders compiled, textures uploaded, JIT

  const SHOTS = arg("shots", null);
  if (SHOTS) {
    // Visual check: the fight, a hit's burst, a counter's impact frame (same seed and timing every run).
    const shot = (name) => page.screenshot({ path: `${SHOTS}-${name}.png` });
    await shot("fight");
    const hit = (type, damage) =>
      page.evaluate(({ type, damage }) => {
        const { game } = window.__brawl;
        game.applyEvent({ t: performance.now(), type, attacker: "p1", move: "cross", damage, hitstopFrames: 8 });
      }, { type, damage });
    await hit("hit", 12);
    await sleep(60);
    await shot("hit");
    await sleep(1500);
    await hit("counter", 15);
    await sleep(20);
    await shot("counter");
    await sleep(1500);
  }
  const PROBE = arg("probe", null);
  if (PROBE) {
    // Ad-hoc experiment: a JS file evaluated in the page (its value is logged), e.g. while hits play.
    const code = fs.readFileSync(PROBE, "utf8");
    result.probe = await page.evaluate(code);
    log("probe:", JSON.stringify(result.probe, null, 1));
  }
  if (arg("profile", false)) {
    // Main-thread CPU profile of a few seconds of fighting: top functions by self time.
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
    await sleep(8000);
    const { profile } = await cdp.send("Profiler.stop");
    const self = new Map();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const total = profile.timeDeltas.reduce((a, b) => a + b, 0);
    profile.samples.forEach((id, i) => {
      const n = byId.get(id);
      const f = n.callFrame;
      const key = `${f.functionName || "(anon)"} ${(f.url || "").split("/").pop()}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0));
    });
    result.profile = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, us]) => [k, +(us / 1000).toFixed(1), +((100 * us) / total).toFixed(1)]);
    log(`profile (${(total / 1e6).toFixed(1)} s):`);
    for (const [k, ms, pct] of result.profile.slice(0, 30)) log(`  ${pct}% ${ms} ms  ${k}`);
  }
  for (const phase of PHASES) {
    if (phase === "ablate" || phase === "none") continue;
    result.phases[phase] = await measure(phase);
    log(phase, summary(result.phases[phase]));
  }
  if (ABLATE) {
    result.ablation = await ablate();
    for (const [k, v] of Object.entries(result.ablation)) log(`ablate ${k}: gpu p50 ${v.gpu.p50?.toFixed(2)} ms, cpu p50 ${v.cpu.p50?.toFixed(2)}, fps ${v.fps.toFixed(1)}, calls ${v.calls}, tris ${v.triangles}`);
  }
} catch (err) {
  result.error = String(err?.stack || err);
  log("error:", err);
  try {
    await page.screenshot({ path: OUT ? OUT.replace(/\.json$/, ".error.png") : "error.png" });
  } catch {}
} finally {
  result.errors = errors.slice(0, 40);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  try {
    const b = await browser.newBrowserCDPSession();
    await b.send("Browser.close");
  } catch {}
  await browser.close().catch(() => {});
}

function summary(p) {
  const f = (v) => (Number.isFinite(v) ? v.toFixed(1) : "-");
  return `fps ${f(p.perf.fps)} | frame p50 ${f(p.perf.interval.p50)} p95 ${f(p.perf.interval.p95)} p99 ${f(p.perf.interval.p99)} max ${f(p.perf.interval.max)} | hitches ${p.perf.hitches} | cpu p50 ${f(p.perf.cpu.p50)} p95 ${f(p.perf.cpu.p95)} | gpu p50 ${f(p.perf.gpu.p50)} p95 ${f(p.perf.gpu.p95)} | main ${f(p.mainMsPerFrame)} ms/frame (script ${f(p.scriptMsPerFrame)}) | calls ${p.perf.calls} tris ${p.perf.triangles} tex ${p.perf.textures} | react ${f(p.react.commitsPerSec)} commits/s ${f(p.react.rendersPerSec)} renders/s | store ${f(p.storePerSec)}/s | gc ${p.gc ? `${p.gc.count} (${f(p.gc.totalMs)} ms, max ${f(p.gc.maxMs)})` : "-"} | pose ${p.pose ? `${p.pose.runner}/${p.pose.delegate} ${p.pose.variant} ${f(p.pose.detectMs)} ms, ${f(p.pose.posesPerSec)}/s, age p50 ${f(p.pose.ageP50)} p95 ${f(p.pose.ageP95)}${p.pose.singlePose ? " ONE-POSE" : ""} hipX ${JSON.stringify(p.pose.hipX)}` : "-"} | heap ${f(p.heapMB)} MB | quality ${p.quality ? p.quality.level : "-"}`;
}

async function metrics() {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/** One window: reset the counters, play it out, collect. */
async function measure(phase) {
  await page.evaluate(() => {
    window.__brawl.perf.reset();
    window.__reactStats.commits = window.__reactStats.renders = 0;
    window.__reactStats.byName = {};
    window.__loaf.length = 0;
    window.__storeUpdates = 0;
    window.__unsubStore?.();
    window.__unsubStore = window.__brawl.store.subscribe(() => window.__storeUpdates++);
    // Poses delivered for P1, and how old each is on arrival (camera frame -> landmarks in the game).
    window.__poseAges = [];
    window.__poseHips = [];
    window.__unsubPose?.();
    window.__unsubPose = window.__brawl.game.input.subscribe("p1", (f) => {
      window.__poseAges.push(performance.now() - f.t);
      if (f.image[23] && f.image[24]) window.__poseHips.push((f.image[23].x + f.image[24].x) / 2);
    });
  });
  const traceDone = startTrace();
  const m0 = await metrics();
  const started = Date.now();
  if (phase === "hits") {
    // Forced hits every 300 ms: light, heavy, counter in turn (popups, sparks, impact frames, camera punch).
    await page.evaluate((seconds) => {
      const { game } = window.__brawl;
      let n = 0;
      window.__hitTimer = setInterval(() => {
        const kind = n++ % 3;
        const defender = n % 2 ? "p2" : "p1";
        game.applyEvent({
          t: performance.now(), type: kind === 2 ? "counter" : "hit", attacker: defender === "p1" ? "p2" : "p1",
          move: kind === 0 ? "jab" : "cross", damage: kind === 0 ? 5 : kind === 1 ? 12 : 15, hitstopFrames: 8,
        });
      }, 300);
      setTimeout(() => clearInterval(window.__hitTimer), seconds * 1000);
    }, SECONDS);
  } else if (phase === "ko") {
    await page.evaluate(() => {
      clearInterval(window.__keepAlive);
      const { game } = window.__brawl;
      game.applyEvent({ t: performance.now(), type: "hit", attacker: "p1", move: "cross", damage: 500, hitstopFrames: 14 });
    });
  }
  await sleep(SECONDS * 1000);
  const m1 = await metrics();
  const elapsed = (Date.now() - started) / 1000;
  const gc = await traceDone();
  const inPage = await page.evaluate(() => {
    const { game, perf } = window.__brawl;
    const source = game.localInputSource();
    return {
      perf: perf.report(),
      react: { ...window.__reactStats },
      store: window.__storeUpdates,
      loaf: window.__loaf.slice(0, 30),
      pose: source && source.stats ? (() => {
        const ages = window.__poseAges.slice().sort((a, b) => a - b);
        return {
          variant: source.variant, detectMs: source.stats.detectMs, cameraFps: source.stats.fps, runner: source.stats.runner, delegate: source.stats.delegate ?? source.delegate,
          posesPerSec: ages.length, ageP50: ages[Math.floor(ages.length / 2)], ageP95: ages[Math.floor(ages.length * 0.95)],
          // Where the tracked person's hips are (image x): a jump to someone else in frame shows in the tails.
          hipX: (() => {
            const h = window.__poseHips.slice().sort((a, b) => a - b);
            const q = (p) => +(h[Math.min(h.length - 1, Math.floor(p * h.length))] ?? NaN).toFixed(3);
            return { p1: q(0.01), p5: q(0.05), p50: q(0.5), p95: q(0.95), p99: q(0.99) };
          })(),
          singlePose: source.stats.singlePose,
        };
      })() : null,
      phase: window.__brawl.store.getState().phase,
      quality: game.renderer.governor ? { level: game.renderer.governor.level, ...game.renderer.governor.last } : null,
    };
  });
  if (inPage.pose) inPage.pose.posesPerSec /= elapsed;
  const frames = inPage.perf.frames || 1;
  const top = Object.entries(inPage.react.byName).sort((a, b) => b[1] - a[1]).slice(0, 12);
  return {
    seconds: elapsed,
    perf: inPage.perf,
    mainMsPerFrame: ((m1.TaskDuration - m0.TaskDuration) * 1000) / frames,
    scriptMsPerFrame: ((m1.ScriptDuration - m0.ScriptDuration) * 1000) / frames,
    styleLayoutMsPerFrame: ((m1.RecalcStyleDuration - m0.RecalcStyleDuration + m1.LayoutDuration - m0.LayoutDuration) * 1000) / frames,
    mainBusy: (m1.TaskDuration - m0.TaskDuration) / elapsed,
    heapMB: m1.JSHeapUsedSize / 1e6,
    react: { commitsPerSec: inPage.react.commits / elapsed, rendersPerSec: inPage.react.renders / elapsed, top },
    storePerSec: inPage.store / elapsed,
    gc,
    pose: inPage.pose,
    loaf: inPage.loaf,
    endPhase: inPage.phase,
    quality: inPage.quality,
  };
}

/** Trace the window for GC pauses (count, total, longest). Returns a function that ends it. */
function startTrace() {
  const events = [];
  const onData = (e) => events.push(...e.value);
  cdp.on("Tracing.dataCollected", onData);
  const started = cdp.send("Tracing.start", { categories: "devtools.timeline,v8,disabled-by-default-v8.gc", transferMode: "ReportEvents" }).catch(() => null);
  return async () => {
    await started;
    const complete = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
    await cdp.send("Tracing.end").catch(() => null);
    await Promise.race([complete, sleep(10_000)]);
    cdp.off("Tracing.dataCollected", onData);
    const gcs = events.filter((e) => (e.name === "MinorGC" || e.name === "MajorGC") && e.ph === "X");
    const ms = gcs.map((e) => (e.dur || 0) / 1000);
    return { count: gcs.length, minor: gcs.filter((e) => e.name === "MinorGC").length, major: gcs.filter((e) => e.name === "MajorGC").length, totalMs: ms.reduce((a, b) => a + b, 0), maxMs: ms.length ? Math.max(...ms) : 0 };
  };
}

/** GPU and CPU time with one feature off at a time (live, through the game's objects). */
async function ablate() {
  const out = {};
  const toggles = {
    baseline: () => {},
    noBloom: (on) => window.__brawl.game.renderer.composer.passes.forEach((p) => p.constructor.name.includes("Bloom") && (p.enabled = on)),
    noShadows: (on) => {
      const r = window.__brawl.game.renderer.renderer;
      r.shadowMap.enabled = on;
      r.shadowMap.needsUpdate = true;
    },
    noHills: (on) => {
      const h = window.__brawl.game.renderer.scene.getObjectByName("Background hills");
      if (h) h.visible = on;
    },
    noOutlines: (on) => window.__brawl.game.renderer.scene.traverse((o) => o.userData.outline && (o.visible = on)),
    noFighters: (on) => ["p1", "p2"].forEach((id) => (window.__brawl.game.views[id].root.visible = on)),
    noIsland: (on) => {
      const { game } = window.__brawl;
      for (const o of game.renderer.scene.children) {
        if (o.isGroup && o !== game.views.p1.root && o !== game.views.p2.root && o.name !== "Background hills") o.visible = on;
      }
    },
    dpr1: (on) => {
      const g = window.__brawl.game.renderer;
      g.renderer.setPixelRatio(on ? window.__dpr0 : 1);
      g.resize();
    },
  };
  await page.evaluate(() => (window.__dpr0 = window.__brawl.game.renderer.renderer.getPixelRatio()));
  for (const [name, fn] of Object.entries(toggles)) {
    await page.evaluate(`(${fn.toString()})(false)`);
    await sleep(1500);
    await page.evaluate(() => window.__brawl.perf.reset());
    await sleep(4000);
    out[name] = await page.evaluate(() => window.__brawl.perf.report());
    await page.evaluate(`(${fn.toString()})(true)`);
    await sleep(500);
  }
  return out;
}
