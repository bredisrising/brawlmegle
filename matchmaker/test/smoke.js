// Starts the matchmaker on a spare port and checks pairing, relaying, rooms and TURN credentials.
// Usage: npm test, or MATCHMAKER_URL=wss://host/ws npm test to check a deployed server.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const SECRET = "test-secret";
let url = process.env.MATCHMAKER_URL;
let child;

if (!url) {
  const port = 30000 + Math.floor(Math.random() * 10000);
  child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), TURN_HOST: "turn.test", TURN_SECRET: SECRET },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  url = `ws://127.0.0.1:${port}/ws`;
}

/** Opens a client that records every message and can wait for the next one of a type. */
async function client() {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  return {
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (type) => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 3000);
      });
    },
    close: () => ws.close(),
  };
}

const room = `smoke-${crypto.randomUUID().slice(0, 8)}`;

try {
  // Private room: the first player waits, the second gets matched and makes the offer.
  const a = await client();
  const b = await client();
  const hello = await a.next("hello");
  a.send({ type: "join", room });
  assert.equal((await a.next("waiting")).room, room);
  b.send({ type: "join", room });
  const ma = await a.next("matched");
  const mb = await b.next("matched");
  assert.equal(ma.initiator, false);
  assert.equal(mb.initiator, true);
  assert.equal(mb.peer, hello.id);
  console.log("ok  room pairing");

  // Signals are relayed to the peer unchanged.
  b.send({ type: "signal", data: { description: { type: "offer", sdp: "x" } } });
  assert.deepEqual((await a.next("signal")).data, { description: { type: "offer", sdp: "x" } });
  console.log("ok  signal relay");

  // TURN credentials follow coturn's use-auth-secret scheme (local server only).
  const turn = ma.iceServers.find((s) => s.username);
  if (!process.env.MATCHMAKER_URL) {
    assert.ok(turn, "TURN entry present");
    const expected = crypto.createHmac("sha1", SECRET).update(turn.username).digest("base64");
    assert.equal(turn.credential, expected);
    assert.ok(Number(turn.username.split(":")[0]) > Date.now() / 1000);
    console.log("ok  TURN credentials");
  } else {
    console.log(turn ? `ok  TURN offered: ${[].concat(turn.urls).join(", ")}` : "--  no TURN configured");
  }

  // "next" drops the current peer and tells them.
  b.send({ type: "next" });
  await a.next("peer-left");
  await b.next("waiting");
  console.log("ok  next");

  // Disconnecting while waiting leaves nobody stuck in the queue: c pairs with b, not a ghost.
  const c = await client();
  c.send({ type: "join" });
  const mc = await c.next("matched");
  assert.equal(mc.initiator, true);
  await b.next("matched");
  console.log("ok  random queue");

  a.send({ type: "join", room: "bad room!" });
  assert.equal((await a.next("error")).error, "bad room");
  console.log("ok  room validation");

  // Host/join flow used by the game: the host gets a code, the client joins with it.
  const host = await client();
  const guest = await client();
  host.send({ type: "host" });
  const { code, iceServers } = await host.next("room");
  assert.match(code, /^[A-Z2-9]{4}$/);
  assert.ok(iceServers.length > 0);
  guest.send({ type: "join", code: code.toLowerCase() });
  assert.equal((await guest.next("joined")).code, code);
  assert.ok((await host.next("peer-joined")).iceServers.length > 0);
  host.send({ type: "signal", data: { type: "offer", sdp: "y" } });
  assert.equal((await guest.next("signal")).data.sdp, "y");
  console.log("ok  host and join by code");

  // A third player can't take the room, and errors carry `message` for the game's client.
  const third = await client();
  third.send({ type: "join", code });
  assert.match((await third.next("error")).message, /two players/);
  third.send({ type: "join", code: "ZZZZ" });
  assert.match((await third.next("error")).message, /No room/);
  console.log("ok  room full / unknown code");

  // When the guest drops, the room stays open and a new guest can rejoin it.
  guest.close();
  await host.next("peer-left");
  third.send({ type: "join", code });
  await third.next("joined");
  await host.next("peer-joined");
  console.log("ok  rejoin after drop");

  for (const x of [a, b, c, host, third]) x.close();
  console.log("all passed");
} finally {
  child?.kill("SIGTERM");
}
