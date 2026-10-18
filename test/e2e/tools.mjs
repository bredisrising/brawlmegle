// The hosted tools: the move tester (/tuner/, including the fight panel) and the scan test (/scan/), with the
// fake camera. With E2E_VIDEO (a person turning) the scan page must capture front/left/right; it never forges.
import { BASE, PERSON_VIDEO, assert, done, launch, note, open, shot, sleep, test } from "./lib.mjs";

const local = /localhost|127\.0\.0\.1/.test(BASE);
const TUNER = `${BASE}${local ? "/test/tuner/" : "/tuner/"}?pose=lite`;
const SCAN = `${BASE}${local ? "/test/scan/" : "/scan/"}?pose=lite`;
const browser = await launch({ camera: PERSON_VIDEO ? "person" : "fake" });

async function waitFor(fn, timeout, what) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}

await test("tuner: loads, starts the camera and tracks", async () => {
  const page = await open(browser, TUNER);
  note(`load ${page.log.loadMs} ms`);
  await page.locator("#camera").click();
  const status = page.locator("#status");
  const t0 = Date.now();
  await waitFor(async () => /fps tracked/i.test(await status.innerText()), 90_000, "camera start");
  note(`camera up after ${Date.now() - t0} ms`);
  if (PERSON_VIDEO) await waitFor(async () => /· tracking/.test(await status.innerText()), 60_000, "never tracked the person on camera");
  note(`status: ${(await status.innerText()).replace(/\s+/g, " ").slice(0, 140)}`);
  await sleep(2000);
  await shot(page, "tuner");
  assert.deepEqual(page.log.errors, []);
  if (PERSON_VIDEO) {
    const core = await page.locator("#core").innerText();
    note(`body panel: ${core.replace(/\s+/g, " ").slice(0, 120)}`);
  }
  await page.context().close();
});

await test("tuner: fight panel runs against each CPU level and resets", async () => {
  const page = await open(browser, TUNER);
  await page.locator("#camera").click();
  await sleep(3000);
  const levels = await page.locator("#dummyLevel option").evaluateAll((o) => o.map((x) => x.value));
  assert.deepEqual(levels, ["off", "easy", "normal", "hard"]);
  await page.locator("#dummyLevel").selectOption("hard");
  await page.locator("#fightReset").click();
  const hp = async () => [await page.locator("#hpn1").innerText(), await page.locator("#hpn2").innerText()];
  const start = await hp();
  note(`hp at reset: ${start.join(" / ")}`);
  // A hard CPU should land something on a player who just stands there.
  await sleep(20_000);
  const later = await hp();
  const log = await page.locator("#fightLog").innerText();
  note(`hp after 20 s vs hard CPU: ${later.join(" / ")}; log lines: ${log.split("\n").filter(Boolean).length}; ${await page.locator("#phases").innerText()}`);
  await shot(page, "tuner-fight");
  await page.context().close();
  assert.ok(log.trim().length > 0 || later[0] !== start[0], "nothing happened in 20 s against the hard CPU");
}, { known: "E2E-15" });

await test("tuner: fight panel reset restores HP", async () => {
  const page = await open(browser, TUNER);
  await page.locator("#fightReset").click();
  await sleep(500);
  const hp = async () => [await page.locator("#hpn1").innerText(), await page.locator("#hpn2").innerText()];
  const start = await hp();
  assert.deepEqual(start, ["100", "100"]);
  await page.locator("#fightReset").click();
  await sleep(500);
  assert.deepEqual(await hp(), start, "reset didn't restore HP");
  await page.context().close();
});

await test("scan page: start camera, scan, get front/left/right (no forge)", async () => {
  const page = await open(browser, SCAN);
  note(`load ${page.log.loadMs} ms`);
  await page.locator("#camera").click();
  await waitFor(() => page.locator("#scan").isEnabled(), 90_000, "Scan button never enabled");
  await page.locator("#scan").click();
  const t0 = Date.now();
  await waitFor(async () => /ready to forge|scan again/i.test(await page.locator("#forgeStatus").innerText()), 120_000, "scan never finished");
  const status = await page.locator("#forgeStatus").innerText();
  const sizes = await page.locator("#sizes").innerText();
  note(`scan done after ${Date.now() - t0} ms: ${status} | ${sizes.replace(/\s+/g, " ")}`);
  await shot(page, "scan-page");
  if (PERSON_VIDEO) assert.match(status, /ready to forge/i, "a person on camera produced no frames");
  else assert.match(status, /scan again/i, "the test pattern (nobody) produced frames");
  await page.context().close();
});

await browser.close();
done("tools");
