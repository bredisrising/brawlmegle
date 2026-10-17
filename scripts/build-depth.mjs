// Builds the depth spike page as a static site for https://<matchmaker host>/depth/ (dist/depth).
import fs from "node:fs";
import { build } from "vite";

const out = "dist/depth";
await build({
  base: "/depth/",
  publicDir: false,
  logLevel: "warn",
  build: { outDir: out, emptyOutDir: true, rollupOptions: { input: { depth: "test/depth/index.html" } } },
});
// Vite keeps the source path; put the page at the root of the site.
fs.renameSync(`${out}/test/depth/index.html`, `${out}/index.html`);
fs.rmSync(`${out}/test`, { recursive: true });
console.log(`built ${out}`);
