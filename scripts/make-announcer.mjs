// Generates the announcer's barks and the crowd with ElevenLabs, into public/announcer/ (+ manifest.json).
// Needs ELEVENLABS_API_KEY in the repo root .env (never printed). Run: node scripts/make-announcer.mjs [--voice <id>]
// Without --voice it searches the shared voice library for an arena/fight announcer and uses the top match.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
for (const line of fs.existsSync(path.join(root, ".env")) ? fs.readFileSync(path.join(root, ".env"), "utf8").split("\n") : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error("ELEVENLABS_API_KEY missing from .env");
  process.exit(1);
}
const API = "https://api.elevenlabs.io";
const out = path.join(root, "public", "announcer");
fs.mkdirSync(out, { recursive: true });

/** The barks: short, shouted, Street Fighter style. eleven_v3 reads the [tags] as delivery directions. */
const BARKS = {
  fight: "[shouting] FIGHT!",
  ko: "[shouting, drawn out] K... O!",
  perfect: "[shouting] PERFECT!",
  counter: "[excited, shouting] COUNTER!",
  combo: "[excited] COMBO!",
  great: "[excited] GREAT!",
  incredible: "[shouting] INCREDIBLE!",
  fireball: "[shouting] FIREBALL!",
  first: "[excited] FIRST ATTACK!",
  time: "[shouting] TIME!",
  draw: "[announcer voice] DRAW GAME!",
  ready: "[announcer voice, building] ARE YOU READY?",
  round: "[announcer voice] ROUND ONE!",
  win: "[shouting] YOU WIN!",
  danger: "[urgent] DANGER!",
};

/** Crowd layers, made with the sound-effects model. */
const CROWD = {
  cheer: { text: "huge arena crowd erupting into loud cheers and applause", seconds: 3.5 },
  ooh: { text: "big arena crowd reacting with a loud surprised 'ooooh' to a hard hit", seconds: 1.8 },
  roar: { text: "stadium crowd going wild, roaring and stomping after a knockout", seconds: 5 },
  murmur: { text: "excited arena crowd murmur before a fight, low and buzzing", seconds: 6 },
};

async function api(p, init) {
  const res = await fetch(API + p, { ...init, headers: { "xi-api-key": KEY, ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${p} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function pickVoice() {
  const flag = process.argv.indexOf("--voice");
  if (flag > 0) return process.argv[flag + 1];
  for (const q of ["fight announcer", "arena announcer", "boxing announcer", "trailer announcer", "hype announcer"]) {
    const body = await (await api(`/v1/shared-voices?page_size=5&search=${encodeURIComponent(q)}`)).json();
    const v = body.voices?.[0];
    if (v) {
      console.log(`voice: ${v.name} (${v.voice_id}) from search "${q}"`);
      // A library voice has to be added to the account before the API will speak with it.
      const added = await (await api(`/v1/voices/add/${v.public_owner_id}/${v.voice_id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ new_name: `brawlmegle ${v.name}`.slice(0, 40) }),
      })).json();
      return added.voice_id ?? v.voice_id;
    }
  }
  throw new Error("no announcer voice found; pass --voice <id>");
}

const voice = await pickVoice();
const manifest = { voice, clips: {} };
for (const [name, text] of Object.entries(BARKS)) {
  const res = await api(`/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_v3", voice_settings: { stability: 0.3, similarity_boost: 0.8, style: 0.8 } }),
  });
  fs.writeFileSync(path.join(out, `${name}.mp3`), Buffer.from(await res.arrayBuffer()));
  manifest.clips[name] = `${name}.mp3`;
  console.log("bark", name);
}
for (const [name, { text, seconds }] of Object.entries(CROWD)) {
  const res = await api("/v1/sound-generation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, duration_seconds: seconds, prompt_influence: 0.6 }),
  });
  fs.writeFileSync(path.join(out, `crowd-${name}.mp3`), Buffer.from(await res.arrayBuffer()));
  manifest.clips[`crowd-${name}`] = `crowd-${name}.mp3`;
  console.log("crowd", name);
}
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`done: ${Object.keys(manifest.clips).length} clips in public/announcer/`);
