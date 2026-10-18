// Renders cards.html frame by frame (seeking its CSS animations, so every frame is exact) to transparent PNGs.
//   node render-cards.mjs <outDir> <width>x<height> <specs.json> [fps=60] [chromium executable]
// specs.json: [{ "name": "title", "dur": 4.2, "q": { "card": "title" } }, ...] -> <outDir>/<name>/00000.png ...
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const [outDir, size, specsFile, fpsArg, exe] = process.argv.slice(2);
const [width, height] = size.split("x").map(Number);
const fps = Number(fpsArg ?? 60);
const specs = JSON.parse(fs.readFileSync(specsFile, "utf8"));
const page_ = pathToFileURL(path.join(import.meta.dirname, "cards.html")).href;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width, height } });
for (const spec of specs) {
  const dir = path.join(outDir, spec.name);
  fs.mkdirSync(dir, { recursive: true });
  const q = new URLSearchParams({ ...spec.q, dur: String(spec.dur) });
  await page.goto(`${page_}?${q}`);
  await page.evaluate(() => window.cardReady);
  await page.waitForTimeout(300);
  const frames = spec.still ? 1 : Math.round(spec.dur * fps);
  for (let i = 0; i < frames; i++) {
    const t = i / fps;
    await page.evaluate((t) => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = t * 1000;
      }
      window.onCardTime?.(t);
    }, t);
    await page.screenshot({ path: path.join(dir, `${String(i).padStart(5, "0")}.png`), omitBackground: true });
  }
  console.log(spec.name, frames, "frames");
}
await browser.close();
