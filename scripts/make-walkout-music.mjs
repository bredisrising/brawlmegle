// Generates takes of the walkout music with the ElevenLabs Music API (POST /v1/music). Original music in the style
// of a fighting-game walkout, never Capcom's tracks. Needs ELEVENLABS_API_KEY in the repo root .env (never printed).
//   node scripts/make-walkout-music.mjs <outDir> [takes=3]
// Writes <outDir>/take-<n>-<plan>.mp3. Listen-check, trim the pick (ffmpeg) and ship it as public/walkout/walkout.mp3.
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

const STYLE = [
  "hype fighting game walkout theme",
  "aggressive hip-hop funk rock fusion",
  "slap bass, distorted power chords, brass stabs, record scratches",
  "hard boom bap drums, 140 bpm, arena energy",
  "instrumental",
];
const AVOID = ["vocals", "singing", "rap verse", "ambient", "slow", "lo-fi", "orchestral only", "fade in"];

/** The plans: a 3 s build (riser, snare roll) into a big drop, then the riff that rides it, then a hard stop stinger. */
const PLANS = {
  plan: {
    positive_global_styles: STYLE,
    negative_global_styles: AVOID,
    sections: [
      { section_name: "Build", positive_local_styles: ["tension riser", "snare roll accelerating", "reverse cymbal", "bass drone", "crowd noise"], negative_local_styles: ["full drums"], duration_ms: 3000, lines: [] },
      { section_name: "Drop", positive_local_styles: ["huge drop on the downbeat", "full band hits", "slap bass riff", "brass stabs on every bar", "heavy kick and snare"], negative_local_styles: ["quiet", "build up"], duration_ms: 4000, lines: [] },
      { section_name: "Stinger", positive_local_styles: ["band hits a final stab", "big cymbal crash", "hard stop then silence"], negative_local_styles: ["new melody", "fade out"], duration_ms: 3000, lines: [] },
    ],
  },
};
const PROMPT =
  "An original, hard-hitting fighting-game player walkout jingle, 10 seconds. Hip-hop / funk / rock fusion: slap bass, " +
  "distorted guitar power chords, brass stabs, record scratches, punchy boom-bap drums, 140 bpm. It opens on a short " +
  "tense riser and snare roll, then a HUGE drop with the whole band hitting at about 2 seconds, a swaggering riff with " +
  "stabs on every bar, and ends on one big final stab and cymbal crash. Instrumental, no vocals, arena energy.";

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
    fs.existsSync(prompt) ? null : compose({ prompt: PROMPT, music_length_ms: 10000, force_instrumental: true, model_id: "music_v1" }, prompt),
  ]);
}
