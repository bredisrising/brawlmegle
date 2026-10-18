/**
 * Brawlegle forge server: scan frames in, fighter out (brief, model sheet, card art; 3D model later).
 * Holds the API keys so the browser never sees them. Matches src/forge/forge.ts:
 *
 *   POST /api/forge              { name, username?, frames: [front, left, right] }  ->  { id }
 *   GET  /api/forge/:id          ->  ForgedFighter (+ sheetUrl, timings, error)
 *   GET  /api/fighters           ->  ready fighters, newest first
 *   GET  /api/profiles/:username ->  { username, fighter: latest ready fighter | null, forging: id | null }
 *
 * Usernames are a light "log in": type yours on any laptop and your fighter comes back. Fighters are saved
 * under FORGE_DATA (default data/) in <id>/. A dev page for testing likeness is at /.
 * When exposed publicly, set FORGE_ACCESS_KEY (clients send it as x-forge-key) and keep the hourly/daily caps.
 */
import "./env.js";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream";
import { runForge, models, commentate, speak } from "./pipeline.js";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is missing. Put it in the repo root .env");
  process.exit(1);
}

const PORT = Number(process.env.FORGE_PORT ?? 8787);
const BIND = process.env.FORGE_BIND ?? "127.0.0.1";
const MAX_ACTIVE = Number(process.env.FORGE_MAX_ACTIVE ?? 3);
const ALLOWED_ORIGINS = (
  process.env.FORGE_ALLOWED_ORIGINS ??
  "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,https://54-149-60-196.sslip.io"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_BODY_BYTES = 25 * 1024 * 1024;
/** Files anyone may download. The raw scan photos (front/left/right) stay private: fighter ids are public. */
const FILES = /^(sheet|card)\.png$|^(model|rigged)\.glb$/;
const DATA = process.env.FORGE_DATA ? new URL(`file://${process.env.FORGE_DATA.replace(/\/?$/, "/")}`) : new URL("./data/", import.meta.url);
const ACCESS_KEY = process.env.FORGE_ACCESS_KEY ?? "";
const MAX_PER_HOUR = Number(process.env.FORGE_MAX_PER_HOUR ?? 40);
const MAX_PER_DAY = Number(process.env.FORGE_MAX_PER_DAY ?? 200);
const USERNAME = /^[a-z0-9_.-]{1,24}$/;
/**
 * Usernames are case-insensitive and trimmed. Returns null if it isn't a usable username. All dots is out:
 * `/api/profiles/..` collapses to `/api/` in the URL, so that profile could never be looked up.
 */
const normalizeUsername = (raw) => {
  const u = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return USERNAME.test(u) && !/^\.+$/.test(u) ? u : null;
};
const devPage = fs.readFileSync(new URL("./public/index.html", import.meta.url));

/** @type {Map<string, object>} */
const fighters = new Map();
/** Forge requests that passed the caps and are still uploading. They count against the caps too. */
let uploading = 0;
fs.mkdirSync(DATA, { recursive: true });
for (const id of fs.readdirSync(DATA)) {
  try {
    const fighter = JSON.parse(fs.readFileSync(new URL(`${id}/fighter.json`, DATA), "utf8"));
    if (fighter.status === "forging" || fighter.status === "scanning") {
      fighter.status = "failed";
      fighter.error = "server restarted mid-forge";
    }
    fighters.set(id, fighter);
  } catch {}
}

function storeFor(fighter) {
  const dir = new URL(`${fighter.id}/`, DATA);
  fs.mkdirSync(dir, { recursive: true });
  return {
    save: () => fs.writeFileSync(new URL("fighter.json", dir), JSON.stringify(fighter, null, 2)),
    write: (file, data) => {
      fs.writeFileSync(new URL(file, dir), data);
      return `/api/forge/${fighter.id}/${file}`;
    },
  };
}

/** Accepts a data URL or bare base64; returns bytes and a type, or null if it isn't a JPEG/PNG. */
function decodeImage(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const data = Buffer.from(value.replace(/^data:image\/\w+;base64,/, ""), "base64");
  if (data[0] === 0xff && data[1] === 0xd8) return { data, type: "image/jpeg" };
  if (data[0] === 0x89 && data[1] === 0x50) return { data, type: "image/png" };
  return null;
}

/** Fighter JSON with absolute URLs, so the game can use them directly. */
function view(fighter, base) {
  const out = { ...fighter };
  for (const key of ["sheetUrl", "cardUrl", "glbUrl", "modelUrl"]) if (out[key]?.startsWith("/")) out[key] = base + out[key];
  return out;
}

/** A sliding-window cap: at most `max` calls per `windowMs` (the commentators spend OpenAI credits too). */
function limiter(max, windowMs) {
  const times = [];
  return () => {
    const now = Date.now();
    while (times.length && now - times[0] > windowMs) times.shift();
    if (times.length >= max) return false;
    times.push(now);
    return true;
  };
}
const commentaryAllowed = limiter(Number(process.env.FORGE_MAX_COMMENTARY ?? 60), 10 * 60_000);
const ttsAllowed = limiter(Number(process.env.FORGE_MAX_TTS ?? 200), 10 * 60_000);
/** TTS clips by voice + text: template lines repeat every match, so most calls are free and instant. */
const ttsCache = new Map();

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(Object.assign(new Error("bad json"), { status: 400 }));
      }
    });
    req.on("error", reject);
    // An upload cut off halfway must settle too, or it would hold its forge slot forever.
    req.on("close", () => reject(Object.assign(new Error("upload aborted"), { status: 400 })));
  });
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const base = process.env.FORGE_PUBLIC_URL ?? `http://${req.headers.host}`;
  const parts = url.pathname.split("/").filter(Boolean);

  // Only listed page origins may call the API from a browser. The JSON content type forces a
  // preflight, so other sites can't trigger (paid) forges either.
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET, POST");
    res.setHeader("access-control-allow-headers", "content-type, x-forge-key");
    // Chrome/Edge ask before a public https page (the hosted scan page) talks to this machine's localhost.
    if (req.headers["access-control-request-private-network"] && origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader("access-control-allow-private-network", "true");
    }
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(devPage);
  }
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, models });

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "profiles" && parts.length === 3) {
    let raw = "";
    try {
      raw = decodeURIComponent(parts[2]);
    } catch {}
    const username = normalizeUsername(raw);
    if (!username) return json(res, 400, { error: "usernames are 1-24 letters, digits, _ . -" });
    const mine = [...fighters.values()].filter((f) => f.username === username).sort((a, b) => b.createdAt - a.createdAt);
    const ready = mine.find((f) => f.status === "ready");
    const forging = mine.find((f) => f.status === "forging" || f.status === "scanning");
    return json(res, 200, { username, fighter: ready ? view(ready, base) : null, forging: forging?.id ?? null });
  }

  /** Every forge spends OpenAI and Tripo credits: cap them. Null when there's room. */
  function capacityError() {
    const active = [...fighters.values()].filter((f) => f.status === "forging" || f.status === "scanning").length + uploading;
    if (active >= MAX_ACTIVE) return `${active} forges already running, try again in a minute`;
    const now = Date.now();
    const recent = [...fighters.values()].filter((f) => now - f.createdAt < 86_400_000);
    const lastHour = recent.filter((f) => now - f.createdAt < 3_600_000).length;
    if (lastHour + uploading >= MAX_PER_HOUR || recent.length + uploading >= MAX_PER_DAY) return "forge limit reached for now, try again later";
    return null;
  }

  if (req.method === "GET" && url.pathname === "/api/fighters") {
    const ready = [...fighters.values()].filter((f) => f.status === "ready").sort((a, b) => b.createdAt - a.createdAt);
    return json(res, 200, ready.map((f) => view(f, base)));
  }

  // Commentators: one or two LLM-written lines for a moment of the fight (SPEC "Commentators").
  if (req.method === "POST" && url.pathname === "/api/commentary") {
    if (ACCESS_KEY && req.headers["x-forge-key"] !== ACCESS_KEY) return json(res, 403, { error: "bad forge key" });
    if (!commentaryAllowed()) return json(res, 429, { error: "commentators are resting" });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, err.status ?? 400, { error: err.message });
    }
    if (!body || typeof body.moment !== "string") return json(res, 400, { error: "send { moment, fighters }" });
    const cast = {};
    for (const id of ["p1", "p2"]) {
      const f = body.fighters?.[id];
      if (!f || typeof f.name !== "string") continue;
      // The forge's brief (archetype, outfit, signature details) makes the lines specific; never the photos.
      const brief = typeof f.id === "string" ? fighters.get(f.id)?.brief : undefined;
      cast[id] = { name: f.name.slice(0, 40), ...(brief ? { brief: JSON.stringify(brief).slice(0, 1200) } : {}) };
    }
    try {
      const lines = await commentate({ moment: body.moment.slice(0, 400), fighters: cast, hour: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) });
      return json(res, 200, { lines });
    } catch (err) {
      console.warn("commentary failed:", err.message);
      return json(res, 502, { error: "commentary unavailable" });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/tts") {
    if (ACCESS_KEY && req.headers["x-forge-key"] !== ACCESS_KEY) return json(res, 403, { error: "bad forge key" });
    const text = (url.searchParams.get("text") ?? "").slice(0, 160);
    const voice = url.searchParams.get("voice") === "B" ? "B" : "A";
    if (!text.trim()) return json(res, 400, { error: "no text" });
    const key = `${voice}|${text}`;
    let audio = ttsCache.get(key);
    if (!audio) {
      if (!ttsAllowed()) return json(res, 429, { error: "voices are resting" });
      try {
        audio = await speak(text, voice);
      } catch (err) {
        console.warn("tts failed:", err.message);
        return json(res, 502, { error: "voice unavailable" });
      }
      ttsCache.set(key, audio);
      if (ttsCache.size > 400) ttsCache.delete(ttsCache.keys().next().value);
    }
    res.writeHead(200, { "content-type": "audio/mpeg", "content-length": audio.length, "cache-control": "public, max-age=86400" });
    return res.end(audio);
  }

  // Whether a forge would be accepted right now, so the game can say so before the player spends ~20 s scanning.
  if (req.method === "GET" && url.pathname === "/api/capacity") {
    const full = capacityError();
    return json(res, 200, full ? { ok: false, error: full } : { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/forge") {
    if (!req.headers["content-type"]?.startsWith("application/json")) return json(res, 415, { error: "send JSON" });
    if (ACCESS_KEY && req.headers["x-forge-key"] !== ACCESS_KEY) return json(res, 403, { error: "bad forge key" });
    const full = capacityError();
    if (full) return json(res, 429, { error: full });
    // Hold the slot while the photos upload, so parallel requests can't all get past the caps above.
    uploading++;
    let body;
    try {
      body = await readJson(req);
    } finally {
      uploading--;
    }
    if (!body || typeof body !== "object") return json(res, 400, { error: "send a JSON object" });
    const frames = Array.isArray(body.frames) ? body.frames.map(decodeImage) : [];
    if (frames.length < 1 || frames.length > 3 || frames.includes(null)) {
      return json(res, 400, { error: "frames must be 1 to 3 JPEG or PNG images, base64 or data URLs" });
    }
    const fighter = {
      id: crypto.randomUUID(),
      name: typeof body.name === "string" ? body.name.slice(0, 40) : "",
      username: normalizeUsername(body.username),
      status: "scanning",
      createdAt: Date.now(),
      timings: {},
    };
    fighters.set(fighter.id, fighter);
    const store = storeFor(fighter);
    const names = ["front", "left", "right"];
    frames.forEach((f, i) => store.write(`${names[i]}.${f.type === "image/png" ? "png" : "jpg"}`, f.data));
    store.save();
    runForge(fighter, frames, store)
      .then(() => console.log(`forge ${fighter.id.slice(0, 8)} ${fighter.status}`, fighter.timings, fighter.error ?? ""))
      .catch((err) => console.error(`forge ${fighter.id.slice(0, 8)} crashed:`, err));
    return json(res, 202, { id: fighter.id });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "forge" && parts.length >= 3) {
    const fighter = fighters.get(parts[2]);
    if (!fighter) return json(res, 404, { error: "no such fighter" });
    if (parts.length === 3) return json(res, 200, view(fighter, base));
    if (parts.length === 4 && FILES.test(parts[3])) {
      const file = new URL(`${fighter.id}/${parts[3]}`, DATA);
      if (!fs.existsSync(file)) return json(res, 404, { error: "not ready" });
      const type = parts[3].endsWith(".png") ? "image/png" : parts[3].endsWith(".glb") ? "model/gltf-binary" : "image/jpeg";
      // A forge's files are written once and never change (a rescan is a new id): browsers can keep them.
      res.writeHead(200, {
        "content-type": type,
        "content-length": fs.statSync(file).size,
        "cache-control": "public, max-age=604800, immutable",
      });
      // pipeline() closes the file when a download is cut off, and a read error can't crash the server.
      return pipeline(fs.createReadStream(file), res, () => {});
    }
  }

  json(res, 404, { error: "not found" });
}

http
  .createServer((req, res) =>
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, err.status ?? 500, { error: err.message });
    }),
  )
  .listen(PORT, BIND, () => {
    console.log(`forge on http://${BIND}:${PORT} (brief ${models.brief}, sheet ${models.sheet}, card ${models.card} @ ${models.quality}, 3D ${models.threeD})`);
  });
