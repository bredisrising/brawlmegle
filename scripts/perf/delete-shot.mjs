// Visual check of "Delete my fighter" against a real local forge (forge/server.js with mock-fetch.mjs, a temp
// FORGE_DATA) and, for the delete code after a forge, a dev server with the mocked forge.
//   node delete-shot.mjs --port <CDP port> --base <site on the local forge> --mock <site on the mock forge>
//                        --forge <local forge URL> --out <dir> [--width 1366 --height 657]
// It forges three fighters (two scans of "rico", one "dylan"), gives this browser rico's owner keys, then deletes
// the newest rico from the memory card and dylan with his delete code on the Leaders screen, checking the forge each time.
import { chromium } from "playwright-core";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const port = arg("port", "9361");
const base = arg("base");
const mock = arg("mock");
const forge = arg("forge");
const out = arg("out", ".");
const W = Number(arg("width", "1366"));
const H = Number(arg("height", "657"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString("base64")}`;
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) }).then(() => console.log("shot", name));
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
};

async function forgeOne(name) {
  const res = await fetch(`${forge}/api/forge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, username: name, frames: [JPEG] }) });
  const created = await res.json();
  for (let i = 0; i < 200; i++) {
    const f = await (await fetch(`${forge}/api/forge/${created.id}`)).json();
    if (f.status === "ready") return created;
    await sleep(100);
  }
  throw new Error(`forge of ${name} never finished`);
}
const listed = async () => (await (await fetch(`${forge}/api/fighters`)).json()).map((f) => f.id);

const ricoOld = await forgeOne("rico");
await sleep(20);
const rico = await forgeOne("rico");
const dylan = await forgeOne("dylan");
console.log("forged", { ricoOld: ricoOld.id, rico: rico.id, dylan: dylan.id });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && console.log("page error:", m.text()));
// `perf`: window.__brawl (the store), for putting the K.O. screen up by hand.
const open = async (site, perf = false) => {
  await page.goto(`${site}?input=mock&walkout=0&record=0&video=0${perf ? "&perf=1" : ""}`, { waitUntil: "load", timeout: 120000 });
  await page.getByRole("button", { name: /VS CPU/ }).waitFor({ timeout: 60000 });
};
const memoryCard = async () => {
  await page.getByRole("button", { name: /VS CPU/ }).click();
  await page.getByRole("button", { name: /Load fighter/ }).click();
  await page.waitForSelector("[data-fighter]");
  await sleep(1500);
};

// This browser scanned both ricos: it holds their owner keys (as the game saves them when a forge starts).
await open(base);
await page.evaluate(({ a, b }) => {
  const owned = { [a.id]: { key: a.ownerKey, name: "rico", createdAt: 1 }, [b.id]: { key: b.ownerKey, name: "rico", createdAt: 2 } };
  localStorage.setItem("brawlegle.owned", JSON.stringify(owned));
}, { a: ricoOld, b: rico });
await open(base);
await memoryCard();
await shot(page, "1-memory-card");
const yours = await page.evaluate(() => [...document.querySelectorAll("[data-fighter]")].filter((t) => t.innerText.includes("YOURS") || t.textContent.includes("Yours")).map((t) => t.dataset.fighter));
check(yours.length === 1 && yours[0] === rico.id, `only the newest rico is marked Yours on the card (${yours})`);

await page.locator(`[data-owned="${rico.id}"]`).getByRole("button", { name: "Delete my fighter" }).click();
await sleep(400);
await shot(page, "2-confirm");
await page.getByRole("button", { name: /Delete for good/ }).click();
await page.getByText(/Deleted rico for good/).waitFor({ timeout: 10000 });
await sleep(400);
await shot(page, "3-deleted");
check(!(await listed()).includes(rico.id), "the forge no longer lists the deleted rico");
check((await listed()).includes(ricoOld.id), "rico's earlier fighter is current again");
check((await fetch(`${forge}/api/forge/${rico.id}`)).status === 404, "the deleted rico is a 404");
check(!(await page.locator(`[data-fighter="${rico.id}"]`).count()), "its tile is gone");
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("brawlegle.owned") ?? "{}"));
check(!stored[rico.id] && !!stored[ricoOld.id], "its owner key is gone from localStorage, the earlier one's kept");

// Back in: the earlier rico is on the card again, marked Yours.
await open(base);
await memoryCard();
await shot(page, "4-earlier-rico-back");

// Leaders: dylan's delete code, from another browser (it has no key for him).
await open(base);
await page.getByRole("button", { name: /Leaders/ }).click();
await sleep(1500);
await page.getByRole("button", { name: "Delete a fighter with a code" }).click();
await page.locator("#delete-code").pressSequentially(dylan.deleteCode.replace(/-/g, "").toLowerCase(), { delay: 10 });
await sleep(200);
await shot(page, "5-code-typed");
await page.getByRole("button", { name: /^Delete$/ }).click();
await sleep(300);
await shot(page, "6-code-confirm");
await page.getByRole("button", { name: /Delete for good/ }).click();
await page.getByText(/Deleted dylan for good/).waitFor({ timeout: 10000 });
await sleep(800);
await shot(page, "7-code-deleted");
check(!(await listed()).includes(dylan.id), "the forge no longer lists dylan");
check(!(await page.getByText("dylan", { exact: true }).count()), "the leaderboard dropped dylan");

// Narrow screen: the memory card's delete row still shows.
await page.setViewportSize({ width: 390, height: 844 });
await open(base);
await memoryCard();
await page.locator('[aria-label="Your fighters"]').scrollIntoViewIfNeeded();
await shot(page, "8-memory-card-phone");
await page.setViewportSize({ width: W, height: H });

// The delete code after a forge (mock forge): Create a room, scan, and the lobby shows it.
if (mock) {
  await open(mock, true);
  await page.getByRole("button", { name: /Play a friend/ }).click();
  await page.getByRole("button", { name: /Create a room/ }).click();
  await page.getByRole("button", { name: /Enter/ }).click();
  await page.locator("#fighter-name").fill("rico");
  await sleep(800);
  await page.getByRole("button", { name: /Yes, scan me/ }).click();
  await page.getByTestId("delete-code").waitFor({ timeout: 60000 });
  await sleep(1500);
  await shot(page, "9-code-after-forge");
  await page.evaluate(() => window.__brawl.store.setState({ phase: "ko", winner: "p1", ending: "ko" }));
  await sleep(1500);
  await shot(page, "10-code-on-ko");
  await page.getByRole("button", { name: "Got it" }).click();
  await sleep(300);
  check(!(await page.getByTestId("delete-code").count()), "Got it hides the delete code");
}

await ctx.close();
await browser.close();
