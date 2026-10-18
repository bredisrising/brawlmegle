// Camera edge cases: permission denied, no camera at all, and nobody in view during a scan. Each must end in a
// clear message and a way to try again. The nobody-in-view scan must not reach the (paid) forge.
import { BASE, assert, done, launch, note, open, setupError, shot, sleep, test, waitArena, waitText } from "./lib.mjs";

const URL_ = `${BASE}/?pose=lite`;
async function toName(page) {
  await page.getByRole("button", { name: /Host/ }).click();
  await page.locator("button", { hasText: "Type your username" }).click();
  await page.locator("#fighter-name").waitFor();
}

/** Pick demo's saved fighter (needs the camera too: it's the controller), expect a clear camera error. */
async function cameraError(camera, shotName) {
  const browser = await launch({ camera });
  try {
    const page = await open(browser, URL_);
    await toName(page);
    await page.locator("#fighter-name").fill("demo");
    await page.getByText("Welcome back").waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: /Fight as demo/i }).click();
    const t = await waitArena(page, 60_000);
    await sleep(500);
    await shot(page, shotName);
    const msg = setupError(t);
    note(`message: "${msg}"; console: ${page.log.console.join(" | ").slice(0, 160)}`);
    assert.ok(msg, "no error shown: the fighter loaded without a camera");
    // Recoverable: back on the fighter select, Enter works again.
    await page.locator("button", { hasText: "Type your username" }).click();
    await page.locator("#fighter-name").waitFor();
    return msg;
  } finally {
    await browser.close();
  }
}

await test("camera permission denied: clear message that names the camera, and you can retry", async () => {
  const msg = await cameraError("denied", "camera-denied");
  assert.match(msg, /camera/i, "the message doesn't say it's about the camera");
  assert.match(msg, /allow|permission|blocked/i);
}, { known: "E2E-06" });

await test("no camera at all: clear message that names the camera, and you can retry", async () => {
  const msg = await cameraError("none", "camera-none");
  assert.match(msg, /camera/i, "the message doesn't say it's about the camera");
}, { known: "E2E-06" });

await test("nobody in view during the scan: clear message, no forge call, and you can retry", async () => {
  const browser = await launch({ camera: "fake" }); // Chrome's test pattern: no person
  try {
    const page = await open(browser, URL_);
    const posts = [];
    page.on("request", (r) => r.method() === "POST" && r.url().includes("/api/forge") && posts.push(r.url()));
    await toName(page);
    await page.locator("#fighter-name").fill(`e2e-nobody-${Date.now() % 1e6}`);
    await page.getByText("Save fighter to memory card?").waitFor({ timeout: 10_000 });
    const t0 = Date.now();
    await page.getByRole("button", { name: /Yes, scan me/ }).click();
    await waitText(page, /turn slowly|step into view/i, 90_000);
    note(`scan started after ${Date.now() - t0} ms`);
    await sleep(3000);
    await shot(page, "scan-nobody-during");
    const t = await waitText(page, /couldn't set up/i, 90_000);
    note(`gave up after ${Date.now() - t0} ms: "${setupError(t)}"`);
    await shot(page, "scan-nobody-error");
    assert.deepEqual(posts, [], "an empty scan was sent to the forge");
    assert.match(setupError(t), /nobody|no one|in view/i);
    await page.locator("button", { hasText: "Type your username" }).click();
    await page.locator("#fighter-name").waitFor();
  } finally {
    await browser.close();
  }
});

done("camera");
