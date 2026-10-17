// Turns video files into pose clips (JSONL) using the game's MediaPipe model in headless Chrome.
// Usage: node test/pose/extract.mjs [--model lite|full|heavy] [--fps 30] video.mp4 [...]
// Writes <video>.<model>.jsonl next to each video: a header line, then one PoseFrame per line.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { createServer } from "vite";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args.splice(i, 2)[1];
};
const model = option("model", "full");
const fpsOverride = option("fps", null);
if (args.length === 0) throw new Error("usage: extract.mjs [--model full] [--fps 30] video.mp4 ...");

const root = fileURLToPath(new URL("../..", import.meta.url));
const vite = await createServer({ root, logLevel: "warn", server: { port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
});
try {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.error("[page]", m.text()));
  await page.goto(`${vite.resolvedUrls.local[0]}test/pose/extract.html`);
  await page.waitForFunction(() => window.ready === true);

  for (const video of args) {
    const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", video]).toString().trim();
    const [num, den] = probe.split("/").map(Number);
    const fps = Number(fpsOverride ?? Math.round(num / den));
    const started = Date.now();
    const base64 = fs.readFileSync(video).toString("base64");
    const frames = await page.evaluate(async ({ base64, model, fps }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      return window.extract(url, model, fps);
    }, { base64, model, fps });
    const out = video.replace(/\.[^.]+$/, `.${model}.jsonl`);
    const header = { clip: path.basename(video), model, fps, frames: frames.length };
    fs.writeFileSync(out, [header, ...frames].map((x) => JSON.stringify(x)).join("\n") + "\n");
    const tracked = frames.filter((f) => !f.missing).length;
    console.log(`${path.basename(out)}: ${frames.length} frames, ${tracked} tracked, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
} finally {
  await browser.close();
  await vite.close();
}
