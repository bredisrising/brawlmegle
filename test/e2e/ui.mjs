// The game site like a stranger uses it: every screen and button, username validation, Welcome back, the roster,
// masked, keyboard shortcuts, refresh, double clicks, back and forth, phone width. Fake camera (Chrome's test
// pattern, so nobody is in view); nothing here scans or forges.
import { BASE, assert, createRoom, done, launch, note, open, openJoin, pageText as text, shot, sleep, test, waitArena, waitText } from "./lib.mjs";

const URL_ = `${BASE}/?pose=lite`;
const browser = await launch({ camera: "fake" });

const enterCard = (page) => page.locator("button", { hasText: "Type your username" });
const loadCard = (page) => page.locator("button", { hasText: "house fighter" });
const back = (page) => page.getByRole("button", { name: /^\W*back$/i }); // not "...comes back, or..." on the Enter card
const nameInput = (page) => page.locator("#fighter-name");

async function host(page) {
  await createRoom(page);
  await enterCard(page).waitFor({ timeout: 15_000 });
}
async function toName(page) {
  await host(page);
  await enterCard(page).click();
  await nameInput(page).waitFor();
}
/** A real double click at the element's center (the element may unmount after the first click). */
async function dblclick(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
}
function noPageErrors(page) {
  assert.deepEqual(page.log.errors, [], "uncaught page errors");
}

await test("title: loads with Find a fight and Play a friend", async () => {
  const page = await open(browser, URL_);
  note(`load event after ${page.log.loadMs} ms`);
  const t = await text(page);
  assert.match(t, /BRAWL\s*EGLE/i);
  await page.getByRole("button", { name: /Find a fight/ }).waitFor();
  await page.getByRole("button", { name: /Play a friend/ }).waitFor();
  assert.match(await page.title(), /\S/, "page has no <title>");
  await shot(page, "title");
  noPageErrors(page);
  assert.deepEqual(page.log.http, [], "HTTP errors while loading");
  await page.context().close();
});

await test("tools: the tuner and scan pages still load (no links on the title any more), and browser back returns", async () => {
  const page = await open(browser, URL_);
  for (const [path, heading] of [["/tuner/", /Start camera/], ["/scan/", /360° scan/]]) {
    await page.goto(`${BASE}${path}`);
    assert.match(await text(page), heading);
    await page.goBack();
    await page.getByRole("button", { name: /Find a fight/ }).waitFor();
  }
  await page.context().close();
});

await test("Create a room: opens the fighter select with a room code", async () => {
  const page = await open(browser, URL_);
  const sockets = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await host(page);
  await shot(page, "avatar-choose");
  const header = await page.locator("header").innerText();
  note(`header: ${header.replace(/\s+/g, " ")}; signaling sockets opened: ${sockets.length}`);
  assert.doesNotMatch(header, /----/, "room code is still ---- (no room opened)");
  await page.context().close();
}, { known: "E2E-08" });

await test("Create a room: double click opens one room and stays on the first fighter-select step", async () => {
  const page = await open(browser, URL_);
  const sockets = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await page.getByRole("button", { name: /Play a friend/ }).click();
  await dblclick(page, page.getByRole("button", { name: /Create a room/ }));
  await sleep(2000);
  await shot(page, "host-dblclick");
  assert.ok(sockets.length <= 1, `${sockets.length} signaling sockets`);
  noPageErrors(page);
  const t = await text(page);
  assert.match(t, /CHOOSE\s+YOUR FIGHTER/i, `the second click went through to the next screen: ${t.replace(/\s+/g, " ").slice(0, 120)}`);
  await page.context().close();
}, { known: "E2E-10" });

await test("fighter select: there is a way back to the title screen", async () => {
  const page = await open(browser, URL_);
  await host(page);
  assert.ok((await back(page).count()) > 0, "no Back (or title) button on the first fighter-select step; only a page reload gets out");
  await page.context().close();
}, { known: "E2E-09" });

await test("Enter / Back / Load fighter / Back: back and forth keeps working", async () => {
  const page = await open(browser, URL_);
  await host(page);
  for (let i = 0; i < 3; i++) {
    await enterCard(page).click();
    await nameInput(page).fill(`x${i}`);
    await back(page).click();
    await loadCard(page).click();
    await page.locator("[data-fighter]").first().waitFor({ timeout: 15_000 });
    await back(page).click();
  }
  await enterCard(page).click();
  assert.equal(await nameInput(page).inputValue(), "", "username kept from a previous visit");
  noPageErrors(page);
  await page.context().close();
});

await test("username: empty disables both choices, and the counter shows 0/24", async () => {
  const page = await open(browser, URL_);
  await toName(page);
  assert.ok(await nameInput(page).evaluate((el) => el === document.activeElement), "username box is not focused");
  assert.equal(await page.getByRole("button", { name: /Yes, scan me/ }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: /go masked/i }).isDisabled(), true);
  assert.match(await text(page), /0\/24/);
  await nameInput(page).press("Enter"); // must not start anything
  await sleep(500);
  assert.equal(await nameInput(page).count(), 1, "Enter on an empty username left the screen");
  await shot(page, "username-empty");
  await page.context().close();
});

await test("username: odd characters are dropped, long names cut at 24, uppercase shown", async () => {
  const page = await open(browser, URL_);
  await toName(page);
  const cases = [
    ["Hello World!@#", "HelloWorld"],
    ["José_Ünïcode", "Jos_ncode"],
    ["<script>alert(1)</script>", "scriptalert1script"],
    ["a".repeat(40), "a".repeat(24)],
    ["   ", ""],
    ["dot.dash-under_9", "dot.dash-under_9"],
  ];
  for (const [typed, expected] of cases) {
    await nameInput(page).fill("");
    await nameInput(page).pressSequentially(typed, { delay: 5 });
    assert.equal(await nameInput(page).inputValue(), expected, `typed ${typed}`);
  }
  await nameInput(page).fill("x".repeat(40)); // paste
  assert.equal(await nameInput(page).inputValue(), "x".repeat(24));
  assert.match(await text(page), /24\/24/);
  await shot(page, "username-long");
  await page.context().close();
});

await test("username: 'demo' (any case) shows Welcome back with the card", async () => {
  const page = await open(browser, URL_);
  await toName(page);
  for (const u of ["demo", "DEMO", "DeMo"]) {
    await nameInput(page).fill(u);
    await page.getByText("Welcome back").waitFor({ timeout: 10_000 });
  }
  const img = page.locator("form img").first();
  await img.waitFor();
  const ok = await img.evaluate((el) => el.complete && el.naturalWidth > 0);
  assert.ok(ok, "fighter card image did not load");
  await page.getByRole("button", { name: /Fight as demo/i }).waitFor();
  await shot(page, "welcome-back-demo");
  // A new username drops back to the consent prompt.
  await nameInput(page).fill(`new${Date.now() % 1e6}`);
  await page.getByText("Save fighter to memory card?").waitFor({ timeout: 10_000 });
  await page.context().close();
});

await test("username: Rescan me switches to the scan consent for the same username", async () => {
  const page = await open(browser, URL_);
  await toName(page);
  await nameInput(page).fill("demo");
  await page.getByText("Welcome back").waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: /Rescan me/i }).click();
  await page.getByText("Save fighter to memory card?").waitFor();
  assert.equal(await page.getByRole("button", { name: /Yes, scan me/ }).isEnabled(), true);
  assert.equal(await nameInput(page).inputValue(), "demo");
  await shot(page, "rescan-consent");
  await page.context().close();
});

await test("username: typing 'demo' and pressing Enter at once loads demo, not a new scan", async () => {
  // The profile lookup is debounced 300 ms; until it answers, the form's submit is "Yes, scan me".
  const page = await open(browser, URL_);
  await toName(page);
  await nameInput(page).pressSequentially("demo", { delay: 20 });
  await nameInput(page).press("Enter");
  const t = await waitText(page, /turn slowly|face the camera|step into view|get in position|starting camera|scanning|\bREADY\b|couldn't/i, 60_000);
  await shot(page, "enter-race");
  assert.doesNotMatch(t, /turn slowly|face the camera|step into view|get in position|scanning/i, "a fast Enter started a new scan for an existing username");
  await page.context().close();
}, { known: "E2E-03" });

await test("username: '.' and '..' are accepted but can never be looked up", async () => {
  const page = await open(browser, URL_);
  await toName(page);
  const urls = [];
  page.on("request", (r) => r.url().includes("/api/") && urls.push(r.url()));
  await nameInput(page).fill("..");
  await sleep(1500);
  const lookups = urls.filter((u) => /\/api\/profiles\/\.\.$/.test(u));
  note(`requests: ${urls.join(", ") || "none"}`);
  // fetch() collapses /api/profiles/.. to /api/, so a fighter saved as '..' can never come back.
  const enabled = await page.getByRole("button", { name: /Yes, scan me/ }).isEnabled();
  assert.ok(!enabled || lookups.length > 0, "'..' can be scanned and saved but its profile is never looked up");
  await page.context().close();
}, { known: "E2E-11" });

await test("Fight as demo: the saved 3D fighter loads in the arena", async () => {
  const page = await open(browser, URL_);
  const glb = [];
  page.on("response", (r) => r.url().endsWith(".glb") && glb.push(`${r.status()} ${r.url().split("/").slice(-2).join("/")}`));
  await toName(page);
  await nameInput(page).fill("demo");
  await page.getByText("Welcome back").waitFor({ timeout: 10_000 });
  const t0 = Date.now();
  await dblclick(page, page.getByRole("button", { name: /Fight as demo/i })); // a double click must not break it
  const t = await waitArena(page);
  note(`arena ready after ${Date.now() - t0} ms; glb: ${glb.join(", ")}`);
  assert.doesNotMatch(t, /couldn't/i, t.slice(0, 200));
  assert.ok(glb.some((g) => g.startsWith("200") && g.includes("rigged.glb")), "demo's rigged.glb was not loaded");
  await sleep(1500);
  await shot(page, "arena-demo");
  noPageErrors(page);
  await page.context().close();
});

await test("Load fighter: roster lists server and house fighters; picking one loads it", async () => {
  const page = await open(browser, URL_);
  await host(page);
  await loadCard(page).click();
  await page.locator("[data-fighter]").first().waitFor({ timeout: 15_000 });
  const ids = await page.locator("[data-fighter]").evaluateAll((els) => els.map((e) => e.getAttribute("data-fighter")));
  note(`${ids.length} tiles: ${ids.map((i) => i.slice(0, 8)).join(" ")}`);
  for (const house of ["default", "house-1", "house-2", "house-3"]) assert.ok(ids.includes(house), `missing ${house}`);
  assert.ok(ids.length >= 5, "no server fighters in the roster");
  await page.locator("[data-fighter]").nth(1).hover();
  await shot(page, "roster");
  await page.locator('[data-fighter="house-1"]').click();
  const t = await waitArena(page);
  assert.doesNotMatch(t, /couldn't/i);
  assert.match(t, /Kid Haymaker/i);
  await shot(page, "arena-house-fighter");
  noPageErrors(page);
  await page.context().close();
});

await test("Go masked: a new username fights without a scan", async () => {
  const page = await open(browser, URL_);
  const posts = [];
  page.on("request", (r) => r.method() === "POST" && posts.push(r.url()));
  await toName(page);
  await nameInput(page).fill("e2e-masked");
  await page.getByText("Save fighter to memory card?").waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: /go masked/i }).click();
  const t = await waitArena(page);
  assert.doesNotMatch(t, /couldn't/i);
  assert.match(t, /e2e-masked/i);
  assert.deepEqual(posts, [], "going masked sent a POST");
  await shot(page, "arena-masked");
  await page.context().close();
});

await test("keyboard: C hides and shows the camera picture-in-picture (not while typing)", async () => {
  const page = await open(browser, URL_);
  await toName(page);
  await nameInput(page).fill("e2e-keys");
  await page.getByRole("button", { name: /go masked/i }).click();
  await waitArena(page);
  const pip = page.locator("div.fixed canvas");
  await pip.waitFor({ timeout: 30_000 });
  await page.keyboard.press("c");
  await pip.waitFor({ state: "detached", timeout: 3000 });
  await shot(page, "pip-hidden");
  await page.keyboard.press("c");
  await pip.waitFor({ timeout: 3000 });
  await page.context().close();
});

await test("keyboard: D opens the pose debug monitor on the live site", async () => {
  const page = await open(browser, URL_);
  await toName(page);
  await nameInput(page).fill("e2e-debug");
  await page.getByRole("button", { name: /go masked/i }).click();
  await waitArena(page);
  await page.keyboard.press("d");
  await sleep(500);
  assert.match(await text(page), /landmark/i, "D does nothing in the production build (PoseDebugOverlay is DEV-only)");
  await page.context().close();
}, { known: "E2E-13" });

await test("refresh mid-flow returns to a working title screen", async () => {
  const page = await open(browser, URL_);
  await toName(page);
  await nameInput(page).fill("demo");
  await page.reload();
  await page.getByRole("button", { name: /Find a fight/ }).waitFor();
  await toName(page);
  await nameInput(page).fill("e2e-refresh");
  await page.getByRole("button", { name: /go masked/i }).click();
  await sleep(300);
  await page.reload(); // while the camera is starting
  await host(page);
  noPageErrors(page);
  await page.context().close();
});

await test("Join with a code: code box keeps 4 letters/digits; Join enables at 4; Back works", async () => {
  const page = await open(browser, URL_);
  await openJoin(page);
  const code = page.locator("#room-code");
  await code.pressSequentially("ab-1!c9z", { delay: 10 });
  assert.equal(await code.inputValue(), "AB1C");
  assert.equal(await page.getByRole("button", { name: /Join/ }).isEnabled(), true);
  await code.fill("ab");
  assert.equal(await page.getByRole("button", { name: /Join/ }).isDisabled(), true);
  await shot(page, "connect");
  await back(page).click();
  await page.getByRole("button", { name: /Create a room/ }).waitFor();
  await page.context().close();
});

await test("Join with a code: an unknown room code gives a clear error, and you can retry", async () => {
  const page = await open(browser, URL_);
  await openJoin(page);
  await page.locator("#room-code").fill("ZZZQ");
  await page.getByRole("button", { name: /Join/ }).click();
  const t = await waitText(page, /could not connect|no such room|not found|room/i, 20_000);
  await shot(page, "connect-bad-code");
  assert.match(t, /could not connect|no such room|not found/i, "no error for a code that doesn't exist");
  assert.equal(await page.getByRole("button", { name: /Join/ }).isEnabled(), true, "Join stays disabled after the error");
  await page.context().close();
}, { known: "E2E-08" });

await test("phone width (390 px): title and fighter select have no sideways scroll", async () => {
  const page = await open(browser, URL_, { viewport: { width: 390, height: 844 } });
  const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok((await overflow()) <= 0, "title scrolls sideways");
  await shot(page, "phone-title");
  await host(page);
  await shot(page, "phone-avatar");
  await enterCard(page).click();
  await nameInput(page).fill("demo");
  await page.getByText("Welcome back").waitFor({ timeout: 10_000 });
  await shot(page, "phone-welcome");
  const hidden = await page.getByRole("button", { name: /Fight as/ }).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > window.innerHeight || r.right > window.innerWidth;
  });
  assert.ok(!hidden, "Fight as button is off screen at phone width");
  await page.context().close();
});

await test("performance: title load time and frame rate", async () => {
  const page = await open(browser, URL_);
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    const res = performance.getEntriesByType("resource");
    return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), bytes: res.reduce((s, r) => s + (r.transferSize || 0), 0), count: res.length };
  });
  const fps = await page.evaluate(() => new Promise((r) => {
    let n = 0;
    const t = performance.now();
    const f = () => (++n, performance.now() - t < 3000 ? requestAnimationFrame(f) : r(Math.round(n / 3)));
    requestAnimationFrame(f);
  }));
  note(`DOMContentLoaded ${nav.dcl} ms, load ${nav.load} ms, ${nav.count} resources, ${Math.round(nav.bytes / 1024)} KB; title fps ${fps} (software GL)`);
  assert.ok(nav.load < 10_000, "title took over 10 s to load");
  await page.context().close();
});

await browser.close();
done("ui");
