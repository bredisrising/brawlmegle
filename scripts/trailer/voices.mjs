// Search ElevenLabs voices (the account's and the shared library) for a narrator/announcer, and voice lines.
//   node voices.mjs search <terms>              list matching shared-library voices
//   node voices.mjs say <voiceId> <out.mp3> <text> [model=eleven_v3] [stability] [style]
// Needs ELEVENLABS_API_KEY in the repo root .env (never printed).
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
for (const file of [path.join(root, ".env"), path.resolve(root, "..", "..", "..", ".env")]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("ELEVENLABS_API_KEY missing from .env");
const [cmd, ...rest] = process.argv.slice(2);
const api = (p, init = {}) => fetch(`https://api.elevenlabs.io${p}`, { ...init, headers: { "xi-api-key": KEY, "Content-Type": "application/json", ...(init.headers ?? {}) } });

if (cmd === "search") {
  const q = encodeURIComponent(rest.join(" "));
  const res = await api(`/v1/shared-voices?page_size=30&search=${q}&sort=usage_character_count_1y`);
  const body = await res.json();
  for (const v of body.voices ?? []) {
    console.log(`${v.voice_id}  ${v.name}  | ${v.gender} ${v.age} ${v.accent} | ${v.use_case} | ${(v.description ?? "").slice(0, 110)} | uses ${v.usage_character_count_1y ?? "?"} | owner ${v.public_owner_id}`);
  }
} else if (cmd === "mine") {
  const res = await api(`/v1/voices`);
  for (const v of (await res.json()).voices ?? []) console.log(`${v.voice_id}  ${v.name}  ${v.category}  ${JSON.stringify(v.labels)}`);
} else if (cmd === "add") {
  // Add a shared-library voice to the account so it can be used: add <publicOwnerId> <voiceId> <name>
  const [owner, id, name] = rest;
  const res = await api(`/v1/voices/add/${owner}/${id}`, { method: "POST", body: JSON.stringify({ new_name: name }) });
  console.log(res.status, await res.text());
} else if (cmd === "say") {
  const [voice, out, text, model = "eleven_v3", stability = "0.5", style = "0"] = rest;
  const body = { text, model_id: model, voice_settings: { stability: Number(stability), similarity_boost: 0.8, style: Number(style), use_speaker_boost: true } };
  const res = await api(`/v1/text-to-speech/${voice}?output_format=mp3_44100_192`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log("wrote", out);
}
