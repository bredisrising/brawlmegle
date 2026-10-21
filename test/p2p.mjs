// End-to-end P2P test: starts the matchmaker and Vite, then runs test/p2p/main.ts in headless
// Chrome, where the game's client Peer connects to a test host over real WebRTC.
// Usage: npm run test:p2p. Uses the installed Chrome (no browser download); CHROME_PATH overrides it.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const port = 30000 + Math.floor(Math.random() * 10000);
const matchmaker = spawn(process.execPath, ["server.js"], {
  cwd: new URL("../matchmaker/", import.meta.url),
  // An unreachable TURN host is fine: the peers connect directly on localhost, and the test only
  // checks that the client picked up the TURN entry the server sent.
  env: { ...process.env, PORT: String(port), TURN_HOST: "turn.invalid", TURN_SECRET: "test-secret", QUICK_REPAIR_MS: "2000" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => matchmaker.stdout.once("data", resolve));

const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "warn", server: { port: 0 } });
await vite.listen();
const base = vite.resolvedUrls.local[0];

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
  // Headless Chrome hides local IPs behind mDNS names, which may not resolve here.
  // SwiftShader gives the Game's renderer software WebGL (no GPU in headless).
  // Two Games run side by side (the matchmaking test): neither may be throttled as a background page.
  args: [
    "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    // Muted: the Games' sounds would otherwise play through this machine's speakers.
    "--mute-audio",
  ],
});

let failed = true;
/** `P2P_ONLY=quick` (or peer, friend; comma-separated) runs just those parts. */
const only = (process.env.P2P_ONLY ?? "peer,quick,friend").split(",");
try {
  const results = [];
  if (only.includes("peer")) {
    const page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") console.log(`  [browser ${msg.type()}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => console.log(`  [browser] ${err.message}`));
    await page.goto(`${base}test/p2p/?signal=${encodeURIComponent(`ws://127.0.0.1:${port}/ws`)}`);
    await page.waitForFunction(() => window.__p2p?.done, null, { timeout: 120_000 });
    results.push(...(await page.evaluate(() => window.__p2p.results)));
    await page.close();
  }
  if (only.includes("quick")) results.push(...(await quickSuite()));
  if (only.includes("friend")) results.push(...(await friendSuite()));
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name} (${r.ms} ms)${r.error ? `\n     ${r.error}` : ""}`);
  failed = results.length === 0 || results.some((r) => !r.ok);
  console.log(failed ? "p2p test failed" : "all passed");
} finally {
  await browser.close();
  await vite.close();
  matchmaker.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);

/**
 * "Find a fight" between two real Games, each in its own browser profile (test/p2p/quick.ts): matched and connected,
 * camera video both ways, hide-camera, rematch votes, auto-next re-pairing, and a player leaving.
 */
async function quickSuite() {
  const out = [];
  let a, b;
  const signal = encodeURIComponent(`ws://127.0.0.1:${port}/ws`);
  const open = async (name, color) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning" || process.env.P2P_DEBUG) console.log(`  [${name} ${msg.type()}] ${msg.text().slice(0, 300)}`);
    });
    page.on("pageerror", (err) => console.log(`  [${name}] ${err.message}`));
    await page.goto(`${base}test/p2p/quick.html?signal=${signal}&walkout=0&color=${encodeURIComponent(color)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForFunction(() => window.__q, null, { timeout: 120_000 });
    return { page, ctx };
  };
  const test = async (name, fn) => {
    const start = Date.now();
    try {
      await fn();
      out.push({ name, ok: true, ms: Date.now() - start });
    } catch (err) {
      const where = await Promise.all([a, b].map((p) => state(p).then((s) => JSON.stringify(s)).catch(() => "closed")));
      out.push({ name, ok: false, error: `${String(err?.message ?? err).split("\n")[0]}\n     alice ${where[0]}\n     bob   ${where[1]}`, ms: Date.now() - start });
    }
    console.log(`[quick] ${out.at(-1).ok ? "ok  " : "FAIL"} ${name}`);
  };
  /** Waits for `fn(state, game)` to be true in a page. */
  const until = (p, fn, arg, timeout = 45_000) =>
    p.page.waitForFunction(({ src, arg }) => new Function("s", "g", "arg", `return (${src})(s, g, arg)`)(window.__q.store.getState(), window.__q.game, arg), { src: fn.toString(), arg }, { timeout, polling: 100 });
  const state = (p) => p.page.evaluate(() => {
    const s = window.__q.store.getState();
    return { role: s.role, phase: s.phase, connection: s.connection, searching: s.searching, roomCode: s.roomCode, p1: s.players.p1.name, p2: s.players.p2.name, votes: s.votes, nextAt: s.nextAt };
  });
  const view = (p) => p.page.evaluate(() => window.__q.camView(window.__q.store.getState()));
  /** The video this laptop is sending right now, as seen by its Peer (null: nothing). */
  const sending = (p) => p.page.evaluate(() => {
    const g = window.__q.game;
    const peer = g.client?.peer ?? g.hostSession?.peer;
    return peer?.sendingVideo ? peer.sendingVideo.readyState : null;
  });
  const inFight = (s) => s.connection === "open" && s.players.p1.status === "ready" && s.players.p2.status === "ready" && s.phase !== "lobby";

  [a, b] = await Promise.all([open("alice", "#ff2d95"), open("bob", "#1f8bff")]);
  try {
    await test("quick: the first player waits as a host, searching (no code shown)", async () => {
      await a.page.evaluate(() => {
        window.__q.game.findFight();
        void window.__q.game.chooseFighter({ kind: "masked", name: "Alice" });
      });
      await until(a, (s) => s.searching && s.role === "host" && !!s.roomCode && s.players.p1.status === "ready");
    });

    await test("quick: the next player is matched to them and both connect, fighters set up", async () => {
      await b.page.evaluate(() => {
        window.__q.game.findFight();
        void window.__q.game.chooseFighter({ kind: "masked", name: "Bob" });
      });
      await until(b, (s) => s.connection === "open" && !s.searching, null, 90_000);
      // Generous: on a loaded machine a first connect can time out (15 s), and then both search again and re-pair.
      await until(a, inFight, null, 90_000);
      await until(b, inFight, null, 90_000);
      const [sa, sb] = [await state(a), await state(b)];
      // Usually Alice hosts (she waited first); after a retry it may be the other way round.
      const host = sa.role === "host" ? "Alice" : "Bob";
      const guest = host === "Alice" ? "Bob" : "Alice";
      if (sa.p1 !== host || sa.p2 !== guest || sb.p1 !== host || sb.p2 !== guest) throw new Error(`names ${JSON.stringify([sa.p1, sa.p2, sb.p1, sb.p2])}`);
      if (sa.searching || sb.searching) throw new Error("still says searching");
      const gaps = await Promise.all([a, b].map((p) => p.page.evaluate(() => window.__gap())));
      console.log(`[quick] longest main-thread stall so far: alice ${gaps[0]} ms, bob ${gaps[1]} ms`);
    });

    await test("quick: each side gets the other's camera video, with frames", async () => {
      const t0 = Date.now();
      await until(a, (s) => !!s.opponentVideo && s.camSending);
      await until(b, (s) => !!s.opponentVideo && s.camSending);
      const t1 = Date.now() - t0;
      const wa = await a.page.evaluate(() => window.__q.frames(window.__q.store.getState().opponentVideo));
      const wb = await b.page.evaluate(() => window.__q.frames(window.__q.store.getState().opponentVideo));
      console.log(`[quick] video tracks after ${t1} ms, frames after ${Date.now() - t0} ms (${wa}px / ${wb}px wide)`);
      if (!wa || !wb) throw new Error(`no frames: ${wa} / ${wb}`);
      const [va, vb] = [await view(a), await view(b)];
      if (!va.show || !va.sending || va.label || !vb.show || !vb.sending) throw new Error(`views ${JSON.stringify([va, vb])}`);
    });

    await test("quick: hide my camera stops the video both ways, and both sides say who hid", async () => {
      await b.page.evaluate(() => window.__q.setCamHidden(true));
      await until(a, (s) => s.opponentCamHidden && !s.opponentVideo && !s.camSending);
      await until(b, (s) => !s.opponentVideo && !s.camSending);
      const [va, vb] = [await view(a), await view(b)];
      if (va.label !== "Your opponent hid their camera" || va.show || va.sending) throw new Error(`alice ${JSON.stringify(va)}`);
      if (vb.label !== "You hid your camera" || vb.show || vb.sending) throw new Error(`bob ${JSON.stringify(vb)}`);
      const [ta, tb] = [await sending(a), await sending(b)];
      if (ta !== null || tb !== null) throw new Error(`still sending: alice ${ta}, bob ${tb}`);
      const saved = await b.page.evaluate(() => localStorage.getItem("brawlmegle.hideCam"));
      if (saved !== "1") throw new Error(`not remembered: ${saved}`);
      // Back on: both send and see again.
      await b.page.evaluate(() => window.__q.setCamHidden(false));
      await until(a, (s) => !s.opponentCamHidden && !!s.opponentVideo && s.camSending);
      await until(b, (s) => !!s.opponentVideo && s.camSending);
      if ((await sending(a)) !== "live" || (await sending(b)) !== "live") throw new Error("not sending again");
    });

    /** Whichever of the two hosts the match right now, and the other. */
    const roles = async () => ((await state(a)).role === "host" ? [a, b] : [b, a]);

    await test("quick: one rematch vote is not enough; both votes rematch", async () => {
      const [host, client] = await roles();
      // A time-out on the host: the K.O. screen.
      await host.page.evaluate(() => window.__q.store.setState({ phase: "ko", ending: "time", winner: "p1", countdown: null }));
      await until(client, (s) => s.phase === "ko");
      await host.page.evaluate(() => window.__q.game.voteRematch());
      await until(client, (s) => s.votes.p1 && !s.votes.p2);
      await new Promise((r) => setTimeout(r, 700));
      if ((await state(host)).phase !== "ko") throw new Error("rematched on one vote");
      await client.page.evaluate(() => window.__q.game.voteRematch());
      await until(host, (s) => s.phase === "countdown" && !s.votes.p1 && !s.votes.p2);
      await until(client, (s) => s.phase !== "ko");
    });

    let before = "";
    await test("quick: nobody votes, the countdown runs out, both search again and re-pair (alone: same two)", async () => {
      const [host, client] = await roles();
      before = (await state(host)).roomCode;
      await host.page.evaluate(() => window.__q.store.setState({ phase: "ko", ending: "time", winner: "p2", countdown: null }));
      // The client sees the countdown too.
      await until(client, (s) => s.phase === "ko" && s.nextAt !== null);
      // Both leave, search, and (nobody else around) get paired again after the matchmaker's grace.
      await until(host, (s, g, before) => s.roomCode !== before, before);
      await until(a, inFight);
      await until(b, inFight);
      const [sa, sb] = [await state(a), await state(b)];
      if (sa.roomCode === before) throw new Error("same room: they never left");
      if (sa.role === sb.role) throw new Error(`both are ${sa.role}`);
      // Fighters kept, whoever hosts now.
      const names = (s) => [s.p1, s.p2].sort().join("+");
      if (names(sa) !== "Alice+Bob" || names(sb) !== "Alice+Bob") throw new Error(`names ${names(sa)} / ${names(sb)}`);
      // The camera comes along through the role flip.
      await until(a, (s) => !!s.opponentVideo && s.camSending);
      await until(b, (s) => !!s.opponentVideo && s.camSending);
    });

    // Walking away mid-match: the tab hidden for more than 2 s calls it off for both, with no result.
    for (const who of ["client", "host"]) {
      await test(`quick: the ${who}'s tab hidden mid-fight calls it off; the other searches at once, the hidden one only once back`, async () => {
        await until(a, inFight);
        await until(b, inFight);
        const [host, client] = await roles();
        const [away, stayer] = who === "client" ? [client, host] : [host, client];
        const kos = (await a.page.evaluate(() => window.__q.kos())) + (await b.page.evaluate(() => window.__q.kos()));
        for (const p of [a, b]) await p.page.evaluate(() => (window.__q.notices.length = 0));
        await away.page.evaluate(() => window.__q.setHidden(true));
        try {
          await until(stayer, (s) => window.__q.notices.includes("Your opponent left") && s.searching && s.connection === null, null, 30_000);
          await until(away, (s) => !s.searching && s.connection === null && s.phase === "lobby" && s.role === "host" && s.players.p1.status === "ready", null, 30_000);
          // Well past the matchmaker's grace for re-pairing these two (2 s here): nobody gets matched with the empty chair.
          await new Promise((r) => setTimeout(r, 5000));
          const [sa, ss] = [await state(away), await state(stayer)];
          if (sa.searching || sa.connection !== null) throw new Error(`the hidden player is back in the queue: ${JSON.stringify(sa)}`);
          if (!ss.searching || ss.connection !== null) throw new Error(`the other one got matched with someone: ${JSON.stringify(ss)}`);
        } finally {
          await away.page.evaluate(() => window.__q.setHidden(false));
        }
        await until(away, (s) => window.__q.notices.includes("You left the match"));
        await until(a, inFight);
        await until(b, inFight);
        const after = (await a.page.evaluate(() => window.__q.kos())) + (await b.page.evaluate(() => window.__q.kos()));
        if (after !== kos) throw new Error("the called-off match reached a K.O. screen (a result would be posted)");
      });
    }

    await test("quick: a player closing the tab sends the other straight back to searching", async () => {
      await b.page.close({ runBeforeUnload: true }); // like closing the tab (pagehide fires)
      await until(a, (s) => s.searching && s.role === "host" && s.players.p2.status === "waiting" && s.phase === "lobby");
      const s = await state(a);
      if (s.p1 !== "Alice") throw new Error(`alice lost her fighter: ${s.p1}`);
    });

    // The live bug: the first player tabs away while "Looking for an opponent…", gets matched while hidden, and their
    // game loop (animation frames) never runs, so the stranger sat on the walkout's VS forever.
    let c;
    await test("quick: matched while the host's tab is hidden: no countdown, the stranger waits, then moves on; the hidden one only searches once back", async () => {
      await until(a, (s) => s.searching && s.role === "host");
      await a.page.evaluate(() => (window.__q.notices.length = 0));
      await a.page.evaluate(() => window.__q.setHidden(true));
      try {
        c = await open("carol", "#33cc66");
        b = c; // for the failure report
        await c.page.evaluate(() => {
          window.__q.game.findFight();
          void window.__q.game.chooseFighter({ kind: "masked", name: "Carol" });
        });
        await until(c, (s) => s.connection === "open" && s.notice?.text === "Opponent found, waiting for them to come back…", null, 90_000);
        const title = await a.page.evaluate(() => document.title);
        if (!/Opponent found/.test(title)) throw new Error(`the hidden tab's title says ${title}`);
        // Never on the walkout's VS (no countdown) while the host is away, and moved on after ~8 s.
        const t0 = Date.now();
        let longest = 0;
        while (Date.now() - t0 < 20_000) {
          const s = await c.page.evaluate(() => window.__q.store.getState().phase);
          if (s === "countdown" || s === "fighting") throw new Error("the round started while the host's tab was hidden");
          if (await c.page.evaluate(() => window.__q.notices.includes("Your opponent didn't come back"))) break;
          longest = Date.now() - t0;
          await new Promise((r) => setTimeout(r, 200));
        }
        if (longest > 15_000) throw new Error(`still waiting after ${longest} ms`);
        await until(c, (s) => s.searching && s.connection === null && s.role === "host");
        // The hidden one is out of the queue: nobody gets matched with them.
        await new Promise((r) => setTimeout(r, 4000));
        const sa = await state(a);
        if (sa.searching || sa.connection !== null) throw new Error(`the hidden host is back in the queue: ${JSON.stringify(sa)}`);
        if ((await state(c)).connection !== null) throw new Error("carol got matched with the hidden one");
      } finally {
        await a.page.evaluate(() => window.__q.setHidden(false));
      }
      await until(a, (s) => window.__q.notices.includes("You missed a match"));
      if (/Opponent found/.test(await a.page.evaluate(() => document.title))) throw new Error("the title wasn't restored");
      await until(a, inFight, null, 60_000);
      await until(c, inFight, null, 60_000);
    });

    await test("quick: the host's game loop freezing mid-fight (no frames) is noticed by the stranger within a few seconds", async () => {
      const [host, client] = (await state(a)).role === "host" ? [a, c] : [c, a];
      await until(client, (s) => s.phase === "fighting" || s.phase === "countdown");
      // Freeze the host's game loop: no frames, no phase changes (like a tab whose animation frames stopped).
      await host.page.evaluate(() => {
        const g = window.__q.game;
        window.__tick = g.tick;
        g.tick = () => {};
      });
      await client.page.evaluate(() => (window.__q.notices.length = 0));
      const t0 = Date.now();
      try {
        await until(client, (s) => window.__q.notices.includes("Your opponent left") && s.role === "host", null, 30_000);
      } finally {
        await host.page.evaluate(() => (window.__q.game.tick = window.__tick));
      }
      const took = Date.now() - t0;
      if (took > 15_000) throw new Error(`noticed after ${took} ms`);
      console.log(`[quick] the frozen host was noticed after ${took} ms`);
      await until(a, inFight, null, 60_000);
      await until(c, inFight, null, 60_000);
    });
  } finally {
    await a.ctx.close().catch(() => {});
    await b.ctx.close().catch(() => {});
  }
  return out;
}

/**
 * Play a friend (room code) between two real Games: a tab hidden mid-fight sends both back to the lobby, keeping the
 * room, and the fight restarts once that player's back; a client that closes its tab frees the slot at once.
 */
async function friendSuite() {
  const out = [];
  const signal = encodeURIComponent(`ws://127.0.0.1:${port}/ws`);
  const open = async (name) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error" || process.env.P2P_DEBUG) console.log(`  [${name} ${msg.type()}] ${msg.text().slice(0, 300)}`);
    });
    page.on("pageerror", (err) => console.log(`  [${name}] ${err.message}`));
    await page.goto(`${base}test/p2p/quick.html?signal=${signal}&walkout=0`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForFunction(() => window.__q, null, { timeout: 120_000 });
    return { page, ctx };
  };
  const until = (p, fn, arg, timeout = 45_000) =>
    p.page.waitForFunction(({ src, arg }) => new Function("s", "g", "arg", `return (${src})(s, g, arg)`)(window.__q.store.getState(), window.__q.game, arg), { src: fn.toString(), arg }, { timeout, polling: 100 });
  const state = (p) => p.page.evaluate(() => {
    const s = window.__q.store.getState();
    return { role: s.role, phase: s.phase, connection: s.connection, roomCode: s.roomCode, p1: s.players.p1.status, p2: s.players.p2.status, notice: s.notice?.text };
  });
  const kos = async () => (await host.page.evaluate(() => window.__q.kos())) + (await guest.page.evaluate(() => window.__q.kos()));
  const inFight = (s) => s.connection === "open" && s.players.p1.status === "ready" && s.players.p2.status === "ready" && (s.phase === "countdown" || s.phase === "fighting");
  const test = async (name, fn) => {
    const start = Date.now();
    try {
      await fn();
      out.push({ name, ok: true, ms: Date.now() - start });
    } catch (err) {
      const where = await Promise.all([host, guest].map((p) => state(p).then((s) => JSON.stringify(s)).catch(() => "closed")));
      out.push({ name, ok: false, error: `${String(err?.message ?? err).split("\n")[0]}\n     host  ${where[0]}\n     guest ${where[1]}`, ms: Date.now() - start });
    }
    console.log(`[friend] ${out.at(-1).ok ? "ok  " : "FAIL"} ${name}`);
  };

  let [host, guest] = await Promise.all([open("host"), open("guest")]);
  let code = "";
  try {
    await test("friend: create a room, the friend joins with the code, the fight starts", async () => {
      await host.page.evaluate(async () => {
        await window.__q.game.host();
        void window.__q.game.chooseFighter({ kind: "masked", name: "Host" });
      });
      await until(host, (s) => !!s.roomCode && s.players.p1.status === "ready");
      code = (await state(host)).roomCode;
      await guest.page.evaluate(async (code) => {
        await window.__q.game.join(code);
        void window.__q.game.chooseFighter({ kind: "masked", name: "Guest" });
      }, code);
      await until(host, inFight, null, 60_000);
      await until(guest, inFight, null, 60_000);
    });

    for (const who of ["guest", "host"]) {
      await test(`friend: the ${who}'s tab hidden mid-fight sends both to the lobby (same room), and it restarts once they're back`, async () => {
        await until(host, inFight);
        await until(guest, inFight);
        const before = await kos();
        const [away, stayer] = who === "guest" ? [guest, host] : [host, guest];
        for (const p of [host, guest]) await p.page.evaluate(() => (window.__q.notices.length = 0));
        await away.page.evaluate(() => window.__q.setHidden(true));
        try {
          await until(stayer, (s) => s.phase === "lobby" && /switched away/.test(s.notice?.text ?? "") && s.notice.sticky, null, 30_000);
          await until(away, (s) => s.phase === "lobby", null, 30_000);
          const [sh, sg] = [await state(host), await state(guest)];
          if (sh.roomCode !== code || sg.roomCode !== code) throw new Error(`room changed: ${sh.roomCode} / ${sg.roomCode}`);
          if (sh.connection !== "open" || sg.connection !== "open") throw new Error("the friend was dropped from the room");
          if (sh.p1 !== "ready" || sh.p2 !== "ready") throw new Error(`fighters lost: ${sh.p1} / ${sh.p2}`);
          // Still away: the fight doesn't restart on its own.
          await new Promise((r) => setTimeout(r, 1500));
          if ((await state(host)).phase !== "lobby") throw new Error("restarted while they were away");
        } finally {
          await away.page.evaluate(() => window.__q.setHidden(false));
        }
        await until(away, (s) => window.__q.notices.includes("You left the match"));
        await until(host, inFight);
        await until(guest, inFight);
        if ((await kos()) !== before) throw new Error("the called-off round reached a K.O. screen (a result would be posted)");
      });
    }

    await test("friend: the friend's laptop going quiet mid-fight (no messages) sends both to the lobby; it restarts once heard again", async () => {
      await until(host, inFight);
      await until(guest, inFight);
      await guest.page.evaluate(() => {
        const client = window.__q.game.client;
        window.__send = client.send;
        client.send = () => {};
      });
      const t0 = Date.now();
      try {
        await until(host, (s) => s.phase === "lobby" && /switched away/.test(s.notice?.text ?? ""), null, 30_000);
        console.log(`[friend] the quiet friend was noticed after ${Date.now() - t0} ms`);
      } finally {
        await guest.page.evaluate(() => delete window.__q.game.client.send);
      }
      await until(host, inFight);
      await until(guest, inFight);
    });

    await test("friend: the host hidden before the friend is ready: the round waits (no VS freeze), and starts once the host is back", async () => {
      // A fresh friend joins while the host's tab is hidden.
      await guest.page.evaluate(() => window.__q.game.client.leave());
      await until(host, (s) => s.phase === "lobby" && s.players.p2.status === "waiting" && s.connection === null);
      await guest.ctx.close();
      guest = await open("guest2");
      await host.page.evaluate(() => window.__q.setHidden(true));
      try {
        await guest.page.evaluate(async (code) => {
          await window.__q.game.join(code);
          void window.__q.game.chooseFighter({ kind: "masked", name: "Guest" });
        }, code);
        await until(guest, (s) => s.players.p2.status === "ready" && /switched away/.test(s.notice?.text ?? ""), null, 90_000);
        await new Promise((r) => setTimeout(r, 3000));
        if ((await state(guest)).phase !== "lobby") throw new Error("the round started while the host's tab was hidden");
      } finally {
        await host.page.evaluate(() => window.__q.setHidden(false));
      }
      await until(host, inFight);
      await until(guest, inFight);
      if ((await state(guest)).notice) throw new Error("the waiting notice stayed up");
    });

    await test("friend: a tab hidden for under 2 s doesn't call anything off", async () => {
      await guest.page.evaluate(() => window.__q.setHidden(true));
      await new Promise((r) => setTimeout(r, 800));
      await guest.page.evaluate(() => window.__q.setHidden(false));
      await new Promise((r) => setTimeout(r, 1500));
      const s = await state(host);
      if (s.phase === "lobby") throw new Error("a short switch called the round off");
    });

    await test("friend: the friend closing the tab mid-fight frees the slot at once (the code shows, no 45 s hold)", async () => {
      await until(host, inFight);
      const t0 = Date.now();
      await guest.page.close({ runBeforeUnload: true }); // like closing the tab (pagehide fires)
      await until(host, (s) => s.phase === "lobby" && s.connection === null && s.players.p2.status === "waiting", null, 10_000);
      const s = await state(host);
      if (s.roomCode !== code) throw new Error(`room changed: ${s.roomCode}`);
      console.log(`[friend] slot freed ${Date.now() - t0} ms after the tab closed`);
    });
  } finally {
    await host.ctx.close().catch(() => {});
    await guest.ctx.close().catch(() => {});
  }
  return out;
}
