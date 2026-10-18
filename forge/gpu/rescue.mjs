// Re-rigs a forged fighter's existing model (no new model): for fighters whose rig failed, Tripo's or our own.
//
//   sudo bash -c 'set -a; . /etc/brawlegle/forge.env; node forge/gpu/rescue.mjs [options] /var/lib/brawlegle/forge/<id> [...]'
//
//   --attempt N   ask the GPU box for its rig path N (2: the envelope weights, see rig_blender.py)
//   --glb FILE    install FILE (a GLB rigged elsewhere with forge/gpu/rig_blender.py) instead of asking the box; one
//                 fighter folder only; --path NAME records the rigger's path that made it (fighter.json gpuRig)
//   --unhide      also take the fighter off the hidden list (rigcheck-all.js --hide put broken rigs there)
//   --force       install even if the rig check fails
//
// Rigs model.orig.glb, model.glb or else rigged.orig.glb (the rigger drops the old skeleton and weights) with the
// fighter's sheet.png. The GPU box needs FORGE_3D_URL and FORGE_3D_KEY. The optimized GLB the game will load must
// pass forge/rigcheck.js or nothing is changed. Before anything is overwritten, the originals are kept once as
// fighter.json.pre-rescue, rigged.pre-rescue.glb and rigged.orig.pre-rescue.glb. Then rigged.orig.glb is the new rig,
// rigged.glb its optimized copy, and fighter.json's glbUrl points at it again (brokenGlbUrl, set aside while the rig
// was broken, goes away). The forge server reads fighter.json at start, so restart it afterwards.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const attempt = Number(value("--attempt") ?? 1);
const glbFile = value("--glb");
const unhide = args.includes("--unhide");
const force = args.includes("--force");
const dirs = args.filter((a, i) => !a.startsWith("--") && !["--attempt", "--glb", "--path"].includes(args[i - 1]));
if (glbFile && dirs.length !== 1) {
  console.log("--glb installs one GLB into one fighter folder");
  process.exit(2);
}

const { optimizeGlb } = await import("../optimize.js");
const { checkRig, available } = await import("../rigcheck.js");
const checking = await available();
if (!checking) console.log("rig checker not installed (cd forge && npm ci): installing unchecked");

for (const dir of dirs) {
  const file = (f) => path.join(dir, f);
  const name = path.basename(dir).slice(0, 8);
  const start = Date.now();
  try {
    let rigged = null;
    let original;
    let rig = null;
    if (glbFile) {
      original = fs.readFileSync(glbFile);
      if (value("--path")) rig = { path: value("--path"), rescue: "local" };
    } else {
      const model = [file("model.orig.glb"), file("model.glb"), file("rigged.orig.glb")].find((f) => fs.existsSync(f));
      if (!model || !fs.existsSync(file("sheet.png"))) {
        console.log(`${dir}: needs sheet.png and model.orig.glb, model.glb or rigged.orig.glb`);
        continue;
      }
      const { makeModelLocal } = await import("../pipeline.js");
      const out = await makeModelLocal(fs.readFileSync(file("sheet.png")), () => {}, fs.readFileSync(model), attempt > 1 ? { rigAttempt: attempt } : {});
      rig = out.rig ?? null;
      if (out.optimized) [rigged, original] = [out.rigged, await out.original()];
      else original = out.rigged;
      console.log(`  ${name}: rigged ${path.basename(model)} on the GPU box`, rig ? `(${rig.path}${rig.ok ? "" : ", its own check FAILED"})` : "");
    }
    // Like a normal forge: the game gets the optimized GLB (rigged.orig.glb keeps the original).
    if (!rigged) {
      const result = await optimizeGlb(original).catch((err) => console.log(`  ${name}: optimize failed, keeping the original: ${err.message}`));
      rigged = result && result.bytesAfter < result.bytesBefore ? result.glb : original;
    }
    // Check what the game will load before touching anything.
    let check = null;
    if (checking) {
      const report = await checkRig(rigged);
      const fails = report.problems.filter((p) => p.level === "fail").map((p) => p.message);
      check = { ok: report.ok, score: report.score, ...(fails.length ? { problems: fails } : {}) };
      console.log(`  ${name}: rig check ${report.ok ? "ok" : "FAILED"}, score ${report.score}${fails.length ? `: ${fails.join("; ")}` : ""}`);
      if (!report.ok && !force) {
        console.log(`${dir}: not installed (the rig check failed; --force installs it anyway)`);
        continue;
      }
    }
    for (const [from, to] of [["fighter.json", "fighter.json.pre-rescue"], ["rigged.glb", "rigged.pre-rescue.glb"], ["rigged.orig.glb", "rigged.orig.pre-rescue.glb"]]) {
      if (fs.existsSync(file(from)) && !fs.existsSync(file(to))) fs.copyFileSync(file(from), file(to));
    }
    fs.writeFileSync(file("rigged.orig.glb"), original);
    fs.writeFileSync(file("rigged.glb"), rigged);
    const fighter = JSON.parse(fs.readFileSync(file("fighter.json"), "utf8"));
    fighter.glbUrl = `/api/forge/${fighter.id}/rigged.glb`;
    delete fighter.brokenGlbUrl;
    fighter.modelUrl ??= fighter.glbUrl;
    fighter.rigged = true;
    fighter.rigEngine = "local";
    fighter.glbOptimized = rigged !== original;
    if (rig) fighter.gpuRig = rig;
    if (check) fighter.rigCheck = { ...check, rescued: new Date().toISOString() };
    if (unhide) {
      delete fighter.hidden;
      delete fighter.hiddenReason;
    }
    delete fighter.modelError;
    fs.writeFileSync(file("fighter.json"), JSON.stringify(fighter, null, 2));
    const mb = (n) => (n / 2 ** 20).toFixed(1);
    console.log(`${dir}: rescued in ${((Date.now() - start) / 1000).toFixed(1)} s, ${mb(original.byteLength)} -> ${mb(rigged.byteLength)} MB`);
  } catch (err) {
    console.log(`${dir}: failed: ${err.message}`);
  }
}
