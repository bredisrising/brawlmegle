// The forge's fighter optimizer (forge/optimize.js) as a command, for the GPU box: it optimizes rigged.glb right
// after the rig, on a faster CPU than the forge box's, and the forge only stores the result.
//
//   node optimize-glb.mjs in.glb out.glb
//
// setup.sh installs it with optimize.js and its packages in /opt/forge3d/optimizer (here it imports ../optimize.js).
import fs from "node:fs";

const local = new URL("./optimize.js", import.meta.url);
const { optimizeGlb, FIGHTER } = await import(fs.existsSync(local) ? local.href : new URL("../optimize.js", import.meta.url).href);
const [input, output] = process.argv.slice(2);
const result = await optimizeGlb(fs.readFileSync(input), FIGHTER);
if (!result || result.bytesAfter >= result.bytesBefore) {
  console.error("not smaller, keeping the original");
  process.exit(1);
}
fs.writeFileSync(output, result.glb);
console.log(`${(result.bytesBefore / 2 ** 20).toFixed(1)} -> ${(result.bytesAfter / 2 ** 20).toFixed(1)} MB in ${result.ms} ms`);
