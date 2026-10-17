// Builds the intent tuner as a static site for https://<matchmaker host>/tuner/ (dist/tuner).
import fs from "node:fs";
import { build } from "vite";

const out = "dist/tuner";
await build({
  base: "/tuner/",
  publicDir: false,
  logLevel: "warn",
  build: { outDir: out, emptyOutDir: true, rollupOptions: { input: { tuner: "test/tuner/index.html" } } },
});
// Vite keeps the source path; put the page at the root of the site.
fs.renameSync(`${out}/test/tuner/index.html`, `${out}/index.html`);
fs.rmSync(`${out}/test`, { recursive: true });
console.log(`built ${out}`);
