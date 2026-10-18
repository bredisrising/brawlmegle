// Rig QA for every fighter there is: runs forge/rigcheck.js on the GLB the game loads for each one.
//
//   On the server (every fighter folder, ready or not, hidden or not, old rescans included):
//     sudo bash -c 'set -a; . /etc/brawlegle/forge.env; node forge/rigcheck-all.js'        (FORGE_DATA, or forge/data)
//     node forge/rigcheck-all.js /var/lib/brawlegle/forge [--sheets /tmp/rigqa] [--json] [--hide]
//
//   From any laptop (only the fighters the memory card shows):
//     node forge/rigcheck-all.js --api https://54-149-60-196.sslip.io [--sheets dir]
//
// --sheets DIR  a contact sheet per fighter (front + side in the game's poses, colored by bone; rigcheck-sheet.js)
// --hide        mark every ready fighter whose rig fails as `hidden: true` (fighter.json.pre-hide keeps the original),
//               so /api/fighters and username log-ins skip it and the user's previous fighter shows instead. Nothing
//               is deleted. The server reads fighter.json at start: restart it afterwards (systemctl restart
//               brawlegle-forge). To undo, delete "hidden" (or put the .pre-hide copy back) and restart.
// Exit code 1 if any fighter the memory card would show fails.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRig } from "./rigcheck.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const api = value("--api");
const sheets = value("--sheets");
const asJson = flag("--json");
const hide = flag("--hide");
const positional = args.filter((a, i) => !a.startsWith("--") && !["--api", "--sheets"].includes(args[i - 1]));
const dataDir = positional[0] ?? process.env.FORGE_DATA ?? fileURLToPath(new URL("./data/", import.meta.url));
if (sheets) fs.mkdirSync(sheets, { recursive: true });
if (hide && api) {
  console.error("--hide works on the server's own folders, not over --api");
  process.exit(2);
}

/** Every fighter: { fighter, glb: () => bytes | null, dir? }. */
async function* fighters() {
  if (api) {
    const list = await (await fetch(`${api.replace(/\/$/, "")}/api/fighters`)).json();
    for (const fighter of list) {
      yield { fighter, glb: async () => (fighter.glbUrl ? Buffer.from(await (await fetch(fighter.glbUrl)).arrayBuffer()) : null) };
    }
    return;
  }
  const dirs = fs.readdirSync(dataDir).filter((d) => fs.existsSync(path.join(dataDir, d, "fighter.json")));
  const all = dirs.map((d) => ({ dir: path.join(dataDir, d), fighter: JSON.parse(fs.readFileSync(path.join(dataDir, d, "fighter.json"), "utf8")) }));
  all.sort((a, b) => (b.fighter.createdAt ?? 0) - (a.fighter.createdAt ?? 0));
  for (const { dir, fighter } of all) {
    // The file the game loads: glbUrl's (rigged.glb, or model.glb when rigging failed), as the server serves it.
    const file = fighter.glbUrl ? path.join(dir, path.basename(fighter.glbUrl.split("?")[0])) : null;
    yield { dir, fighter, glb: async () => (file && fs.existsSync(file) ? fs.readFileSync(file) : null) };
  }
}

/** Which engine made the model, and which rigged it, when that differs (fighters before engine3d existed were Tripo). */
const engineOf = (f) => {
  const model = f.engine3d ?? "tripo";
  const rig = f.rigEngine ?? f.rigCheck?.engine;
  return rig && rig !== model ? `${model}/${rig} rig` : model;
};

const rows = [];
let visibleFailures = 0;
for await (const { dir, fighter: f, glb } of fighters()) {
  const row = {
    id: f.id,
    name: f.name,
    username: f.username ?? "",
    engine: engineOf(f),
    quality: f.quality ?? "",
    status: f.status,
    hidden: Boolean(f.hidden),
    created: f.createdAt ? new Date(f.createdAt).toISOString().slice(0, 16) : "",
  };
  const bytes = await glb().catch(() => null);
  if (!bytes) {
    row.verdict = f.status === "ready" ? "no model (default body)" : "-";
  } else {
    const report = await checkRig(bytes, { keep: Boolean(sheets) });
    row.verdict = report.ok ? "ok" : "FAIL";
    row.score = report.score;
    row.ms = report.stats.ms;
    row.problems = report.problems.filter((p) => p.level === "fail").map((p) => p.message);
    if (sheets) {
      const { contactSheet } = await import("./rigcheck-sheet.js");
      row.sheet = await contactSheet(report, path.join(sheets, `${f.id}.png`), `${f.name} (${f.id.slice(0, 8)}) ${row.engine}${row.quality ? ` ${row.quality}` : ""}`);
    }
    if (!report.ok && f.status === "ready" && !f.hidden) {
      visibleFailures++;
      if (hide && dir) {
        const file = path.join(dir, "fighter.json");
        if (!fs.existsSync(`${file}.pre-hide`)) fs.copyFileSync(file, `${file}.pre-hide`);
        const updated = { ...f, hidden: true, hiddenReason: `rig check failed: ${row.problems[0] ?? "?"}`, rigCheck: { ok: false, score: report.score, problems: row.problems } };
        fs.writeFileSync(file, JSON.stringify(updated, null, 2));
        row.hidden = true;
        row.justHidden = true;
      }
    }
  }
  rows.push(row);
  if (asJson) console.log(JSON.stringify(row));
}

if (!asJson) {
  const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
  console.log(`${pad("id", 9)} ${pad("name", 12)} ${pad("user", 10)} ${pad("engine", 16)} ${pad("qual", 4)} ${pad("status", 7)} ${pad("hidden", 6)} ${pad("verdict", 8)} score  problems`);
  for (const r of rows) {
    console.log(
      `${pad(r.id.slice(0, 8), 9)} ${pad(r.name, 12)} ${pad(r.username, 10)} ${pad(r.engine, 16)} ${pad(r.quality, 4)} ${pad(r.status, 7)} ${pad(r.hidden ? (r.justHidden ? "NOW" : "yes") : "", 6)} ${pad(r.verdict, 8)} ${String(r.score ?? "").padStart(5)}  ${(r.problems ?? []).join("; ").slice(0, 160)}`,
    );
  }
  const failed = rows.filter((r) => r.verdict === "FAIL");
  console.log(`\n${rows.length} fighters, ${failed.length} failing the rig check, ${visibleFailures} of them on the memory card${hide ? " (hidden now: restart the forge server)" : ""}.`);
  if (visibleFailures && !hide && !api) console.log("Hide them (nothing is deleted): node forge/rigcheck-all.js --hide, then restart the forge server.");
}
process.exit(visibleFailures && !hide ? 1 : 0);
