// Builds the scan test page as a static site for https://<matchmaker host>/scan/ (dist/scan).
// The forge URL is set per visit with ?forge=… (the forge must allow this origin: FORGE_ALLOWED_ORIGINS).
import fs from "node:fs";
import { build } from "vite";

const out = "dist/scan";
await build({
  base: "/scan/",
  publicDir: false,
  logLevel: "warn",
  build: { outDir: out, emptyOutDir: true, rollupOptions: { input: { scan: "test/scan/index.html" } } },
});
// Vite keeps the source path; put the page at the root of the site.
fs.renameSync(`${out}/test/scan/index.html`, `${out}/index.html`);
fs.rmSync(`${out}/test`, { recursive: true });
console.log(`built ${out}`);
