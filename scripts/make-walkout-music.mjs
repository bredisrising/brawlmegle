// Generates takes of the walkout music with the ElevenLabs Music API (POST /v1/music). Original music in the style
// of a fighting-game walkout, never Capcom's tracks. Needs ELEVENLABS_API_KEY in the repo root .env (never printed).
//   node scripts/make-walkout-music.mjs <outDir> [takes=3]
// Writes <outDir>/take-<n>-<plan>.mp3. Listen-check, trim the pick (ffmpeg) and ship it as public/walkout/walkout.mp3.
// The shipped track is a take-1-plan: its groove lands 2.60 s in at 92 bpm (bars of 2.61 s) and it stops dead on a
// bar line at 13.04 s. Started 0.9 s in, with one bar (7.82-10.43 s) cut out on the downbeats, its hits fall on the
// default beats in director/walkoutTiming.ts (groove at 1.71, bars at 4.32 and 6.93, snare roll 8.25, stop 9.55):
//   ffmpeg -i take.mp3 -filter_complex "[0]atrim=0.9:7.84,asetpts=PTS-STARTPTS[a];[0]atrim=10.41:13.9,
//     asetpts=PTS-STARTPTS[b];[a][b]acrossfade=d=0.02,afade=t=in:d=0.3,afade=t=out:st=9.75:d=0.2" -b:a 128k walkout.mp3
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const envFile = path.resolve(root, "..", "..", "..", ".env"); // a worktree under .claude/worktrees/ reads the main checkout's
for (const file of [path.join(root, ".env"), envFile]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error("ELEVENLABS_API_KEY missing from .env");
  process.exit(1);
}
const out = path.resolve(process.argv[2] ?? "walkout-takes");
const takes = Number(process.argv[3] ?? 3);
fs.mkdirSync(out, { recursive: true });

// The entrance scene (~10 s, see director/walkoutTiming.ts): a dark intro while the stage is shown, a heavy groove that
// lands as fighter 1's shot starts (one bar each fighter at ~92 bpm), a snare build for the face-off, one big hit for
// the fire VS and a hard stop for ROUND 1.
const STYLE = [
  "fighting game character entrance theme",
  "heavy hip-hop funk rock fusion, swaggering",
  "slap bass, distorted guitar, brass stabs, record scratches",
  "hard boom bap drums, 92 bpm, arena energy",
  "instrumental",
];
const AVOID = ["vocals", "singing", "rap verse", "lo-fi", "orchestral only", "fade in", "fast tempo"];

const PLANS = {
  plan: {
    positive_global_styles: STYLE,
    negative_global_styles: AVOID,
    sections: [
      { section_name: "Stage", positive_local_styles: ["dark tense intro", "low synth drone", "distant arena crowd", "single heartbeat kick", "reverse cymbal swell into the downbeat"], negative_local_styles: ["full drums", "melody"], duration_ms: 3000, lines: [] },
      { section_name: "Groove", positive_local_styles: ["heavy groove hits hard on the downbeat", "slap bass riff", "boom bap drums", "brass stab on the first beat of every bar", "swagger"], negative_local_styles: ["quiet", "build up"], duration_ms: 5200, lines: [] },
      { section_name: "Build", positive_local_styles: ["snare roll building", "rising guitar", "tension", "crowd rising"], negative_local_styles: ["drop"], duration_ms: 3000, lines: [] },
      { section_name: "Hit", positive_local_styles: ["one huge band hit with explosion", "big cymbal crash", "hard stop then silence"], negative_local_styles: ["new melody", "fade out", "groove"], duration_ms: 3000, lines: [] },
    ],
  },
};
const PROMPT =
  "An original fighting-game character entrance theme, 14 seconds. Starts dark: a low drone, distant crowd and a lone " +
  "kick for 3 seconds, then a heavy 92 bpm hip-hop / funk / rock groove hits on the downbeat (slap bass, boom-bap drums, " +
  "brass stabs, distorted guitar) for two bars, then a snare roll builds for a bar, then one huge band hit and cymbal " +
  "crash and a hard stop. Instrumental, no vocals, arena energy.";

async function compose(body, file) {
  const res = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`${path.basename(file)}: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
    return;
  }
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`wrote ${file}`);
}

// Two at a time (the API's concurrency limit); existing takes are kept.
const start = Number(process.argv[4] ?? 1);
for (let i = start; i < start + takes; i++) {
  const plan = path.join(out, `take-${i}-plan.mp3`);
  const prompt = path.join(out, `take-${i}-prompt.mp3`);
  await Promise.all([
    fs.existsSync(plan) ? null : compose({ composition_plan: PLANS.plan, model_id: "music_v1" }, plan),
    fs.existsSync(prompt) ? null : compose({ prompt: PROMPT, music_length_ms: 14000, force_instrumental: true, model_id: "music_v1" }, prompt),
  ]);
}
