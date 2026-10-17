/**
 * Brawlegle forge server: scan frames in, fighter out (brief, model sheet, card art; 3D model later).
 * Holds the API keys so the browser never sees them. Matches src/forge/forge.ts:
 *
 *   POST /api/forge         { name, frames: [front, left, right] }  ->  { id }
 *   GET  /api/forge/:id     ->  ForgedFighter (+ sheetUrl, timings, error)
 *   GET  /api/fighters      ->  ready fighters, newest first
 *
 * Fighters are saved under data/<id>/. A dev page for testing likeness is at /.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { runForge, models } from "./pipeline.js";

for (const file of ["../.env", ".env"]) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is missing. Put it in the repo root .env");
  process.exit(1);
}

const PORT = Number(process.env.FORGE_PORT ?? 8787);
const BIND = process.env.FORGE_BIND ?? "127.0.0.1";
const MAX_ACTIVE = Number(process.env.FORGE_MAX_ACTIVE ?? 3);
const ALLOWED_ORIGINS = (
  process.env.FORGE_ALLOWED_ORIGINS ??
  "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const FILES = /^(front|left|right)\.(jpg|png)$|^(sheet|card)\.png$/;
const DATA = new URL("./data/", import.meta.url);
const devPage = fs.readFileSync(new URL("./public/index.html", import.meta.url));

/** @type {Map<string, object>} */
const fighters = new Map();
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
  for (const key of ["sheetUrl", "cardUrl", "glbUrl"]) if (out[key]?.startsWith("/")) out[key] = base + out[key];
  return out;
}

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
    res.setHeader("access-control-allow-headers", "content-type");
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(devPage);
  }
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, models });

  if (req.method === "GET" && url.pathname === "/api/fighters") {
    const ready = [...fighters.values()].filter((f) => f.status === "ready").sort((a, b) => b.createdAt - a.createdAt);
    return json(res, 200, ready.map((f) => view(f, base)));
  }

  if (req.method === "POST" && url.pathname === "/api/forge") {
    if (!req.headers["content-type"]?.startsWith("application/json")) return json(res, 415, { error: "send JSON" });
    const active = [...fighters.values()].filter((f) => f.status === "forging").length;
    if (active >= MAX_ACTIVE) return json(res, 429, { error: `${active} forges already running, try again in a minute` });
    const body = await readJson(req);
    const frames = Array.isArray(body.frames) ? body.frames.map(decodeImage) : [];
    if (frames.length < 1 || frames.length > 3 || frames.includes(null)) {
      return json(res, 400, { error: "frames must be 1 to 3 JPEG or PNG images, base64 or data URLs" });
    }
    const fighter = {
      id: crypto.randomUUID(),
      name: typeof body.name === "string" ? body.name.slice(0, 40) : "",
      status: "scanning",
      createdAt: Date.now(),
      timings: {},
    };
    fighters.set(fighter.id, fighter);
    const store = storeFor(fighter);
    const names = ["front", "left", "right"];
    frames.forEach((f, i) => store.write(`${names[i]}.${f.type === "image/png" ? "png" : "jpg"}`, f.data));
    store.save();
    runForge(fighter, frames, store).then(() =>
      console.log(`forge ${fighter.id.slice(0, 8)} ${fighter.status}`, fighter.timings, fighter.error ?? ""),
    );
    return json(res, 202, { id: fighter.id });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "forge" && parts.length >= 3) {
    const fighter = fighters.get(parts[2]);
    if (!fighter) return json(res, 404, { error: "no such fighter" });
    if (parts.length === 3) return json(res, 200, view(fighter, base));
    if (parts.length === 4 && FILES.test(parts[3])) {
      const file = new URL(`${fighter.id}/${parts[3]}`, DATA);
      if (!fs.existsSync(file)) return json(res, 404, { error: "not ready" });
      res.writeHead(200, { "content-type": parts[3].endsWith(".png") ? "image/png" : "image/jpeg" });
      return fs.createReadStream(file).pipe(res);
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
    console.log(`forge on http://${BIND}:${PORT} (brief ${models.brief}, images ${models.image} @ ${models.quality})`);
  });
