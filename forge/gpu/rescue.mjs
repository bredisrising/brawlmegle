// Rigs a forged fighter's existing static model on the GPU box (no new model), for fighters whose Tripo rig failed.
//
//   sudo bash -c 'set -a; . /etc/brawlegle/forge.env; node forge/gpu/rescue.mjs /var/lib/brawlegle/forge/<id> [...]'
//
// Needs FORGE_3D_URL and FORGE_3D_KEY. Uses the fighter's sheet.png and model.orig.glb (or model.glb), writes
// rigged.glb next to them and points fighter.json's glbUrl at it. The forge server reads fighter.json at start,
// so restart it afterwards.
import fs from "node:fs";
import path from "node:path";

const { makeModelLocal } = await import("../pipeline.js");
for (const dir of process.argv.slice(2)) {
  const file = (f) => path.join(dir, f);
  const model = [file("model.orig.glb"), file("model.glb")].find((f) => fs.existsSync(f));
  if (!model || !fs.existsSync(file("sheet.png"))) {
    console.log(`${dir}: needs sheet.png and model.orig.glb or model.glb`);
    continue;
  }
  const start = Date.now();
  try {
    const out = await makeModelLocal(fs.readFileSync(file("sheet.png")), () => {}, fs.readFileSync(model));
    fs.writeFileSync(file("rigged.glb"), out.rigged);
    const fighter = JSON.parse(fs.readFileSync(file("fighter.json"), "utf8"));
    fighter.glbUrl = `/api/forge/${fighter.id}/rigged.glb`;
    if (path.basename(model) === "model.glb") fighter.modelUrl ??= `/api/forge/${fighter.id}/model.glb`;
    fighter.rigged = true;
    fighter.rigEngine = "local";
    delete fighter.modelError;
    fs.writeFileSync(file("fighter.json"), JSON.stringify(fighter, null, 2));
    console.log(`${dir}: rigged in ${((Date.now() - start) / 1000).toFixed(1)} s`, out.timings);
  } catch (err) {
    console.log(`${dir}: failed: ${err.message}`);
  }
}
