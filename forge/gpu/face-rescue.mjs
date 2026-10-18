// Paints the sheet's face onto fighters that were forged before the face step (forge/gpu/face_project.py). The rig,
// UVs and mesh stay as they are; only the base-color texture changes.
//
//   sudo bash -c 'set -a; . /etc/brawlegle/forge.env; node forge/gpu/face-rescue.mjs [options] /var/lib/brawlegle/forge/<id> [...]'
//
//   --dry-run DIR   write the results to DIR/<id>/ (rigged.glb, rigged.orig.glb, face.json) and install nothing
//   --python PATH   run face_project.py here with this Python (numpy, opencv, pillow, mediapipe) instead of on the
//                   GPU box; --face-model FILE is its face_landmarker.task (default: next to this script)
//   --all           also fighters whose model isn't TRELLIS's (Tripo's faces are already sharp)
//   --force         install even if the rig check fails
//   --undo          put the pre-face files back (and forget gpuFace)
//
// The GPU box (FORGE_3D_URL, FORGE_3D_KEY) gets a face-only job: no new model, no re-rig. It always starts from the
// unpainted original (rigged.orig.pre-face.glb once a run has made one, else rigged.orig.glb), so running it twice
// doesn't paint twice. When the box can't match the faces well enough (say the sheet's head is turned) nothing changes.
// The optimized GLB the game will load must pass forge/rigcheck.js. Before anything is overwritten, the originals are
// kept once as fighter.json.pre-face, rigged.pre-face.glb and rigged.orig.pre-face.glb. The GLB's URL changes by
// itself (?v= is its write time); restart the forge server to show gpuFace in fighter.json.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const dryRun = value("--dry-run");
const python = value("--python");
const faceModel = value("--face-model") ?? new URL("./face_landmarker.task", import.meta.url).pathname;
const all = args.includes("--all");
const force = args.includes("--force");
const undo = args.includes("--undo");
const takesValue = ["--dry-run", "--python", "--face-model"];
const dirs = args.filter((a, i) => !a.startsWith("--") && !takesValue.includes(args[i - 1]));
const BACKUPS = [["fighter.json", "fighter.json.pre-face"], ["rigged.glb", "rigged.pre-face.glb"], ["rigged.orig.glb", "rigged.orig.pre-face.glb"]];

const { optimizeGlb } = await import("../optimize.js");
const { checkRig, available } = await import("../rigcheck.js");
const checking = await available();
if (!checking) console.log("rig checker not installed (cd forge && npm ci): installing unchecked");

/** face_project.py on this machine: { glb (or null: nothing painted), face (its report) }. */
function paintHere(glb, sheet) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "face-"));
  try {
    const out = path.join(tmp, "out.glb");
    const script = new URL("./face_project.py", import.meta.url).pathname;
    const stdout = execFileSync(python, [script, glb, sheet, out, "--face-model", faceModel], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const info = JSON.parse(/^FACE_RESULT (.*)$/m.exec(stdout)[1]);
    const face = { painted: Boolean(info.ok), ...Object.fromEntries(["skipped", "face", "texture", "front", "iou", "seconds"].filter((k) => k in info).map((k) => [k, info[k]])) };
    return { glb: info.ok ? fs.readFileSync(out) : null, face };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

for (const dir of dirs) {
  const file = (f) => path.join(dir, f);
  const name = path.basename(dir).slice(0, 8);
  const start = Date.now();
  try {
    if (undo) {
      if (!fs.existsSync(file("rigged.orig.pre-face.glb"))) {
        console.log(`${dir}: no pre-face backup, nothing to undo`);
        continue;
      }
      for (const [to, from] of BACKUPS) if (fs.existsSync(file(from))) fs.copyFileSync(file(from), file(to));
      for (const [, from] of BACKUPS) fs.rmSync(file(from), { force: true });
      console.log(`${dir}: back to the pre-face model`);
      continue;
    }
    const fighter = JSON.parse(fs.readFileSync(file("fighter.json"), "utf8"));
    if (!all && fighter.engine3d !== "local") {
      console.log(`${dir}: skipped (not a TRELLIS model; --all to paint it anyway)`);
      continue;
    }
    const source = [file("rigged.orig.pre-face.glb"), file("rigged.orig.glb")].find((f) => fs.existsSync(f));
    if (!source || !fs.existsSync(file("sheet.png"))) {
      console.log(`${dir}: needs sheet.png and rigged.orig.glb`);
      continue;
    }
    let painted;
    let original;
    let face;
    if (python) {
      const out = paintHere(source, file("sheet.png"));
      face = out.face;
      original = out.glb;
    } else {
      const { makeModelLocal } = await import("../pipeline.js");
      const out = await makeModelLocal(fs.readFileSync(file("sheet.png")), () => {}, fs.readFileSync(source), { faceOnly: true });
      face = out.face ?? { painted: false, error: "the GPU box has no face step (deploy face_project.py)" };
      if (face.painted) [painted, original] = out.optimized ? [out.rigged, await out.original()] : [null, out.rigged];
    }
    console.log(`  ${name}: face ${face.painted ? "painted" : "NOT painted"} in ${face.seconds ?? "?"} s`, JSON.stringify(face.face ?? face.skipped ?? face.error ?? ""));
    if (!face.painted || !original) {
      console.log(`${dir}: unchanged (${face.skipped ?? face.error ?? "nothing painted"})`);
      continue;
    }
    // Like a normal forge: the game gets the optimized GLB (rigged.orig.glb keeps the original).
    if (!painted) {
      const result = await optimizeGlb(original).catch((err) => console.log(`  ${name}: optimize failed, keeping the original: ${err.message}`));
      painted = result && result.bytesAfter < result.bytesBefore ? result.glb : original;
    }
    let check = null;
    if (checking) {
      const report = await checkRig(painted);
      const fails = report.problems.filter((p) => p.level === "fail").map((p) => p.message);
      check = { ok: report.ok, score: report.score };
      console.log(`  ${name}: rig check ${report.ok ? "ok" : "FAILED"}, score ${report.score}${fails.length ? `: ${fails.join("; ")}` : ""}`);
      if (!report.ok && !force) {
        console.log(`${dir}: not installed (the rig check failed; --force installs it anyway)`);
        continue;
      }
    }
    const mb = (n) => (n / 2 ** 20).toFixed(1);
    if (dryRun) {
      const out = path.join(dryRun, path.basename(dir));
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, "rigged.orig.glb"), original);
      fs.writeFileSync(path.join(out, "rigged.glb"), painted);
      fs.writeFileSync(path.join(out, "face.json"), JSON.stringify({ ...face, check }, null, 2));
      console.log(`${dir}: dry run, written to ${out} (${mb(painted.byteLength)} MB for the game)`);
      continue;
    }
    for (const [from, to] of BACKUPS) {
      if (fs.existsSync(file(from)) && !fs.existsSync(file(to))) fs.copyFileSync(file(from), file(to));
    }
    fs.writeFileSync(file("rigged.orig.glb"), original);
    fs.writeFileSync(file("rigged.glb"), painted);
    fighter.glbOptimized = painted !== original;
    fighter.gpuFace = { ...face, rescued: new Date().toISOString() };
    if (check) fighter.rigCheck = { ...(fighter.rigCheck ?? {}), ...check, checked: new Date().toISOString() };
    fs.writeFileSync(file("fighter.json"), JSON.stringify(fighter, null, 2));
    console.log(`${dir}: face painted in ${((Date.now() - start) / 1000).toFixed(1)} s, ${mb(painted.byteLength)} MB for the game`);
  } catch (err) {
    console.log(`${dir}: failed: ${err.message}`);
  }
}
