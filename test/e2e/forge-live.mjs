// ONE real scan + forge through the game, like a new player: costs OpenAI + Tripo credits, so it only runs with
// E2E_PAID=1 and E2E_VIDEO (a .y4m of a person turning around). Logs each status line with its time.
//   E2E_PAID=1 E2E_VIDEO=person.y4m node test/e2e/forge-live.mjs
import { BASE, FORGE, PERSON_VIDEO, assert, done, http, launch, note, open, shot, sleep, test } from "./lib.mjs";

const paid = process.env.E2E_PAID === "1";
const skip = !paid ? "set E2E_PAID=1 (spends forge credits)" : !PERSON_VIDEO ? "set E2E_VIDEO" : undefined;

await test("new username: consent, scan, forge, 3D fighter in the arena, saved to the profile", async () => {
  const username = `e2e-${Date.now().toString(36)}`;
  const browser = await launch({ camera: "person" });
  try {
    const page = await open(browser, `${BASE}/?pose=lite`);
    const glb = [];
    page.on("response", (r) => r.url().endsWith(".glb") && glb.push(`${r.status()} ${r.url().split("/").pop()}`));
    await page.getByRole("button", { name: /Host/ }).click();
    await page.locator("button", { hasText: "Type your username" }).click();
    await page.locator("#fighter-name").fill(username);
    await page.getByText("Save fighter to memory card?").waitFor({ timeout: 10_000 });
    const t0 = Date.now();
    await page.getByRole("button", { name: /Yes, scan me/ }).click();
    let last = "";
    let shots = 0;
    for (;;) {
      const t = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      const line = (t.match(/(turn[^_]*|sizing you up|drawing your fighter|building your 3d model|polishing|rigging your fighter|forging[^_]*|fighter ready|forge failed[^_]*|couldn't set up[^.]*)/i) ?? [""])[0].slice(0, 90);
      if (line && line !== last) {
        note(`${((Date.now() - t0) / 1000).toFixed(0)} s: ${line}`);
        last = line;
        if (shots < 6) await shot(page, `forge-live-${shots++}`);
      }
      if (/\bREADY\b/.test(t) && !/scanning|forging/i.test(t)) break;
      if (/couldn't set up/i.test(t)) throw new Error(line);
      if (Date.now() - t0 > 6 * 60_000) throw new Error(`stuck at: ${last}`);
      await sleep(1000);
    }
    note(`arena after ${((Date.now() - t0) / 1000).toFixed(0)} s; glb: ${glb.join(", ")}`);
    await sleep(2000);
    await shot(page, "forge-live-arena");
    const p = await http(`${FORGE}/api/profiles/${username}`);
    assert.equal(p.status, 200);
    assert.ok(p.json.fighter, "the new fighter isn't saved under the username");
    note(`saved as ${p.json.fighter.id} "${p.json.fighter.name}", timings ${JSON.stringify(p.json.fighter.timings)}`);
    assert.ok(p.json.fighter.glbUrl, "no 3D model");
  } finally {
    await browser.close();
  }
}, { skip });

done("forge-live");
