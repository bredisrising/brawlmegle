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

/**
 * @typedef {object} Client
 * @property {string} id
 * @property {import("ws").WebSocket} ws
 * @property {Client | null} peer
 * @property {null | "queue" | string} waiting  "queue" for a random match, or a room code
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
    return send(client, { type: "error", error: "bad json" });
  }

  switch (msg?.type) {
    case "join":
      reset(client);
      if (msg.room === undefined) joinQueue(client);
      else if (typeof msg.room === "string" && ROOM_RE.test(msg.room)) joinRoom(client, msg.room);
      else send(client, { type: "error", error: "bad room" });
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
      break;
    default:
      send(client, { type: "error", error: "unknown type" });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, clients: clients.size, waiting: queue.size, rooms: rooms.size }));
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
  const client = { id: crypto.randomUUID(), ws, peer: null, waiting: null, alive: true, msgs: 0, windowStart: Date.now() };
  clients.add(client);
  ws.on("pong", () => (client.alive = true));
  ws.on("message", (raw) => onMessage(client, raw));
  ws.on("close", () => {
    reset(client);
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
