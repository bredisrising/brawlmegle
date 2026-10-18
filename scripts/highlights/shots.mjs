// Title screen screenshots at the sizes that matter (short laptops, full HD, a phone), from a browser started with
// scripts/highlights/edge.sh. Also reports whether the title scrolls at each size.
//   node shots.mjs --port 9444 --url http://localhost:5181/ --out C:\...\prefix [--wait 2500] [--sizes 1366x657,...]
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const PORT = arg("port", "9444");
const URL_ = arg("url", "http://localhost:5181/");
const OUT = arg("out", "shot");
const WAIT = Number(arg("wait", 2500));
const SIZES = String(arg("sizes", "1366x657,1280x600,1536x730,1920x1080,390x844")).split(",");

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
for (const size of SIZES) {
  const [width, height] = size.split("x").map(Number);
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height }, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  page.on("console", (m) => m.type() === "error" && console.log("console", m.text()));
  await page.goto(URL_, { waitUntil: "load", timeout: 120000 });
  await page.waitForTimeout(WAIT);
  const scroll = await page.evaluate(() => {
    const els = [...document.querySelectorAll("*")].filter((e) => e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY !== "hidden" && getComputedStyle(e).overflowY !== "visible");
    return els.map((e) => `${e.tagName}.${String(e.className).slice(0, 40)} ${e.scrollHeight}>${e.clientHeight}`);
  });
  await page.screenshot({ path: `${OUT}-${size}.png` });
  console.log(size, scroll.length ? `SCROLLS: ${scroll.join(" | ")}` : "no scroll");
  await context.close();
}
await browser.close();
