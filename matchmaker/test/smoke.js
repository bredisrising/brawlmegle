// Starts the matchmaker on a spare port and checks pairing, relaying, rooms and TURN credentials.
// Usage: npm test, or MATCHMAKER_URL=wss://host/ws npm test to check a deployed server.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const SECRET = "test-secret";
let url = process.env.MATCHMAKER_URL;
let child;
let httpBase;

if (!url) {
  const port = 30000 + Math.floor(Math.random() * 10000);
  const samples = fs.mkdtempSync(path.join(os.tmpdir(), "mm-samples-"));
  child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), TURN_HOST: "turn.test", TURN_SECRET: SECRET, SAMPLES_DIR: samples, QUICK_RESERVE_MS: "1500" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  url = `ws://127.0.0.1:${port}/ws`;
  httpBase = `http://127.0.0.1:${port}`;
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
    next: (type, timeoutMs = 3000) => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error(`timed out waiting for ${type}`));
        }, timeoutMs);
      });
    },
    /** Whether a message of this type arrives within `ms` (left in the inbox). */
    gets: async (type, ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return inbox.some((m) => m.type === type);
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

  // A host whose socket dropped takes its code back with the token, so the client can still rejoin.
  host.send({ type: "host" });
  const again = await host.next("room");
  assert.equal(again.code, code);
  assert.ok(again.token);
  const host2 = await client();
  host2.send({ type: "host", code: code.toLowerCase(), token: again.token });
  assert.equal((await host2.next("room")).code, code, "reclaimed while the old socket is still open");
  const guest2 = await client();
  guest2.send({ type: "join", code });
  await guest2.next("joined");
  await host2.next("peer-joined");
  const host3 = await client();
  host3.send({ type: "host", code, token: "forged" });
  assert.notEqual((await host3.next("room")).code, code, "a wrong token gets a new code");
  console.log("ok  host reclaims its code");

  // Spectators: a screen watches a hosted room and gets what the host casts; the host hears how many watch.
  const caster = await client();
  caster.send({ type: "host" });
  const castRoom = (await caster.next("room")).code;
  const screen = await client();
  screen.send({ type: "watch", code: castRoom.toLowerCase() });
  assert.equal((await screen.next("watching")).code, castRoom);
  assert.equal((await caster.next("watchers")).count, 1);
  caster.send({ type: "cast", data: { type: "phase", phase: "fighting", countdown: null } });
  assert.deepEqual((await screen.next("cast")).data, { type: "phase", phase: "fighting", countdown: null });
  // Casting faster than the signaling rate limit (200 per 10 s) doesn't get the host kicked.
  for (let i = 0; i < 250; i++) caster.send({ type: "cast", data: { type: "frame", i } });
  let got = 0;
  while (got < 50) {
    await screen.next("cast");
    got++;
  }
  const nowhere = await client();
  nowhere.send({ type: "watch", code: "ZZZZ" });
  assert.match((await nowhere.next("error")).message, /No room/);
  screen.close();
  assert.equal((await caster.next("watchers")).count, 0);
  console.log("ok  spectators watch a hosted room");
  for (const x of [caster, nowhere]) x.close();

  await quickTests();

  if (httpBase) {
    // Training-sample uploads: a `null` header used to crash the whole server.
    const bad = await fetch(`${httpBase}/samples`, { method: "POST", body: "null\n" });
    assert.equal(bad.status, 400);
    const good = await fetch(`${httpBase}/samples`, { method: "POST", body: '{"labels":["jab"]}\n{"t":0}\n' });
    assert.equal(good.status, 201);
    assert.equal((await fetch(`${httpBase}/health`)).status, 200);
    console.log("ok  sample uploads");
  }

  for (const x of [a, b, c, host, third, host2, guest2, host3]) x.close();
  console.log("all passed");
} finally {
  child?.kill("SIGTERM");
}

/** "Find a fight": quick pairing, the two-waiting-hosts race, preferring someone new, re-pairing when alone. */
async function quickTests() {
  const id = () => `p-${crypto.randomUUID().slice(0, 8)}`;
  const probe = await client();
  probe.send({ type: "quick", player: id() });
  const first = await Promise.race([probe.next("room").catch(() => null), probe.next("error").catch(() => null)]);
  probe.close();
  if (first?.type === "error" && process.env.MATCHMAKER_URL) return console.log("--  quick matchmaking not on this server yet");
  assert.equal(first?.type, "room", "quick: a lone player waits as a host");

  // A and B: A waits as a host (a room whose code the game doesn't show), B is told to join A's room by its code.
  const [pa, pb, pc, pd] = [id(), id(), id(), id()];
  const qa = await client();
  qa.send({ type: "quick", player: pa });
  const roomA = (await qa.next("room")).code;
  const qb = await client();
  qb.send({ type: "quick", player: pb });
  assert.equal((await qb.next("quick-join")).code, roomA);
  console.log("ok  quick: the second player is sent to the waiting one");

  // While B is on its way, A's room is held for B: a third quick player waits instead of taking it, and a join
  // by code from anyone else is refused.
  const qc = await client();
  qc.send({ type: "quick", player: pc });
  const roomC = (await qc.next("room")).code;
  assert.notEqual(roomC, roomA);
  const sneak = await client();
  sneak.send({ type: "join", code: roomA, player: id() });
  assert.match((await sneak.next("error")).message, /two players/);
  sneak.close();
  // B joins by code (a fresh socket, like the game's client Peer), with its player id.
  const jb = await client();
  qb.close();
  jb.send({ type: "join", code: roomA, player: pb });
  await jb.next("joined");
  await qa.next("peer-joined");
  console.log("ok  quick: the matched room is held for that player, who joins by code");

  // The race: two quick hosts waiting at once (C, and D who comes in as a host) get paired by the sweep.
  const qd = await client();
  qd.send({ type: "host" }); // an ordinary room is never matched
  await qd.next("room");
  assert.equal(await qd.gets("quick-join", 800), false, "a code room got matched");
  qd.send({ type: "quick", player: pd });
  // C is waiting and new to D: D joins C straight away.
  assert.equal((await qd.next("quick-join")).code, roomC);
  console.log("ok  quick: a host re-listed as quick pairs with the one waiting");
  for (const x of [qa, jb, qc, qd]) x.close();

  // A and B fought; both search again. Each prefers someone new, so B waits too; with nobody else around the sweep
  // pairs them again after a few seconds. With a newcomer around, the newcomer is preferred.
  const a2 = await client();
  a2.send({ type: "quick", player: pa });
  const roomA2 = (await a2.next("room")).code;
  const b2 = await client();
  b2.send({ type: "quick", player: pb });
  await b2.next("room"); // not straight to A
  const started = Date.now();
  assert.equal((await b2.next("quick-join", 8000)).code, roomA2);
  const took = Date.now() - started;
  assert.ok(took >= 2000 && took < 6000, `re-paired after ${took} ms`);
  console.log(`ok  quick: the same two are re-paired when alone (${took} ms)`);
  a2.close();
  b2.close();

  const a3 = await client();
  a3.send({ type: "quick", player: pa });
  const roomA3 = (await a3.next("room")).code;
  const newcomer = await client();
  const pe = id();
  newcomer.send({ type: "quick", player: pe });
  assert.equal((await newcomer.next("quick-join")).code, roomA3);
  const b3 = await client();
  b3.send({ type: "quick", player: pb });
  await b3.next("room"); // A is held for the newcomer; B waits
  console.log("ok  quick: a newcomer is preferred over the last opponent");

  for (const x of [a3, newcomer, b3]) x.close();
  await new Promise((r) => setTimeout(r, 200));

  // A waiting host that leaves is out of the queue, so nobody is sent to a dead room.
  const e = await client();
  e.send({ type: "quick", player: id() });
  await e.next("room");
  e.close();
  await new Promise((r) => setTimeout(r, 200));
  const f = await client();
  f.send({ type: "quick", player: id() });
  await f.next("room");
  f.close();
  console.log("ok  quick: a host that left is out of the queue");

  if (!process.env.MATCHMAKER_URL) {
    // Two quick hosts waiting at once (the race): G was matched with H, but H never joined; once the hold runs out
    // (1.5 s here, 10 s live), G is free again and the sweep pairs it with I, who is waiting too.
    const g = await client();
    g.send({ type: "quick", player: id() });
    const roomG = (await g.next("room")).code;
    const h = await client();
    h.send({ type: "quick", player: id() });
    await h.next("quick-join");
    h.close(); // never joins
    const i = await client();
    i.send({ type: "quick", player: id() });
    await i.next("room"); // G is held for H
    assert.equal((await i.next("quick-join", 5000)).code, roomG);
    console.log("ok  quick: two waiting hosts get paired by the sweep (a no-show's hold runs out)");
    for (const x of [g, i]) x.close();
  }

  const bad = await client();
  bad.send({ type: "quick", player: "no spaces!" });
  assert.equal((await bad.next("error")).message, "bad player");
  bad.close();
  console.log("ok  quick: player id validation");
}
