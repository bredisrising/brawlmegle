#!/usr/bin/env node
/**
 * Delete fighters for good, by hand: for "message us" requests (older fighters have no owner key, or someone lost
 * their delete code). Same full deletion as "Delete my fighter" (owner.js purgeFighter): the fighter's folder (scan
 * photos, sheet, card, every GLB and backup), its record, and the K.O. highlights that show it.
 *
 *   node delete-fighter.mjs <fighter id | username> [--yes]
 *
 * A username means every fighter saved under it (each rescan is one). Without --yes it only lists what would go.
 * With the forge running on this machine (FORGE_PORT, default 8787) it asks the server to do it, so its memory and the
 * memory card update at once; with the server stopped it deletes on disk directly. On the box:
 *
 *   cd /opt/brawlegle/forge && sudo -u brawlegle FORGE_DATA=/var/lib/brawlegle/forge node delete-fighter.mjs dylan --yes
 */
import fs from "node:fs";
import { purgeFighter, readState } from "./owner.js";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("usage: node delete-fighter.mjs <fighter id | username> [--yes]");
  process.exit(2);
}

const DATA = process.env.FORGE_DATA ? new URL(`file://${process.env.FORGE_DATA.replace(/\/?$/, "/")}`) : new URL("./data/", import.meta.url);
const PORT = Number(process.env.FORGE_PORT ?? 8787);

/** Every fighter.json under the data folder. */
function allFighters() {
  const out = [];
  for (const id of fs.readdirSync(DATA)) {
    try {
      out.push(JSON.parse(fs.readFileSync(new URL(`${id}/fighter.json`, DATA), "utf8")));
    } catch {}
  }
  return out;
}

const all = allFighters();
const username = target.trim().toLowerCase();
const found = all.filter((f) => f.id === target || (f.username && f.username === username));
if (found.length === 0) {
  console.error(`no fighter with id or username "${target}" in ${DATA.pathname}`);
  process.exit(1);
}
found.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
for (const f of found) {
  const files = fs.readdirSync(new URL(`${f.id}/`, DATA));
  const when = f.createdAt ? new Date(f.createdAt).toISOString().slice(0, 16).replace("T", " ") : "?";
  console.log(`${f.id}  ${JSON.stringify(f.name)}  user ${f.username ?? "-"}  ${f.status}${f.hidden ? " (hidden)" : ""}  ${when}  ${files.length} files`);
}
if (!yes) {
  console.log(`\n${found.length} fighter${found.length === 1 ? "" : "s"} would be deleted. Run again with --yes to delete for good.`);
  process.exit(0);
}

/** Asks the running server (POST /admin/delete). Null if no server is listening; throws on a refusal. */
async function viaServer(id) {
  let key;
  try {
    key = fs.readFileSync(new URL(".admin-key", DATA), "utf8").trim();
  } catch {
    return null; // a server that never ran on this data folder
  }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/admin/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": key },
      body: JSON.stringify({ id }),
    });
  } catch {
    return null;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`server refused (${res.status}): ${body.error ?? res.statusText}`);
  return body;
}

let failed = 0;
let state = null;
for (const f of found) {
  try {
    let gone = await viaServer(f.id);
    if (gone) console.log(`deleted ${f.id} through the running server: ${gone.files} files, ${gone.highlights} highlights${gone.record ? ", record" : ""}`);
    else {
      state ??= readState(DATA);
      gone = purgeFighter(DATA, f.id, state);
      console.log(`deleted ${f.id} on disk (no server running): ${gone.files} files, ${gone.highlights} highlights${gone.record ? ", record" : ""}`);
    }
  } catch (err) {
    failed++;
    console.error(`${f.id}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
