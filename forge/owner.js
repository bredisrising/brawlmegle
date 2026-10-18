/**
 * "Delete my fighter" without logins. Every forge gets two secrets, handed out once in the create response and kept
 * only as SHA-256 hashes in its fighter.json:
 *   - an owner key (32 random bytes, base64url): the browser that scanned keeps it and can delete the fighter;
 *   - a delete code (16 Crockford base32 characters, 80 random bits, shown as XXXX-XXXX-XXXX-XXXX): for a screenshot,
 *     so the fighter can still be deleted from another laptop or after the browser's data is cleared.
 * purgeFighter() is the deletion itself, shared by the server (POST /api/fighters/<id>/delete) and the admin script
 * (delete-fighter.mjs). These are photos of real people: it removes the files, not just the listing.
 */
import crypto from "node:crypto";
import fs from "node:fs";

/** Crockford base32: no I, L, O or U, so a code read off a screenshot can't be mistyped into another one. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 16;

export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** A fresh owner key and delete code, and their hashes (the only part that's stored). */
export function newOwner() {
  const key = crypto.randomBytes(32).toString("base64url");
  // 10 bytes = 80 bits = exactly 16 base32 characters.
  let bits = 0n;
  for (const b of crypto.randomBytes(10)) bits = (bits << 8n) | BigInt(b);
  let code = "";
  for (let i = CODE_CHARS - 1; i >= 0; i--) code += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return { key, code: code.match(/.{4}/g).join("-"), ownerKeyHash: sha256(key), deleteCodeHash: sha256(code) };
}

/** A typed or pasted delete code in its canonical form (no dashes or spaces, upper case, I/L read as 1, O as 0), or null. */
export function normalizeCode(raw) {
  if (typeof raw !== "string") return null;
  const code = raw.toUpperCase().replace(/[\s-]+/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return code.length === CODE_CHARS && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

/** Whether `secret` hashes to `hash`, compared in constant time. False for anything malformed. */
export function matchesHash(secret, hash) {
  if (typeof secret !== "string" || !secret || secret.length > 256 || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(secret), "hex"), Buffer.from(hash, "hex"));
}

/** fighter.json minus the owner hashes: what may leave the server. */
export function publicFighter(fighter) {
  const { ownerKeyHash, deleteCodeHash, ...rest } = fighter;
  return rest;
}

const SAFE_ID = /^[\w-]{1,64}$/;

/**
 * Deletes fighter `id` for good, under the forge's data folder `data` (a file: URL ending in /):
 *   - its whole folder: scan photos, design sheet, card, every GLB and preview, *.pre-rescue / *.pre-face backups;
 *   - its record in records.json;
 *   - every K.O. highlight that shows it (index entry and clip).
 * `state` is { records, highlights } as the caller holds them (the server's live copies, or ones read from disk):
 * both are changed in place and written back. Returns what went, for logs.
 */
export function purgeFighter(data, id, state) {
  if (!SAFE_ID.test(id)) throw new Error(`not a fighter id: ${id}`);
  const dir = new URL(`${id}/`, data);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  fs.rmSync(dir, { recursive: true, force: true });

  const hadRecord = Object.hasOwn(state.records, id);
  if (hadRecord) {
    delete state.records[id];
    fs.writeFileSync(new URL("records.json", data), JSON.stringify(state.records));
  }

  const highlightsDir = new URL("highlights/", data);
  const shows = (h) => h?.p1?.id === id || h?.p2?.id === id;
  const gone = state.highlights.filter(shows);
  if (gone.length) {
    for (let i = state.highlights.length - 1; i >= 0; i--) if (shows(state.highlights[i])) state.highlights.splice(i, 1);
    fs.mkdirSync(highlightsDir, { recursive: true });
    fs.writeFileSync(new URL("index.json", highlightsDir), JSON.stringify(state.highlights));
    for (const h of gone) if (typeof h.file === "string" && /^[\w.-]+$/.test(h.file)) fs.rmSync(new URL(h.file, highlightsDir), { force: true });
  }
  return { id, files, record: hadRecord, highlights: gone.length };
}

/** records.json and the highlights index as they are on disk (for the admin script when the server isn't running). */
export function readState(data) {
  const read = (url, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(url, "utf8"));
    } catch {
      return fallback;
    }
  };
  return { records: read(new URL("records.json", data), {}), highlights: read(new URL("highlights/index.json", data), []) };
}

/**
 * The secret the admin script uses to ask the running server to delete a fighter (POST /admin/delete, which nginx
 * doesn't forward: localhost only). Kept in the data folder, so only whoever can already delete fighters' files can
 * read it. Made on first use.
 */
export function adminKey(data) {
  const file = new URL(".admin-key", data);
  try {
    const key = fs.readFileSync(file, "utf8").trim();
    if (key) return key;
  } catch {}
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}
