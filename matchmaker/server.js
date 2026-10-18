/**
 * Brawlegle matchmaker: pairs two players and relays their WebRTC signaling
 * (offer, answer, ICE candidates) until they connect to each other directly.
 * Game traffic never goes through here.
 *
 * It also hands out short-lived TURN credentials, for networks where a direct
 * connection fails and coturn has to relay. Protocol: see README.md.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 3000);
const BIND = process.env.BIND ?? "127.0.0.1";
const TURN_HOST = process.env.TURN_HOST ?? "";
const TURN_SECRET = process.env.TURN_SECRET ?? "";
const TURN_TTL_S = Number(process.env.TURN_TTL_S ?? 6 * 60 * 60);
/** Comma-separated page origins allowed to connect. Empty allows any. */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_CLIENTS = 2000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 200;
const HEARTBEAT_MS = 30_000;
const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/;

const testPage = fs.readFileSync(new URL("./public/index.html", import.meta.url));

// Labeled movement samples from the intent tuner's guided test (pose points only, never video), used to
// train the move reader. Capped so a misbehaving client can't fill the disk.
const SAMPLES_DIR = process.env.SAMPLES_DIR ?? "";
const MAX_SAMPLE_BYTES = 12 * 1024 * 1024;
const MAX_SAMPLES_BYTES_TOTAL = 2 * 1024 * 1024 * 1024;
let samplesBytes = 0;
if (SAMPLES_DIR) {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  for (const f of fs.readdirSync(SAMPLES_DIR)) samplesBytes += fs.statSync(`${SAMPLES_DIR}/${f}`).size;
}

function saveSample(req, res) {
  const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
  if (!SAMPLES_DIR) return res.writeHead(503, cors).end(JSON.stringify({ error: "samples disabled" }));
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_SAMPLE_BYTES) req.destroy();
    else chunks.push(c);
  });
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    let header;
    try {
      header = JSON.parse(body.toString("utf8", 0, Math.min(body.length, 200_000)).split("\n")[0]);
    } catch {
      return res.writeHead(400, cors).end(JSON.stringify({ error: "first line must be a JSON header" }));
    }
    // A bare `null` header used to throw here and take the whole matchmaker (and every room) down.
    if (!Array.isArray(header?.labels)) return res.writeHead(400, cors).end(JSON.stringify({ error: "header needs labels" }));
    if (samplesBytes + body.length > MAX_SAMPLES_BYTES_TOTAL) return res.writeHead(507, cors).end(JSON.stringify({ error: "storage full" }));
    // Reserve the space now, so parallel uploads can't all squeeze in under the cap.
    samplesBytes += body.length;
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}.jsonl`;
    fs.writeFile(`${SAMPLES_DIR}/${name}`, body, (err) => {
      if (err) {
        samplesBytes -= body.length;
        return res.writeHead(500, cors).end(JSON.stringify({ error: "write failed" }));
      }
      res.writeHead(201, cors).end(JSON.stringify({ ok: true, name }));
    });
  });
}

/**
 * @typedef {object} Client
 * @property {string} id
 * @property {import("ws").WebSocket} ws
 * @property {Client | null} peer
 * @property {null | "queue" | string} waiting  "queue" for a random match, or a room code
 * @property {string | null} hostCode  room this client hosts (host/join flow)
 * @property {boolean} alive
 * @property {number} msgs
 * @property {number} windowStart
 */

/** @type {Set<Client>} */
const clients = new Set();
/** Players waiting for a random stranger, oldest first. @type {Set<Client>} */
const queue = new Set();
/** Private rooms with one player waiting. @type {Map<string, Client>} */
const rooms = new Map();
/** Host/join flow: rooms keyed by a short code, held by the host for as long as it's connected. @type {Map<string, Client>} */
const hosted = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
/**
 * A host that loses its socket (Wi-Fi blip, server restart) sends `{type: "host", code, token}` to take its
 * code back, so the client's rejoin-with-the-same-code still finds it. With TURN_SECRET set, tokens survive restarts.
 */
const ROOM_SECRET = TURN_SECRET || crypto.randomBytes(32).toString("hex");
const roomToken = (code) => crypto.createHmac("sha256", ROOM_SECRET).update(`room:${code}`).digest("base64url");
function ownsCode(code, token) {
  if (typeof code !== "string" || typeof token !== "string" || !/^[A-Za-z2-9]{4}$/.test(code)) return false;
  const want = Buffer.from(roomToken(code.toUpperCase()));
  const got = Buffer.from(token);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** STUN/TURN servers for RTCPeerConnection, with fresh TURN credentials. */
function iceServers(id) {
  if (!TURN_HOST || !TURN_SECRET) return [{ urls: "stun:stun.l.google.com:19302" }];
  // coturn "use-auth-secret": username is "<expiry>:<id>", password is base64 HMAC-SHA1(secret, username).
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_S}:${id}`;
  const credential = crypto.createHmac("sha1", TURN_SECRET).update(username).digest("base64");
  return [
    { urls: `stun:${TURN_HOST}:3478` },
    {
      urls: [
        `turn:${TURN_HOST}:3478?transport=udp`,
        `turn:${TURN_HOST}:3478?transport=tcp`,
        `turns:${TURN_HOST}:443?transport=tcp`,
      ],
      username,
      credential,
    },
  ];
}

function send(client, msg) {
  if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
}

/** `error` for this server's test page, `message` for the game's Signaling client. */
function sendError(client, text) {
  send(client, { type: "error", error: text, message: text });
}

function stopWaiting(client) {
  if (client.waiting === "queue") queue.delete(client);
  else if (client.waiting && rooms.get(client.waiting) === client) rooms.delete(client.waiting);
  client.waiting = null;
}

function unpair(client) {
  const peer = client.peer;
  if (!peer) return;
  client.peer = null;
  peer.peer = null;
  send(peer, { type: "peer-left" });
}

/** `waiter` was already waiting, `arrival` just joined. The arrival makes the offer. */
function pair(waiter, arrival) {
  stopWaiting(waiter);
  stopWaiting(arrival);
  waiter.peer = arrival;
  arrival.peer = waiter;
  send(waiter, { type: "matched", peer: arrival.id, initiator: false, iceServers: iceServers(waiter.id) });
  send(arrival, { type: "matched", peer: waiter.id, initiator: true, iceServers: iceServers(arrival.id) });
}

function joinQueue(client) {
  const [waiter] = queue;
  if (waiter) return pair(waiter, client);
  queue.add(client);
  client.waiting = "queue";
  send(client, { type: "waiting" });
}

function joinRoom(client, room) {
  const waiter = rooms.get(room);
  if (waiter) return pair(waiter, client);
  rooms.set(room, client);
  client.waiting = room;
  send(client, { type: "waiting", room });
}

function reset(client) {
  unpair(client);
  stopWaiting(client);
}

/** Host/join flow: the host opens a room and shows its code; the room stays open so a dropped client can rejoin. */
function host(client, wanted, token) {
  reset(client);
  if (!client.hostCode) {
    let code;
    if (ownsCode(wanted, token)) {
      code = wanted.toUpperCase();
      // The old socket may not have timed out yet: the room moves to the new one.
      const stale = hosted.get(code);
      if (stale && stale !== client) {
        stopHosting(stale);
        reset(stale);
        stale.ws.close(4000, "room moved to a new connection");
      }
    } else {
      do code = Array.from(crypto.randomBytes(4), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
      while (hosted.has(code));
    }
    hosted.set(code, client);
    client.hostCode = code;
  }
  send(client, { type: "room", code: client.hostCode, token: roomToken(client.hostCode), iceServers: iceServers(client.id) });
}

function joinHosted(client, code) {
  const hostClient = hosted.get(code.toUpperCase());
  if (!hostClient || hostClient === client) return sendError(client, `No room with code ${code}`);
  if (hostClient.peer) return sendError(client, "That room already has two players");
  reset(client);
  hostClient.peer = client;
  client.peer = hostClient;
  // The host makes the offer. Both get fresh TURN credentials; the client can apply them with
  // pc.setConfiguration() because the offer only arrives after this message.
  send(hostClient, { type: "peer-joined", iceServers: iceServers(hostClient.id) });
  send(client, { type: "joined", code: hostClient.hostCode, iceServers: iceServers(client.id) });
}

function stopHosting(client) {
  if (client.hostCode && hosted.get(client.hostCode) === client) hosted.delete(client.hostCode);
  client.hostCode = null;
}

function onMessage(client, raw) {
  const now = Date.now();
  if (now - client.windowStart > RATE_WINDOW_MS) {
    client.windowStart = now;
    client.msgs = 0;
  }
  if (++client.msgs > RATE_MAX_MESSAGES) return client.ws.close(1008, "rate limit");

  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return sendError(client, "bad json");
  }

  switch (msg?.type) {
    case "host":
      host(client, msg.code, msg.token);
      break;
    case "join":
      if (typeof msg.code === "string") {
        if (ROOM_RE.test(msg.code)) joinHosted(client, msg.code);
        else sendError(client, "bad room code");
        break;
      }
      reset(client);
      if (msg.room === undefined) joinQueue(client);
      else if (typeof msg.room === "string" && ROOM_RE.test(msg.room)) joinRoom(client, msg.room);
      else sendError(client, "bad room");
      break;
    case "signal":
      if (client.peer) send(client.peer, { type: "signal", data: msg.data });
      break;
    case "next":
      reset(client);
      joinQueue(client);
      break;
    case "leave":
      reset(client);
      stopHosting(client);
      break;
    default:
      sendError(client, "unknown type");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/samples" && req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" });
    res.end();
  } else if (url.pathname === "/samples" && req.method === "POST") {
    saveSample(req, res);
  } else if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, clients: clients.size, waiting: queue.size, rooms: rooms.size, hosted: hosted.size }));
  } else if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(testPage);
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: MAX_MESSAGE_BYTES,
  verifyClient: ({ origin }) =>
    clients.size < MAX_CLIENTS && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)),
});

wss.on("connection", (ws) => {
  /** @type {Client} */
  const client = { id: crypto.randomUUID(), ws, peer: null, waiting: null, hostCode: null, alive: true, msgs: 0, windowStart: Date.now() };
  clients.add(client);
  ws.on("pong", () => (client.alive = true));
  ws.on("message", (raw) => onMessage(client, raw));
  ws.on("close", () => {
    reset(client);
    stopHosting(client);
    clients.delete(client);
  });
  ws.on("error", () => {}); // "close" always follows
  send(client, { type: "hello", id: client.id });
});

// Drop connections that stop answering pings, so dead players don't sit in the queue.
const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
}, HEARTBEAT_MS);

process.on("SIGTERM", () => {
  clearInterval(heartbeat);
  for (const client of clients) client.ws.close(1001, "restarting");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});

server.listen(PORT, BIND, () => {
  console.log(`matchmaker listening on ${BIND}:${PORT}, TURN ${TURN_HOST && TURN_SECRET ? TURN_HOST : "off"}`);
});
