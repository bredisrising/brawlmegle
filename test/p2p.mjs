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
  env: { ...process.env, PORT: String(port), TURN_HOST: "turn.invalid", TURN_SECRET: "test-secret" },
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
  args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

let failed = true;
try {
  const page = await browser.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") console.log(`  [browser ${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => console.log(`  [browser] ${err.message}`));
  await page.goto(`${base}test/p2p/?signal=${encodeURIComponent(`ws://127.0.0.1:${port}/ws`)}`);
  await page.waitForFunction(() => window.__p2p?.done, null, { timeout: 120_000 });
  const results = await page.evaluate(() => window.__p2p.results);
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name} (${r.ms} ms)${r.error ? `\n     ${r.error}` : ""}`);
  failed = results.length === 0 || results.some((r) => !r.ok);
  console.log(failed ? "p2p test failed" : "all passed");
} finally {
  await browser.close();
  await vite.close();
  matchmaker.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);
