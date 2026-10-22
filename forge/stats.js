/**
 * Stats for the owners' page (/stats/, public/stats/index.html): what players do in the game (its "moments", sent by
 * src/analytics.ts) next to what the servers know (fighters forged, ratings, who's online in matchmaking).
 *
 *   POST /api/moments       text/plain JSON { s, t, o?, e: [{ n, t, p? }] }  ->  204. No key (a beacon can't send one):
 *                           unknown moments are dropped, and each visit and the whole server have a budget.
 *   GET  /api/stats?days=7  x-stats-key: FORGE_STATS_KEY  ->  the report (report() below); &owners=1 counts our own
 *                           browsers too. 404 when FORGE_STATS_KEY isn't set.
 *
 * Kept in FORGE_DATA/stats/: moments-<day>.jsonl, one line per moment { at, s, n, p?, o? }, and online-<day>.jsonl,
 * the matchmaker's /health once a minute { at, c, q, r }. A day is a calendar day in STATS_TZ (Pacific by default).
 * No IP addresses, no names: `s` is a random id per browser tab. Files older than STATS_KEEP_DAYS go.
 */
import crypto from "node:crypto";
import fs from "node:fs";

/** The moments the game sends (src/analytics.ts `Moment`; test/server/stats.test.ts keeps the two in step). */
export const MOMENTS = new Set([
  "visit", "leave",
  "cam_ask", "cam_on", "cam_later", "cam_fail",
  "play", "fighter", "scan_start", "scan_sent", "forge_done", "setup_fail",
  "search", "bot_in", "matched",
  "fight_start", "match_end", "match_quit",
  "rematch", "next", "change_fighter", "title",
  "error",
]);

const SESSION = /^[a-z0-9]{6,32}$/;
const PARAM = /^[a-z_]{1,16}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS = 60;
const MAX_PARAMS = 16;
const MAX_TEXT = 120;
/** Per visit: more than this in 10 minutes is a loop or a script. */
const SESSION_BUDGET = 400;
/** The whole server, per hour, and one day's file: a flood can't fill the disk. */
const SERVER_BUDGET = 60_000;
const MAX_DAY_BYTES = 64 * 1024 * 1024;
const DAY_MS = 86_400_000;
/** A person's match: one against a stranger or a friend. */
const HUMAN = new Set(["stranger", "friend"]);

/** Reads a small body (the moments). Rejects past 64 KB. */
export function readSmall(req) {
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/** Whether `given` is the stats key (compared in constant time). */
export function statsKeyMatches(given, key) {
  if (!key || typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

function cleanParams(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return undefined;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(p)) {
    if (n >= MAX_PARAMS || !PARAM.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, MAX_TEXT);
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else continue;
    n++;
  }
  return n ? out : undefined;
}

const median = (xs) => pct(xs, 0.5);
function pct(xs, q) {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor(q * v.length))];
}
/** Counts as [{ key, n }], biggest first, at most `top`. */
function ranked(counts, top = 12) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, n]) => ({ key, n }));
}
function bump(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * @param {{ dir: URL, tz?: string, keepDays?: number, now?: () => number }} opts  `dir`: the stats folder (a file URL
 * ending in /); `now`: for tests.
 */
export function createStats({ dir, tz = "America/Los_Angeles", keepDays = 180, now = () => Date.now() }) {
  fs.mkdirSync(dir, { recursive: true });
  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  /** "2026-10-22": the calendar day (in `tz`) a time falls on. */
  const dayOf = (ms) => dayFmt.format(ms);
  const fileOf = (kind, day) => new URL(`${kind}-${day}.jsonl`, dir);
  const sessions = new Map(); // s -> { n, since }
  const server = { n: 0, since: 0 };
  const dayBytes = new Map(); // "moments-<day>" -> bytes so far

  function append(kind, day, lines) {
    const key = `${kind}-${day}`;
    if (!dayBytes.has(key)) {
      try {
        dayBytes.set(key, fs.statSync(fileOf(kind, day)).size);
      } catch {
        dayBytes.set(key, 0);
      }
    }
    const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    if (dayBytes.get(key) + text.length > MAX_DAY_BYTES) return false;
    dayBytes.set(key, dayBytes.get(key) + text.length);
    fs.appendFile(fileOf(kind, day), text, (err) => err && console.warn("stats write failed:", err.message));
    return true;
  }

  /** Keeps a batch of moments from one visit. Returns how many were kept. */
  function record(body) {
    if (!body || typeof body !== "object" || typeof body.s !== "string" || !SESSION.test(body.s) || !Array.isArray(body.e)) return 0;
    const t = now();
    if (t - server.since > 3_600_000) Object.assign(server, { n: 0, since: t });
    if (sessions.size > 20_000) for (const [s, v] of sessions) if (t - v.since > 600_000) sessions.delete(s);
    let budget = sessions.get(body.s);
    if (!budget || t - budget.since > 600_000) sessions.set(body.s, (budget = { n: 0, since: t }));
    const sentAt = typeof body.t === "number" && Number.isFinite(body.t) ? body.t : null;
    const byDay = new Map();
    let kept = 0;
    for (const e of body.e.slice(0, MAX_EVENTS)) {
      if (!e || typeof e !== "object" || !MOMENTS.has(e.n)) continue;
      if (budget.n >= SESSION_BUDGET || server.n >= SERVER_BUDGET) break;
      budget.n++;
      server.n++;
      // When it happened: the batch says how long ago (up to an hour; a beacon goes within seconds).
      const ago = sentAt !== null && typeof e.t === "number" && Number.isFinite(e.t) ? Math.min(Math.max(sentAt - e.t, 0), 3_600_000) : 0;
      const line = { at: t - Math.round(ago), s: body.s, n: e.n };
      const p = cleanParams(e.p);
      if (p) line.p = p;
      if (body.o === 1) line.o = 1;
      const day = dayOf(line.at);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(line);
      kept++;
    }
    for (const [day, lines] of byDay) append("moments", day, lines);
    return kept;
  }

  /** One matchmaker /health reading ({ clients, quick, rooms, ... }), kept as a line of online-<day>.jsonl. */
  function recordOnline(health) {
    if (!health || typeof health !== "object") return;
    const at = now();
    append("online", dayOf(at), [{ at, c: health.clients ?? 0, q: health.quick ?? 0, r: (health.rooms ?? 0) + (health.hosted ?? 0) }]);
  }

  function read(kind, day) {
    try {
      return fs
        .readFileSync(fileOf(kind, day), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** The last `days` calendar days, oldest first. */
  function lastDays(days) {
    const [y, m, d] = dayOf(now()).split("-").map(Number);
    return Array.from({ length: days }, (_, i) => new Date(Date.UTC(y, m - 1, d - (days - 1 - i))).toISOString().slice(0, 10));
  }

  /** Deletes stats files older than `keepDays`. */
  function prune() {
    const oldest = lastDays(keepDays)[0];
    for (const f of fs.readdirSync(dir)) {
      const m = /^(moments|online)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && m[2] < oldest) fs.rmSync(new URL(f, dir), { force: true });
    }
  }

  /**
   * The report for the stats page. `facts`: what the forge knows ({ fighters, roster, ratings, highlights }; roster: how
   * many the memory card lists, one per username), `live`: the
   * matchmaker's /health right now (or null).
   */
  function report({ days = 7, owners = false, facts = null, live = null } = {}) {
    days = Math.max(1, Math.min(90, Math.floor(Number(days)) || 7));
    const dayList = lastDays(days);
    const moments = dayList.flatMap((d) => read("moments", d)).filter((m) => owners || !m.o);

    // One visit (a browser tab: "Title" reloads keep its id) at a time.
    /** @type {Map<string, any[]>} */
    const bySession = new Map();
    for (const m of moments) {
      if (!bySession.has(m.s)) bySession.set(m.s, []);
      bySession.get(m.s).push(m);
    }
    const daily = new Map(dayList.map((d) => [d, { day: d, visits: 0, new: 0, camOn: 0, players: 0, scans: 0, forged: 0, matches: 0, human: 0, bot: 0, errors: 0, secs: [] }]));
    const funnel = { visited: 0, camOn: 0, fighter: 0, fight: 0, finished: 0, again: 0, human: 0 };
    const modes = new Map();
    const kinds = new Map();
    const browsers = new Map();
    const oses = new Map();
    const devices = new Map();
    const refs = new Map();
    const utms = new Map();
    const camFails = new Map();
    const setupFails = new Map();
    const errors = new Map();
    const opponents = new Map();
    const bots = new Map();
    const quality = new Map();
    const paths = new Map();
    const camera = { asked: 0, blocked: 0, on: 0, onAsked: 0, later: 0, failed: 0 };
    const scans = { started: 0, sent: 0, ok: 0, failed: 0, skipped: 0, setupFails: 0, scanSecs: [], forgeSecs: [], sides: new Map() };
    const mm = { searching: 0, searches: 0, botIns: 0, matched: 0, overBot: 0, waitHuman: [], waitBot: [] };
    const poseFps = [];
    const rtt = [];
    const sessionSecs = [];

    for (const list of bySession.values()) {
      list.sort((a, b) => a.at - b.at);
      const day = daily.get(dayOf(list[0].at));
      const visit = list.find((m) => m.n === "visit" && !m.p?.reload) ?? list.find((m) => m.n === "visit");
      const has = (n) => list.some((m) => m.n === n);
      const ends = list.filter((m) => m.n === "match_end");
      const leaves = list.filter((m) => m.n === "leave");
      const secs = leaves.length ? leaves.reduce((sum, m) => sum + (m.p?.secs ?? 0), 0) : Math.round((list.at(-1).at - list[0].at) / 1000);
      sessionSecs.push(secs);
      funnel.visited++;
      if (has("cam_on")) funnel.camOn++;
      if (has("fighter")) funnel.fighter++;
      if (has("fight_start")) funnel.fight++;
      if (ends.length) funnel.finished++;
      if (ends.length >= 2) funnel.again++;
      if (ends.some((m) => HUMAN.has(m.p?.opp))) funnel.human++;
      if (visit?.p) {
        bump(browsers, visit.p.browser ?? "other");
        bump(oses, visit.p.os ?? "other");
        bump(devices, visit.p.device ?? "other");
        bump(refs, visit.p.ref || "(direct)");
        if (visit.p.utm) bump(utms, visit.p.utm);
      }
      for (const mode of new Set(list.filter((m) => m.n === "play").map((m) => m.p?.mode ?? "?"))) bump(modes, mode);
      if (list.some((m) => m.n === "search")) mm.searching++;
      // The camera, per visit ("Title" reloads the page, and the title screen checks the camera again).
      const cam = (n) => list.filter((m) => m.n === n);
      if (cam("cam_ask").length) camera.asked++;
      if (cam("cam_ask").some((m) => m.p?.blocked)) camera.blocked++;
      if (cam("cam_on").length) camera.on++;
      if (cam("cam_on").some((m) => m.p?.asked)) camera.onAsked++;
      if (cam("cam_later").length) camera.later++;
      if (cam("cam_fail").length) camera.failed++;
      for (const why of new Set(cam("cam_fail").map((m) => m.p?.why ?? "?"))) bump(camFails, why);
      if (day) {
        day.visits++;
        if (visit?.p && visit.p.returning === false) day.new++;
        if (has("cam_on")) day.camOn++;
        if (has("fight_start")) day.players++;
        day.secs.push(secs);
      }
    }

    for (const m of moments) {
      const p = m.p ?? {};
      const day = daily.get(dayOf(m.at));
      switch (m.n) {
        case "fighter":
          bump(kinds, p.kind ?? "?");
          break;
        case "scan_start":
          scans.started++;
          if (day) day.scans++;
          break;
        case "scan_sent":
          scans.sent++;
          scans.scanSecs.push(p.secs);
          bump(scans.sides, String(p.sides ?? "?"));
          break;
        case "forge_done":
          if (p.skipped) scans.skipped++;
          else if (p.ok) {
            scans.ok++;
            scans.forgeSecs.push(p.secs);
            if (day) day.forged++;
          } else scans.failed++;
          break;
        case "setup_fail":
          scans.setupFails++;
          bump(setupFails, `${p.kind ?? "?"}: ${String(p.why ?? "?").slice(0, 90)}`);
          break;
        case "search":
          mm.searches++;
          break;
        case "bot_in":
          mm.botIns++;
          mm.waitBot.push(p.waited);
          break;
        case "matched":
          mm.matched++;
          if (p.over_bot) mm.overBot++;
          mm.waitHuman.push(p.waited);
          break;
        case "match_end": {
          const opp = p.opp ?? "?";
          const o = opponents.get(opp) ?? { opp, matches: 0, win: 0, loss: 0, draw: 0, quit: 0, secs: [] };
          o.matches++;
          if (p.result === "win" || p.result === "loss" || p.result === "draw") o[p.result]++;
          o.secs.push(p.secs);
          opponents.set(opp, o);
          if (opp === "bot" && p.bot) {
            const b = bots.get(p.bot) ?? { bot: p.bot, matches: 0, playerWins: 0, botWins: 0, draws: 0 };
            b.matches++;
            if (p.result === "win") b.playerWins++;
            else if (p.result === "loss") b.botWins++;
            else b.draws++;
            bots.set(p.bot, b);
          }
          if (typeof p.pose_fps === "number") poseFps.push(p.pose_fps);
          if (typeof p.quality === "number") bump(quality, String(p.quality));
          if (HUMAN.has(opp)) {
            if (typeof p.rtt === "number") rtt.push(p.rtt);
            if (p.path) bump(paths, p.path);
          }
          if (day) {
            day.matches++;
            if (HUMAN.has(opp)) day.human++;
            if (opp === "bot") day.bot++;
          }
          break;
        }
        case "match_quit": {
          const opp = p.opp ?? "?";
          const o = opponents.get(opp) ?? { opp, matches: 0, win: 0, loss: 0, draw: 0, quit: 0, secs: [] };
          o.quit++;
          opponents.set(opp, o);
          break;
        }
        case "error": {
          const key = `${p.kind ?? "?"}: ${String(p.msg ?? "").slice(0, 100)}`;
          const e = errors.get(key) ?? { error: key, n: 0, visits: new Set(), last: 0 };
          e.n++;
          e.visits.add(m.s);
          e.last = Math.max(e.last, m.at);
          errors.set(key, e);
          if (day) day.errors++;
          break;
        }
      }
    }

    // Who was online in matchmaking: the peak per day, and the last 24 hours in 15-minute steps.
    const online = dayList.flatMap((d) => read("online", d));
    const peaks = new Map();
    for (const o of online) {
      const d = dayOf(o.at);
      peaks.set(d, Math.max(peaks.get(d) ?? 0, o.c));
    }
    const since = now() - DAY_MS;
    const steps = new Map();
    for (const o of online) {
      if (o.at < since) continue;
      const slot = Math.floor(o.at / 900_000) * 900_000;
      const v = steps.get(slot) ?? { at: slot, c: 0, q: 0 };
      v.c = Math.max(v.c, o.c);
      v.q = Math.max(v.q, o.q);
      steps.set(slot, v);
    }

    return {
      generatedAt: now(),
      tz,
      days: dayList,
      owners,
      live: live ? { clients: live.clients ?? 0, quick: live.quick ?? 0, rooms: (live.rooms ?? 0) + (live.hosted ?? 0) } : null,
      daily: [...daily.values()].map(({ secs, ...d }) => ({ ...d, medianSecs: median(secs), peakOnline: peaks.get(d.day) ?? null })),
      funnel,
      camera: { ...camera, fails: ranked(camFails) },
      modes: ranked(modes),
      fighters: ranked(kinds),
      scans: {
        started: scans.started,
        sent: scans.sent,
        ok: scans.ok,
        failed: scans.failed,
        skipped: scans.skipped,
        setupFails: scans.setupFails,
        medianScanSecs: median(scans.scanSecs),
        medianForgeSecs: median(scans.forgeSecs),
        p90ForgeSecs: pct(scans.forgeSecs, 0.9),
        sides: ranked(scans.sides),
      },
      matchmaking: { visitsSearching: mm.searching, searches: mm.searches, botIns: mm.botIns, matched: mm.matched, overBot: mm.overBot, medianWaitHuman: median(mm.waitHuman), medianWaitBot: median(mm.waitBot) },
      opponents: [...opponents.values()].sort((a, b) => b.matches - a.matches).map(({ secs, ...o }) => ({ ...o, medianSecs: median(secs) })),
      bots: [...bots.values()].sort((a, b) => b.matches - a.matches),
      tech: {
        browsers: ranked(browsers),
        os: ranked(oses),
        devices: ranked(devices),
        medianPoseFps: median(poseFps),
        lowPoseFps: pct(poseFps, 0.1),
        quality: ranked(quality),
        medianRtt: median(rtt),
        paths: ranked(paths),
      },
      sources: { referrers: ranked(refs), utm: ranked(utms) },
      sessions: { median: median(sessionSecs), p75: pct(sessionSecs, 0.75) },
      setupFails: ranked(setupFails, 10),
      errors: [...errors.values()].sort((a, b) => b.n - a.n).slice(0, 15).map((e) => ({ error: e.error, n: e.n, visits: e.visits.size, last: e.last })),
      onlineDay: [...steps.values()].sort((a, b) => a.at - b.at),
      server: facts ? serverReport(facts, dayList, dayOf) : null,
    };
  }

  return { record, recordOnline, report, prune, dayOf };
}

/** What the forge itself knows: fighters forged per day (and how long a forge takes), ratings, highlights. */
function serverReport({ fighters, roster = null, ratings, highlights, placement = 5 }, dayList, dayOf) {
  const inRange = new Set(dayList);
  const perDay = new Map(dayList.map((d) => [d, { day: d, forges: 0, ready: 0, failed: 0, secs: [] }]));
  let ready = 0;
  const usernames = new Set();
  for (const f of fighters) {
    if (f.status === "ready") ready++;
    if (f.username) usernames.add(f.username);
    if (!f.createdAt || !inRange.has(dayOf(f.createdAt))) continue;
    const d = perDay.get(dayOf(f.createdAt));
    d.forges++;
    if (f.status === "ready") {
      d.ready++;
      const total = Object.values(f.timings ?? {}).reduce((sum, ms) => sum + (Number(ms) || 0), 0);
      if (total) d.secs.push(Math.round(total / 1000));
    } else if (f.status === "failed") d.failed++;
  }
  const byId = new Map(fighters.map((f) => [f.id, f]));
  const players = Object.entries(ratings).map(([key, r]) => ({
    player: key.startsWith("u:") ? key.slice(2) : byId.get(key.slice(2))?.name ?? key.slice(2, 10),
    rating: r.rating,
    rated: r.rated,
  }));
  return {
    fighters: roster ?? ready,
    usernames: usernames.size,
    forges: [...perDay.values()].map(({ secs, ...d }) => ({ ...d, medianSecs: median(secs) })),
    ratedPlayers: players.filter((p) => p.rated > 0).length,
    rankedPlayers: players.filter((p) => p.rated >= placement).length,
    ratedFights: Math.round(players.reduce((sum, p) => sum + p.rated, 0) / 2),
    topRatings: players.filter((p) => p.rated > 0).sort((a, b) => b.rating - a.rating).slice(0, 10),
    highlights,
  };
}
