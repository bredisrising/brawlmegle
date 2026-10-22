/**
 * Brawlegle forge server: scan frames in, fighter out (brief, model sheet, card art; 3D model later).
 * Holds the API keys so the browser never sees them. Matches src/forge/forge.ts:
 *
 *   POST /api/forge              { name, username?, frames: [front, left, right] }  ->  { id, ownerKey, deleteCode }
 *   GET  /api/forge/:id          ->  ForgedFighter (+ sheetUrl, timings, error)
 *   GET  /api/fighters           ->  ready fighters, newest first
 *   GET  /api/profiles/:username ->  { username, fighter: latest ready fighter | null, forging: id | null }
 *   POST /api/fighters/:id/delete { key }  ->  { ok, id, name }: deletes the fighter for good (403 wrong key, 404 gone)
 *   POST /api/fighters/delete    { code }  ->  { ok, id, name }: the same, with the delete code shown after the forge
 *   POST /api/fighters/claim     { code }  ->  { ok, id, name, username }: "it's me" on another laptop (the code proves it)
 *   POST /api/fighters/ticket    { username, proof }  ->  { ticket }: a one-time pass to rescan under that username from
 *                                another laptop's forge (a friend's room), so the owner key itself never leaves this browser
 *   POST /api/highlights         video/webm body + x-highlight-meta  ->  the highlight (see "Highlights" below)
 *   GET  /api/highlights         ->  { highlights: newest first }
 *   POST /api/moments, GET /api/stats  ->  the owners' stats page (see stats.js)
 *
 * Usernames are a light "log in": type yours on any laptop and your fighter comes back. A username someone owns (their
 * browser kept the owner key, or they have the code from after the forge) can't be rescanned without that proof, so
 * nobody takes over another player's name; anyone else picking that fighter plays it as a guest. Fighters are saved
 * under FORGE_DATA (default data/) in <id>/. A dev page for testing likeness is at /.
 * When exposed publicly, set FORGE_ACCESS_KEY (clients send it as x-forge-key) and keep the hourly/daily caps.
 */
import "./env.js";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { runForge, models, commentate, speak, voiceKey, wantGpu, gpuWantedAt } from "./pipeline.js";
import { available as rigCheckAvailable } from "./rigcheck.js";
import { adminKey, matchesHash, newOwner, normalizeCode, publicFighter, purgeFighter, sha256 } from "./owner.js";
import { createStats, readSmall, statsKeyMatches } from "./stats.js";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is missing. Put it in the repo root .env");
  process.exit(1);
}

const PORT = Number(process.env.FORGE_PORT ?? 8787);
const BIND = process.env.FORGE_BIND ?? "127.0.0.1";
const MAX_ACTIVE = Number(process.env.FORGE_MAX_ACTIVE ?? 3);
const ALLOWED_ORIGINS = (
  process.env.FORGE_ALLOWED_ORIGINS ??
  "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,https://54-149-60-196.sslip.io,https://brawlmegle.com,https://www.brawlmegle.com,https://brawlmegle.vip,https://www.brawlmegle.vip"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/** The public names nginx serves the forge under (FORGE_PUBLIC_HOSTS, comma-separated). */
const PUBLIC_HOSTS = new Set(
  (process.env.FORGE_PUBLIC_HOSTS ?? "54-149-60-196.sslip.io,brawlmegle.com,www.brawlmegle.com,brawlmegle.vip,www.brawlmegle.vip").split(",").map((s) => s.trim()).filter(Boolean),
);
const MAX_BODY_BYTES = 25 * 1024 * 1024;
/** Files anyone may download. The raw scan photos (front/left/right) stay private: fighter ids are public. The preview-*
 * and sheet-partial-* files are the forging screen's live preview (see pipeline.js). */
const FILES = /^(sheet|card)\.(png|webp)$|^(model|rigged)(\.orig)?\.glb$|^preview-(voxels\.bin|shape\.glb)$|^sheet-partial-\d\.webp$/;
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

// Fight records for the leaderboard: one shared record per fighter (by fighter id), so every laptop sees the same
// standings. Kept in FORGE_DATA/records.json (a file, so the fighter-folder loader above skips it).
const RECORDS_FILE = new URL("records.json", DATA);
/** @type {Record<string, {wins: number, losses: number, draws: number, streak: number, bestStreak: number, recentResults?: string[]}>} */
let records = {};
try {
  records = JSON.parse(fs.readFileSync(RECORDS_FILE, "utf8"));
} catch {}
/** Written synchronously (it's small and rare), so a write can't land after a deletion's and bring a record back. */
function saveRecords() {
  try {
    fs.writeFileSync(RECORDS_FILE, JSON.stringify(records));
  } catch (err) {
    console.warn("records save failed:", err.message);
  }
}
// Ratings (Elo) for the leaderboard: one per player, by username so a rescan keeps it (else by fighter id). Only
// rounds between two people move them, and everyone started at START_RATING on 2026-10-21. FORGE_DATA/ratings.json.
const RATINGS_FILE = new URL("ratings.json", DATA);
const START_RATING = 1000;
/** @type {Record<string, {rating: number, rated: number}>} */
let ratings = {};
try {
  ratings = JSON.parse(fs.readFileSync(RATINGS_FILE, "utf8"));
} catch {}
function saveRatings() {
  try {
    fs.writeFileSync(RATINGS_FILE, JSON.stringify(ratings));
  } catch (err) {
    console.warn("ratings save failed:", err.message);
  }
}
const ratingKey = (f) => (f.username ? `u:${f.username}` : `f:${f.id}`);
/** Elo's K: bigger over a player's first ten rated rounds, so a newcomer finds their level fast. */
const kFactor = (rated) => (rated < 10 ? 40 : 24);

/** One rated round: both players' ratings move by Elo (a draw scores half). Returns each side's before and after. */
function rateRound(a, b, winner) {
  const ra = ratings[ratingKey(a)] ?? { rating: START_RATING, rated: 0 };
  const rb = ratings[ratingKey(b)] ?? { rating: START_RATING, rated: 0 };
  const expected = 1 / (1 + 10 ** ((rb.rating - ra.rating) / 400));
  const score = !winner ? 0.5 : winner === "p1" ? 1 : 0;
  const na = { rating: Math.round(ra.rating + kFactor(ra.rated) * (score - expected)), rated: ra.rated + 1 };
  const nb = { rating: Math.round(rb.rating + kFactor(rb.rated) * (expected - score)), rated: rb.rated + 1 };
  ratings[ratingKey(a)] = na;
  ratings[ratingKey(b)] = nb;
  saveRatings();
  return { p1: { before: ra.rating, after: na.rating, rated: na.rated }, p2: { before: rb.rating, after: nb.rating, rated: nb.rated } };
}

/** Records with each fighter's player rating on it (the leaderboard sorts by it once enough players are rated). */
function withRatings(all) {
  const out = { ...all };
  for (const f of fighters.values()) {
    const r = ratings[ratingKey(f)];
    if (r && out[f.id]) out[f.id] = { ...out[f.id], rating: r.rating, rated: r.rated };
  }
  return out;
}

// The owners' stats page (stats.js): the game's moments in FORGE_DATA/stats/, and who's online in matchmaking (the
// matchmaker's /health on this machine, once a minute). FORGE_STATS_KEY unlocks GET /api/stats; unset, it's off.
const STATS_KEY = process.env.FORGE_STATS_KEY ?? "";
const MATCHMAKER_HEALTH = process.env.MATCHMAKER_HEALTH_URL ?? "http://127.0.0.1:3000/health";
const stats = createStats({ dir: new URL("stats/", DATA), tz: process.env.STATS_TZ || undefined, keepDays: Number(process.env.STATS_KEEP_DAYS ?? 180) });
stats.prune();
setInterval(() => stats.prune(), 6 * 3_600_000).unref();
/** The matchmaker's counts right now ({ clients, quick, rooms, hosted, ... }), or null when it doesn't answer. */
async function matchmakerHealth() {
  try {
    const res = await fetch(MATCHMAKER_HEALTH, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
if (STATS_KEY) setInterval(() => void matchmakerHealth().then((h) => h && stats.recordOnline(h)), 60_000).unref();
const statsTries = limiter(120, 10 * 60_000);

const seenMatches = new Set();
const matchesAllowed = (() => {
  const times = [];
  return () => {
    const now = Date.now();
    while (times.length && now - times[0] > 60_000) times.shift();
    if (times.length >= 30) return false;
    times.push(now);
    return true;
  };
})();

function storeFor(fighter) {
  const dir = new URL(`${fighter.id}/`, DATA);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir: fileURLToPath(dir),
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

/** Card/sheet WebP copies that exist (optimize.js writes them, the pipeline or optimize-all.js). */
const webpCopies = new Set();
/** The WebP copy of a card or sheet PNG when there is one: ~15x smaller, and what every browser can show. */
function preferWebp(url) {
  const m = /^\/api\/forge\/([\w-]+)\/(card|sheet)\.png$/.exec(url ?? "");
  if (!m) return url;
  const file = `${m[1]}/${m[2]}.webp`;
  if (!webpCopies.has(file)) {
    if (!fs.existsSync(new URL(file, DATA))) return url;
    webpCopies.add(file);
  }
  return url.replace(/\.png$/, ".webp");
}

/**
 * The memory card: ready fighters, newest first, one per username. A rescan replaces your fighter (its newest ready
 * one wins; the earlier ones stay on disk and keep working by id). `hidden: true` in a fighter.json takes it off the
 * list (e.g. a broken rig waiting for a fix), so the one before it shows instead.
 */
function current() {
  const seen = new Set();
  return [...fighters.values()]
    .filter((f) => f.status === "ready" && !f.hidden)
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((f) => !f.username || (!seen.has(f.username) && seen.add(f.username)));
}

/** Records with each username's earlier fighters folded into the one the memory card shows (see current()). */
function withLineage(all) {
  const out = { ...all };
  const shown = new Map(current().filter((f) => f.username).map((f) => [f.username, f.id]));
  for (const f of fighters.values()) {
    const head = f.username && shown.get(f.username);
    const r = all[f.id];
    if (!head || head === f.id || !r) continue;
    const h = out[head] ?? { wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0 };
    out[head] = {
      ...h,
      wins: h.wins + r.wins,
      losses: h.losses + r.losses,
      draws: h.draws + r.draws,
      bestStreak: Math.max(h.bestStreak, r.bestStreak),
      recentResults: h.recentResults?.length ? h.recentResults : r.recentResults ?? [],
    };
  }
  return out;
}

/** Delete tries, owner key and delete code apart, so someone guessing codes can't lock out an owner with a key. */
const deleteAllowed = { key: limiter(Number(process.env.FORGE_MAX_DELETES ?? 30), 10 * 60_000), code: limiter(Number(process.env.FORGE_MAX_DELETES ?? 30), 10 * 60_000) };
/** A username's fighters, newest first. */
const lineageOf = (username) => [...fighters.values()].filter((f) => f.username === username).sort((a, b) => b.createdAt - a.createdAt);
/** Whether anyone can prove they own this username (fighters from before owner keys have no key or code: free to claim). */
const isClaimed = (lineage) => lineage.some((f) => f.ownerKeyHash || f.deleteCodeHash);
/** Rescan tickets ("ticket" -> { username, until }): single use, a few minutes. */
const tickets = new Map();
const TICKET_MS = 10 * 60_000;
/**
 * Whether `proof` shows its sender owns this username: { id, key } (the scanning browser's owner key), { id, code }
 * (the code from after the forge) for one of its fighters, or { ticket } issued for it (used up here).
 */
function provesOwner(lineage, username, proof) {
  if (typeof proof?.ticket === "string") {
    const t = tickets.get(proof.ticket);
    tickets.delete(proof.ticket);
    return !!t && t.username === username && t.until > Date.now();
  }
  const f = lineage.find((x) => x.id === proof?.id);
  return !!f && (matchesHash(proof.key, f.ownerKeyHash) || matchesHash(normalizeCode(proof.code) ?? "", f.deleteCodeHash));
}

/** Fighters deleted since the server started: a K.O. clip of a fight that was still on when it went isn't kept. */
const deletedIds = new Set();
const ADMIN_KEY_HASH = sha256(adminKey(DATA));

/**
 * Deletes a fighter for good (owner.js purgeFighter: folder, record, highlights) and forgets it here, so the
 * username's previous fighter is the current one again. A forge still running is refused (it would keep writing
 * files); returns why as a string, else what went.
 */
function deleteFighter(fighter) {
  if (fighter.status === "forging" || fighter.status === "scanning") return "it's still forging: try again when it's done";
  fighters.delete(fighter.id);
  deletedIds.add(fighter.id);
  for (const kind of ["card", "sheet"]) webpCopies.delete(`${fighter.id}/${kind}.webp`);
  const gone = purgeFighter(DATA, fighter.id, { records, highlights });
  // The player's rating goes with their last fighter (a username with an earlier fighter left keeps it).
  const key = ratingKey(fighter);
  if (ratings[key] && ![...fighters.values()].some((f) => ratingKey(f) === key)) {
    delete ratings[key];
    saveRatings();
  }
  console.log(`deleted fighter ${fighter.id.slice(0, 8)}: ${gone.files} files, record ${gone.record ? "removed" : "none"}, ${gone.highlights} highlights`);
  return gone;
}

/** Fighter JSON with absolute URLs, so the game can use them directly. */
function view(fighter, base) {
  // Never the owner key's or delete code's hash.
  const out = publicFighter(fighter);
  for (const key of ["sheetUrl", "cardUrl"]) if (out[key]) out[key] = preferWebp(out[key]);
  for (const key of ["sheetUrl", "cardUrl", "glbUrl", "modelUrl", "sheetPartialUrl", "previewVoxelsUrl", "previewMeshUrl"]) {
    if (out[key]?.startsWith("/")) out[key] = base + out[key];
  }
  // Files are cached as immutable, so a GLB re-optimized in place (optimize-all.js) gets a new URL by its write time.
  for (const key of ["glbUrl", "modelUrl"]) {
    if (!out[key]) continue;
    try {
      out[key] += `?v=${Math.round(fs.statSync(new URL(`${fighter.id}/${out[key].split("/").pop()}`, DATA)).mtimeMs)}`;
    } catch {
      // Not written yet (still forging), or a URL that isn't one of ours.
    }
  }
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
const commentaryAllowed = limiter(Number(process.env.FORGE_MAX_COMMENTARY ?? 120), 10 * 60_000);
const ttsAllowed = limiter(Number(process.env.FORGE_MAX_TTS ?? 200), 10 * 60_000);
/**
 * TTS clips by voice + text, in memory and on disk (FORGE_DATA/tts): the same lines come back match after match, and
 * each new one costs voice credits. Both laptops ask for a line at about the same time: one voice call.
 */
const ttsCache = new Map();
const ttsPending = new Map();
const TTS_DIR = new URL("tts/", DATA);
fs.mkdirSync(TTS_DIR, { recursive: true });
function ttsRemember(key, audio) {
  ttsCache.set(key, audio);
  if (ttsCache.size > 400) ttsCache.delete(ttsCache.keys().next().value);
}
async function ttsClip(text, voice, urgent = true) {
  const key = `${voiceKey(voice)}|${text}`;
  const cached = ttsCache.get(key);
  if (cached) return cached;
  const file = new URL(`${crypto.createHash("sha1").update(key).digest("hex")}.mp3`, TTS_DIR);
  if (fs.existsSync(file)) {
    const audio = fs.readFileSync(file);
    ttsRemember(key, audio);
    return audio;
  }
  if (!ttsPending.has(key)) {
    if (!ttsAllowed()) throw Object.assign(new Error("voices are resting"), { status: 429 });
    const job = speak(text, voice, { urgent }).then((audio) => {
      ttsRemember(key, audio);
      fs.writeFile(file, audio, (err) => err && console.warn("tts save failed:", err.message));
      return audio;
    });
    ttsPending.set(key, job);
    job.finally(() => ttsPending.delete(key)).catch(() => {});
  }
  return ttsPending.get(key);
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
  // File URLs on the name the request came in on (brawlmegle.vip or the sslip.io one), so pages stay same-origin.
  const base = PUBLIC_HOSTS.has(req.headers.host ?? "") ? `https://${req.headers.host}` : process.env.FORGE_PUBLIC_URL ?? `http://${req.headers.host}`;
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
    res.setHeader("access-control-allow-headers", "content-type, x-forge-key, x-highlight-meta, x-stats-key");
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

  // The admin script (delete-fighter.mjs) on this machine: delete by id, no owner key needed. Not under /api/, so
  // nginx never forwards it; the key is in FORGE_DATA/.admin-key, readable only by whoever can delete the files anyway.
  if (req.method === "POST" && url.pathname === "/admin/delete") {
    if (!matchesHash(String(req.headers["x-admin-key"] ?? ""), ADMIN_KEY_HASH)) return json(res, 403, { error: "bad admin key" });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, err.status ?? 400, { error: err.message });
    }
    const fighter = fighters.get(body?.id);
    if (!fighter) return json(res, 404, { error: "no such fighter" });
    const deleted = deleteFighter(fighter);
    if (typeof deleted === "string") return json(res, 409, { error: deleted });
    return json(res, 200, { ok: true, ...deleted });
  }
  if (parts[0] === "api" && parts[1] === "highlights") return handleHighlights(req, res, parts, base);

  // The game's moments (src/analytics.ts, a beacon: text/plain, no key). Whatever's wrong with one, it's only counting.
  if (req.method === "POST" && url.pathname === "/api/moments") {
    let body = null;
    try {
      body = JSON.parse(await readSmall(req));
    } catch {}
    stats.record(body);
    res.writeHead(204);
    return res.end();
  }
  // The owners' stats page (public/stats/index.html in the game): the report, with the stats key.
  if (req.method === "GET" && url.pathname === "/api/stats") {
    if (!STATS_KEY) return json(res, 404, { error: "not found" });
    if (!statsTries()) return json(res, 429, { error: "too many tries, wait a few minutes" });
    if (!statsKeyMatches(req.headers["x-stats-key"], STATS_KEY)) return json(res, 403, { error: "bad stats key" });
    const report = stats.report({
      days: url.searchParams.get("days") ?? 7,
      owners: url.searchParams.get("owners") === "1",
      live: await matchmakerHealth(),
      facts: { fighters: [...fighters.values()], roster: current().length, ratings, highlights: highlights.length },
    });
    res.setHeader("cache-control", "no-store");
    return json(res, 200, report);
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "profiles" && parts.length === 3) {
    let raw = "";
    try {
      raw = decodeURIComponent(parts[2]);
    } catch {}
    const username = normalizeUsername(raw);
    if (!username) return json(res, 400, { error: "usernames are 1-24 letters, digits, _ . -" });
    const mine = [...fighters.values()].filter((f) => f.username === username).sort((a, b) => b.createdAt - a.createdAt);
    // A hidden fighter (a broken rig set aside) doesn't come back on a username "log in" either.
    const ready = mine.find((f) => f.status === "ready" && !f.hidden);
    const forging = mine.find((f) => f.status === "forging" || f.status === "scanning");
    return json(res, 200, { username, fighter: ready ? view(ready, base) : null, forging: forging?.id ?? null, owned: isClaimed(mine) });
  }

  /** Every forge spends OpenAI credits and GPU time: cap them. Null when there's room. */
  function capacityError() {
    const active = [...fighters.values()].filter((f) => f.status === "forging" || f.status === "scanning").length + uploading;
    if (active >= MAX_ACTIVE) return `${active} forges already running, try again in a minute`;
    const now = Date.now();
    const recent = [...fighters.values()].filter((f) => now - f.createdAt < 86_400_000);
    const lastHour = recent.filter((f) => now - f.createdAt < 3_600_000).length;
    if (lastHour + uploading >= MAX_PER_HOUR || recent.length + uploading >= MAX_PER_DAY) return "forge limit reached for now, try again later";
    return null;
  }

  if (req.method === "GET" && url.pathname === "/api/fighters") return json(res, 200, current().map((f) => view(f, base)));

  // "It's me" on another laptop: the code from after the forge proves the fighter is theirs (that browser keeps it).
  if (req.method === "POST" && url.pathname === "/api/fighters/claim") {
    if (ACCESS_KEY && req.headers["x-forge-key"] !== ACCESS_KEY) return json(res, 403, { error: "bad forge key" });
    if (!deleteAllowed.code()) return json(res, 429, { error: "too many tries, wait a few minutes" });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, err.status ?? 400, { error: err.message });
    }
    const code = normalizeCode(body?.code);
    if (!code) return json(res, 400, { error: "a fighter code is 16 letters and digits, like ABCD-EFGH-JKMN-PQRS" });
    let fighter;
    // Every fighter is checked (no early exit), each compare in constant time.
    for (const f of fighters.values()) if (matchesHash(code, f.deleteCodeHash) && !fighter) fighter = f;
    if (!fighter) return json(res, 403, { error: "that code doesn't match any fighter" });
    return json(res, 200, { ok: true, id: fighter.id, name: fighter.name, username: fighter.username ?? null });
  }

  // A rescan through another laptop's forge (a friend's room): the owner proves it here and hands that laptop only a
  // one-time ticket, never their owner key or code.
  if (req.method === "POST" && url.pathname === "/api/fighters/ticket") {
    if (ACCESS_KEY && req.headers["x-forge-key"] !== ACCESS_KEY) return json(res, 403, { error: "bad forge key" });
    if (!deleteAllowed.key()) return json(res, 429, { error: "too many tries, wait a few minutes" });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, err.status ?? 400, { error: err.message });
    }
    const username = normalizeUsername(body?.username);
    if (!username || typeof body?.proof?.ticket === "string" || !provesOwner(lineageOf(username), username, body?.proof)) return json(res, 403, { error: "not your username" });
    const now = Date.now();
    for (const [t, v] of tickets) if (v.until <= now) tickets.delete(t);
    const ticket = crypto.randomBytes(24).toString("base64url");
    tickets.set(ticket, { username, until: now + TICKET_MS });
    return json(res, 200, { ticket });
  }

  // "Delete my fighter": with the owner key the scanning browser kept, or the delete code from the screenshot.
  if (req.method === "POST" && parts[0] === "api" && parts[1] === "fighters" && parts.at(-1) === "delete" && parts.length <= 4) {
    if (ACCESS_KEY && req.headers["x-forge-key"] !== ACCESS_KEY) return json(res, 403, { error: "bad forge key" });
    if (!deleteAllowed[parts.length === 4 ? "key" : "code"]()) return json(res, 429, { error: "too many tries, wait a few minutes" });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, err.status ?? 400, { error: err.message });
    }
    let fighter;
    if (parts.length === 4) {
      fighter = fighters.get(parts[2]);
      if (!fighter) return json(res, 404, { error: "that fighter is already gone" });
      if (!matchesHash(body?.key, fighter.ownerKeyHash)) return json(res, 403, { error: "wrong owner key" });
    } else {
      const code = normalizeCode(body?.code);
      if (!code) return json(res, 400, { error: "a delete code is 16 letters and digits, like ABCD-EFGH-JKMN-PQRS" });
      // Every fighter is checked (no early exit), each compare in constant time.
      for (const f of fighters.values()) if (matchesHash(code, f.deleteCodeHash) && !fighter) fighter = f;
      if (!fighter) return json(res, 403, { error: "that code doesn't match any fighter (check it, or it's already deleted)" });
    }
    const deleted = deleteFighter(fighter);
    if (typeof deleted === "string") return json(res, 409, { error: deleted });
    return json(res, 200, { ok: true, id: fighter.id, name: fighter.name });
  }

  // Leaderboard: every fighter's record and its player's rating. A rescan's record carries the earlier fighters' under
  // that username too.
  if (req.method === "GET" && url.pathname === "/api/records") return json(res, 200, { records: withRatings(withLineage(records)) });

  // The host reports a finished round. Only rounds between two people count: a round with a side left out (the CPU,
  // which wears someone else's fighter) is ignored. Only forged fighters on this server get records (not stand-ins).
  // The answer says how both players' ratings moved (null when the round wasn't rated), for the K.O. screen.
  if (req.method === "POST" && url.pathname === "/api/matches") {
    if (ACCESS_KEY && req.headers["x-forge-key"] !== ACCESS_KEY) return json(res, 403, { error: "bad forge key" });
    if (!matchesAllowed()) return json(res, 429, { error: "slow down" });
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return json(res, err.status ?? 400, { error: err.message });
    }
    const match = typeof body?.matchId === "string" ? body.matchId.slice(0, 64) : "";
    const winner = body?.winner === "p1" || body?.winner === "p2" ? body.winner : null;
    if (!match || seenMatches.has(match)) return json(res, 200, { ok: true, duplicate: !!match });
    if (typeof body?.p1 !== "string" || typeof body?.p2 !== "string") return json(res, 200, { ok: true, ignored: "cpu round" });
    seenMatches.add(match);
    for (const side of ["p1", "p2"]) {
      const id = typeof body?.[side] === "string" ? body[side] : null;
      if (!id || !fighters.has(id)) continue;
      const r = records[id] ?? { wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0 };
      // The last seven rounds, newest last (the leaderboard's recent-form tiebreaker).
      const recentResults = [...(r.recentResults ?? []), !winner ? "draw" : winner === side ? "win" : "loss"].slice(-7);
      if (!winner) records[id] = { ...r, draws: r.draws + 1, streak: 0, recentResults };
      else if (winner === side) records[id] = { ...r, wins: r.wins + 1, streak: r.streak + 1, bestStreak: Math.max(r.bestStreak, r.streak + 1), recentResults };
      else records[id] = { ...r, losses: r.losses + 1, streak: 0, recentResults };
    }
    saveRecords();
    // Rated only between two fighters forged here, of two different players (not someone against their own rescan).
    const [a, b] = [fighters.get(body.p1), fighters.get(body.p2)];
    const rating = a && b && ratingKey(a) !== ratingKey(b) ? rateRound(a, b, winner) : null;
    // One line per counted round, so the standings can be rebuilt from the log if they ever need fixing.
    const moved = rating ? ` (${rating.p1.before}->${rating.p1.after}, ${rating.p2.before}->${rating.p2.after})` : "";
    console.log(`match ${body.p1.slice(0, 8)} vs ${body.p2.slice(0, 8)}: ${winner ?? "draw"}${moved}`);
    return json(res, 200, { ok: true, rating });
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
      const lines = await commentate({ moment: body.moment.slice(0, 400), fighters: cast });
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
    let audio;
    try {
      // Lines fetched ahead of the moment wait behind lines being said now.
      audio = await ttsClip(text, voice, url.searchParams.get("prefetch") !== "1");
    } catch (err) {
      if (err.status === 429) return json(res, 429, { error: err.message });
      console.warn("tts failed:", err.message);
      return json(res, 502, { error: "voice unavailable" });
    }
    res.writeHead(200, { "content-type": "audio/mpeg", "content-length": audio.length, "cache-control": "public, max-age=86400" });
    return res.end(audio);
  }

  // Whether a forge would be accepted right now, so the game can say so before the player spends ~20 s scanning.
  // It's also the cue to get the GPU box up: their forge reaches it in ~40 s.
  if (req.method === "GET" && url.pathname === "/api/capacity") {
    const full = capacityError();
    if (!full) wantGpu();
    return json(res, 200, full ? { ok: false, error: full } : { ok: true });
  }

  // For bingus's GPU waker (forge/gpu/waker.sh): has a forge wanted the GPU box in the last 10 minutes?
  if (req.method === "GET" && url.pathname === "/api/gpu/wanted") {
    const key = process.env.FORGE_GPU_WAKER_KEY;
    if (!key || req.headers["x-waker-key"] !== key) return json(res, 403, { error: "bad waker key" });
    return json(res, 200, { wanted: Date.now() - gpuWantedAt() < 10 * 60_000 });
  }

  if (req.method === "POST" && url.pathname === "/api/forge") {
    if (!req.headers["content-type"]?.startsWith("application/json")) return json(res, 415, { error: "send JSON" });
    if (ACCESS_KEY && req.headers["x-forge-key"] !== ACCESS_KEY) return json(res, 403, { error: "bad forge key" });
    const full = capacityError();
    if (full) return json(res, 429, { error: full });
    wantGpu();
    // Hold the slot while the photos upload, so parallel requests can't all get past the caps above.
    uploading++;
    let body;
    try {
      body = await readJson(req);
    } finally {
      uploading--;
    }
    if (!body || typeof body !== "object") return json(res, 400, { error: "send a JSON object" });
    // Someone else's username can't be taken over by rescanning under it: an owned name needs its owner's proof.
    const wanted = normalizeUsername(body.username);
    if (wanted) {
      const lineage = lineageOf(wanted);
      if (isClaimed(lineage) && !provesOwner(lineage, wanted, body.proof)) return json(res, 403, { error: "that username belongs to someone else", taken: true });
    }
    const frames = Array.isArray(body.frames) ? body.frames.map(decodeImage) : [];
    if (frames.length < 1 || frames.length > 3 || frames.includes(null)) {
      return json(res, 400, { error: "frames must be 1 to 3 JPEG or PNG images, base64 or data URLs" });
    }
    // The owner key and delete code go back once, in this response; only their hashes are kept (owner.js).
    const owner = newOwner();
    const fighter = {
      id: crypto.randomUUID(),
      name: typeof body.name === "string" ? body.name.slice(0, 40) : "",
      username: normalizeUsername(body.username),
      // "hq": the slower, sharper forge for showcase fighters (see HQ in pipeline.js).
      ...(body.quality === "hq" ? { quality: "hq" } : {}),
      status: "scanning",
      createdAt: Date.now(),
      timings: {},
      ownerKeyHash: owner.ownerKeyHash,
      deleteCodeHash: owner.deleteCodeHash,
    };
    fighters.set(fighter.id, fighter);
    const store = storeFor(fighter);
    const names = ["front", "left", "right"];
    frames.forEach((f, i) => store.write(`${names[i]}.${f.type === "image/png" ? "png" : "jpg"}`, f.data));
    store.save();
    runForge(fighter, frames, store)
      .then(() => console.log(`forge ${fighter.id.slice(0, 8)} ${fighter.status}`, fighter.timings, fighter.error ?? ""))
      .catch((err) => console.error(`forge ${fighter.id.slice(0, 8)} crashed:`, err));
    return json(res, 202, { id: fighter.id, ownerKey: owner.key, deleteCode: owner.code });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "forge" && parts.length >= 3) {
    const fighter = fighters.get(parts[2]);
    if (!fighter) return json(res, 404, { error: "no such fighter" });
    if (parts.length === 3) return json(res, 200, view(fighter, base));
    if (parts.length === 4 && FILES.test(parts[3])) {
      const file = new URL(`${fighter.id}/${parts[3]}`, DATA);
      if (!fs.existsSync(file)) return json(res, 404, { error: "not ready" });
      const type = { png: "image/png", webp: "image/webp", glb: "model/gltf-binary", bin: "application/octet-stream" }[parts[3].split(".").pop()] ?? "image/jpeg";
      // A forge's files are written once and never change (a rescan is a new id): browsers can keep them. (Only
      // optimize-all.js swaps an old GLB for its optimized version, once; a cached original still works.)
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

// ---------------------------------------------------------------------------------------------------------------
// Highlights: K.O. replays the game records on the laptop that ran the fight (src/game/HighlightRecorder.ts), shown
// as the reel on the title screen. Kept in FORGE_DATA/highlights/ (<id>.webm + index.json), newest HIGHLIGHT_KEEP.
//
//   POST /api/highlights   body: the clip (video/webm or video/mp4, up to FORGE_HIGHLIGHT_MAX_BYTES)
//                          x-forge-key, x-highlight-meta: URI-encoded JSON { p1, p2, winner, move, combo, roundTime,
//                          duration }, each side { id?, name, cpu? }  ->  201 the highlight; 422 for a round against
//                          the CPU (the reel is people beating people)
//   GET  /api/highlights   ->  { highlights: [{ id, url, createdAt, bytes, ...meta }] } newest first
//   GET  /api/highlights/<id>.webm  ->  the clip (immutable, range requests for <video>)
// ---------------------------------------------------------------------------------------------------------------
const HIGHLIGHTS = new URL("highlights/", DATA);
const HIGHLIGHTS_INDEX = new URL("index.json", HIGHLIGHTS);
const HIGHLIGHT_MAX_BYTES = Number(process.env.FORGE_HIGHLIGHT_MAX_BYTES ?? 6 * 1024 * 1024);
const HIGHLIGHT_KEEP = Number(process.env.FORGE_HIGHLIGHT_KEEP ?? 40);
/** One laptop makes at most one every ~20 s (a round plus its replay); this leaves room for a few booths at once. */
const highlightAllowed = limiter(Number(process.env.FORGE_MAX_HIGHLIGHTS ?? 20), 10 * 60_000);
const HIGHLIGHT_TYPES = { "video/webm": "webm", "video/mp4": "mp4" };
const HIGHLIGHT_FILE = /^([0-9a-f-]{36})\.(webm|mp4)$/;
fs.mkdirSync(HIGHLIGHTS, { recursive: true });
/** @type {object[]} newest first */
let highlights = [];
try {
  highlights = JSON.parse(fs.readFileSync(HIGHLIGHTS_INDEX, "utf8")).filter((h) => fs.existsSync(new URL(h.file, HIGHLIGHTS)));
  // Rounds against the CPU stopped being highlights: clear out any kept from before.
  const cpu = highlights.filter((h) => h.p1?.cpu || h.p2?.cpu);
  if (cpu.length) {
    highlights = highlights.filter((h) => !cpu.includes(h));
    for (const h of cpu) fs.rmSync(new URL(h.file, HIGHLIGHTS), { force: true });
    fs.writeFileSync(HIGHLIGHTS_INDEX, JSON.stringify(highlights));
    console.log(`highlights: removed ${cpu.length} rounds against the CPU`);
  }
} catch {}

/** Plain one-line text: no control characters, trimmed, capped. */
const cleanText = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");
const finite = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** The clip's metadata from the x-highlight-meta header, or a string saying what's wrong with it. */
function highlightMeta(header) {
  let m;
  try {
    m = JSON.parse(decodeURIComponent(String(header ?? "")));
  } catch {
    return "x-highlight-meta must be URI-encoded JSON";
  }
  if (!m || typeof m !== "object") return "x-highlight-meta must be an object";
  const side = (s) => {
    const name = cleanText(s?.name, 40);
    if (!name) return null;
    const id = typeof s.id === "string" && /^[\w-]{1,64}$/.test(s.id) ? s.id : undefined;
    return { ...(id ? { id } : {}), name, cpu: s.cpu === true };
  };
  const p1 = side(m.p1);
  const p2 = side(m.p2);
  if (!p1 || !p2) return "p1 and p2 need a name";
  if (m.winner !== "p1" && m.winner !== "p2") return "winner is p1 or p2";
  const move = typeof m.move === "string" ? m.move.trim().toLowerCase() : "";
  if (!/^[a-z][a-z _-]{0,23}$/.test(move)) return "move is a move name";
  if (!Number.isInteger(m.combo) || m.combo < 1 || m.combo > 99) return "combo is 1-99";
  if (!finite(m.roundTime, 0, 600)) return "roundTime is seconds";
  if (!finite(m.duration, 0.5, 30)) return "duration is 0.5-30 seconds";
  return { p1, p2, winner: m.winner, move, combo: m.combo, roundTime: Math.round(m.roundTime * 10) / 10, duration: Math.round(m.duration * 10) / 10 };
}

/** The request body as bytes, refused past `max` (by content-length up front, or while it streams). */
function readBytes(req, max) {
  return new Promise((resolve, reject) => {
    const tooBig = () => Object.assign(new Error(`too large (max ${max} bytes)`), { status: 413 });
    if (Number(req.headers["content-length"] ?? 0) > max) {
      req.resume();
      return reject(tooBig());
    }
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(tooBig());
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("close", () => reject(Object.assign(new Error("upload aborted"), { status: 400 })));
  });
}

/** Synchronous, like saveRecords: a deletion's rewrite of the index must be the last word. */
function saveHighlights() {
  try {
    fs.writeFileSync(HIGHLIGHTS_INDEX, JSON.stringify(highlights));
  } catch (err) {
    console.warn("highlights save failed:", err.message);
  }
}

const highlightView = ({ file, ...h }, base) => ({ ...h, url: `${base}/api/highlights/${file}` });

async function handleHighlights(req, res, parts, base) {
  if (req.method === "GET" && parts.length === 2) {
    res.setHeader("cache-control", "no-cache");
    return json(res, 200, { highlights: highlights.map((h) => highlightView(h, base)) });
  }

  if (req.method === "GET" && parts.length === 3) {
    const m = HIGHLIGHT_FILE.exec(parts[2]);
    const h = m && highlights.find((x) => x.file === parts[2]);
    if (!h) return json(res, 404, { error: "no such highlight" });
    const file = new URL(h.file, HIGHLIGHTS);
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return json(res, 404, { error: "no such highlight" });
    }
    // A clip never changes (a new one is a new id). <video> asks for byte ranges, Safari insists on them.
    const headers = {
      "content-type": m[2] === "mp4" ? "video/mp4" : "video/webm",
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=604800, immutable",
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      return pipeline(fs.createReadStream(file, { start, end }), res, () => {});
    }
    res.writeHead(200, { ...headers, "content-length": size });
    return pipeline(fs.createReadStream(file), res, () => {});
  }

  if (req.method === "POST" && parts.length === 2) {
    if (ACCESS_KEY && req.headers["x-forge-key"] !== ACCESS_KEY) return json(res, 403, { error: "bad forge key" });
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const ext = HIGHLIGHT_TYPES[type];
    if (!ext) return json(res, 415, { error: "send video/webm or video/mp4" });
    const meta = highlightMeta(req.headers["x-highlight-meta"]);
    if (typeof meta === "string") return json(res, 400, { error: meta });
    if (meta.p1.cpu || meta.p2.cpu) return json(res, 422, { error: "rounds against the CPU aren't highlights" });
    if (deletedIds.has(meta.p1.id) || deletedIds.has(meta.p2.id)) return json(res, 410, { error: "that fighter was deleted" });
    if (!highlightAllowed()) return json(res, 429, { error: "slow down" });
    let video;
    try {
      video = await readBytes(req, HIGHLIGHT_MAX_BYTES);
    } catch (err) {
      return json(res, err.status ?? 400, { error: err.message });
    }
    // The bytes must be the video they claim: WebM's EBML header, or an MP4 'ftyp' box.
    const webm = video.length > 4 && video.readUInt32BE(0) === 0x1a45dfa3;
    const mp4 = video.length > 12 && video.toString("latin1", 4, 8) === "ftyp";
    if ((ext === "webm" && !webm) || (ext === "mp4" && !mp4) || video.length < 1024) return json(res, 400, { error: "not a video" });
    const id = crypto.randomUUID();
    const h = { id, file: `${id}.${ext}`, createdAt: Date.now(), bytes: video.length, ...meta };
    fs.writeFileSync(new URL(h.file, HIGHLIGHTS), video);
    highlights.unshift(h);
    for (const old of highlights.splice(HIGHLIGHT_KEEP)) fs.rm(new URL(old.file, HIGHLIGHTS), { force: true }, () => {});
    saveHighlights();
    console.log(`highlight ${id.slice(0, 8)}: ${meta[meta.winner].name} ${meta.move} (${(video.length / 1e6).toFixed(2)} MB)`);
    return json(res, 201, highlightView(h, base));
  }

  return json(res, 404, { error: "not found" });
}

http
  .createServer((req, res) =>
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, err.status ?? 500, { error: err.message });
    }),
  )
  .listen(PORT, BIND, () => {
    console.log(`forge on http://${BIND}:${PORT} (brief ${models.brief}, sheet ${models.sheet}, card ${models.card} @ ${models.quality}, 3D ${models.threeD})`);
    // Every rigged GLB is posed and checked before it ships (forge/rigcheck.js); without its packages it can't be.
    rigCheckAvailable().then((ok) => (ok ? console.log("rig check on") : console.warn("rig check OFF: cd forge && npm ci")));
  });
