// Shared bits for the e2e suite: target URL, browser launch with a fake (or missing / denied) camera,
// a tiny test runner, and a log of console errors, page errors and failed requests per page.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export { assert };

/** Site under test. E2E_BASE=http://localhost:5173 for a local build (tools then live under /test/). */
export const BASE = (process.env.E2E_BASE ?? "https://54-149-60-196.sslip.io").replace(/\/+$/, "");
export const FORGE = (process.env.E2E_FORGE ?? BASE).replace(/\/+$/, "");
export const WS = process.env.E2E_WS ?? `${BASE.replace(/^http/, "ws")}/ws`;
/** The access key the site ships in its bundle (src/config.ts). Not a secret. */
export const FORGE_KEY = process.env.E2E_FORGE_KEY ?? "720f66ea6f3cebda14050f8fa706cc1a";
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const SHOTS = path.join(ROOT, "research/e2e-shots");
/** A y4m of one person turning around (Chrome loops it as the webcam). Scan-success tests skip without it. */
export const PERSON_VIDEO = process.env.E2E_VIDEO ?? "";
/** Strict mode: known issues fail the run too. */
const STRICT = process.env.E2E_STRICT === "1";

fs.mkdirSync(SHOTS, { recursive: true });

/** The headless shell Playwright installed, or CHROME_PATH. */
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), ".cache/ms-playwright");
  try {
    const dir = fs.readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
    if (dir) {
      const exe = path.join(cache, dir, "chrome-headless-shell-linux64/chrome-headless-shell");
      if (fs.existsSync(exe)) return exe;
    }
  } catch {}
  return undefined; // let Playwright pick
}

/**
 * camera: 'fake' = Chrome's test pattern (nobody in view), 'person' = PERSON_VIDEO, 'none' = no camera device,
 * 'denied' = a camera exists but the permission prompt is refused.
 */
export async function launch({ camera = "fake", video = PERSON_VIDEO, args = [] } = {}) {
  const flags = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"];
  if (camera === "fake" || camera === "person") flags.push("--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream");
  if (camera === "person") {
    if (!video) throw new Error("camera 'person' needs E2E_VIDEO (a .y4m)");
    flags.push(`--use-file-for-fake-video-capture=${video}`);
  }
  if (camera === "denied") flags.push("--use-fake-device-for-media-stream", "--deny-permission-prompts");
  if (camera === "none") flags.push("--use-fake-ui-for-media-stream");
  return chromium.launch({ headless: true, executablePath: chromePath(), args: [...flags, ...args] });
}

/** New page with a log: console errors/warnings, uncaught errors, failed requests and HTTP >= 400. */
export async function open(browser, url, { viewport = { width: 1280, height: 800 }, wait = "load" } = {}) {
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000); // Playwright's default for actions is no timeout at all
  const log = { console: [], errors: [], failed: [], http: [], url };
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && log.console.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => log.errors.push(e.message.slice(0, 300)));
  page.on("requestfailed", (r) => log.failed.push(`${r.failure()?.errorText} ${r.url()}`));
  page.on("response", (r) => r.status() >= 400 && log.http.push(`${r.status()} ${r.url()}`));
  page.log = log;
  const t0 = Date.now();
  if (url) await page.goto(url, { waitUntil: wait, timeout: 60_000 });
  log.loadMs = Date.now() - t0;
  return page;
}

export async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  return path.relative(ROOT, file);
}

// ---- runner ---------------------------------------------------------------------------------------------

const results = [];

/**
 * test(name, fn, { known: 'E2E-07' }) marks a test that fails because of a reported, unfixed issue: it prints
 * KNOWN and doesn't fail the run (E2E_STRICT=1 makes it fail). If it starts passing, it prints FIXED?.
 */
export async function test(name, fn, { known, skip } = {}) {
  if (skip) {
    results.push({ name, status: "skip", why: skip });
    console.log(`skip  ${name} (${skip})`);
    return;
  }
  const t0 = Date.now();
  try {
    await fn();
    const status = known ? "fixed" : "ok";
    results.push({ name, status, ms: Date.now() - t0 });
    console.log(`${known ? "FIXED?" : "ok   "} ${name} (${Date.now() - t0} ms)${known ? ` [${known} passes now]` : ""}`);
  } catch (err) {
    const status = known ? "known" : "fail";
    results.push({ name, status, ms: Date.now() - t0, error: err.message });
    console.log(`${known ? "KNOWN" : "FAIL "} ${name} (${Date.now() - t0} ms)${known ? ` [${known}]` : ""}\n      ${String(err.message).split("\n").slice(0, 4).join("\n      ")}`);
  }
}

export function note(msg) {
  console.log(`      · ${msg}`);
}

/** Print totals and set the exit code. Call once at the end of a file. */
export function done(label) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const failed = count("fail") + (STRICT ? count("known") : 0);
  console.log(`\n${label}: ${count("ok")} ok, ${count("fail")} failed, ${count("known")} known issues, ${count("fixed")} fixed?, ${count("skip")} skipped`);
  process.exitCode = failed ? 1 : 0;
  return results;
}

/** fetch with a timeout that never throws on HTTP errors; returns { status, type, text, json, ms } or { error }. */
export async function http(url, init = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), ...init });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, type: res.headers.get("content-type") ?? "", headers: res.headers, text, json, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, error: String(err.cause?.code ?? err.message), ms: Date.now() - t0 };
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
