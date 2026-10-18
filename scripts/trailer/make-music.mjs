// Original trailer music with the ElevenLabs Music API (POST /v1/music), sections laid out on the trailer's cut at
// 120 bpm (a bar is 2 s, so cuts land on whole seconds). Needs ELEVENLABS_API_KEY in the repo root .env (never printed).
//   node scripts/trailer/make-music.mjs <outDir> [takes=2]
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
if (!KEY) {
  console.error("ELEVENLABS_API_KEY missing from .env");
  process.exit(1);
}
const out = path.resolve(process.argv[2] ?? "trailer-music");
const takes = Number(process.argv[3] ?? 2);
fs.mkdirSync(out, { recursive: true });

const plan = {
  positive_global_styles: [
    "fighting game reveal trailer music", "aggressive hybrid trap and rock", "120 bpm", "hard hitting drums",
    "distorted 808 bass", "brass stabs", "arcade synth leads", "huge impacts", "instrumental",
  ],
  negative_global_styles: ["vocals", "singing", "rap", "lo-fi", "soft", "slow fade in", "acoustic"],
  sections: [
    { section_name: "Cold open", positive_local_styles: ["dark tension", "low drone", "heartbeat sub kicks", "metallic riser", "ends on one massive impact hit"], negative_local_styles: ["melody", "full drums"], duration_ms: 6000, lines: [] },
    { section_name: "Title slam", positive_local_styles: ["huge orchestral and synth hit on the downbeat", "sub drop", "ringing tail", "brief silence"], negative_local_styles: ["groove"], duration_ms: 4000, lines: [] },
    { section_name: "Scan", positive_local_styles: ["driving pulse", "ticking hi-hats", "pulsing synth bass", "anticipation"], negative_local_styles: ["full drop"], duration_ms: 6000, lines: [] },
    { section_name: "Forge build", positive_local_styles: ["rising arpeggiated synths", "building drums", "snare roll", "riser into a drop", "intensity growing every bar"], negative_local_styles: ["calm"], duration_ms: 12000, lines: [] },
    { section_name: "Entrance", positive_local_styles: ["heavy swaggering groove drop", "slap bass", "boom bap drums", "brass stabs", "crowd energy"], negative_local_styles: ["quiet"], duration_ms: 8000, lines: [] },
    { section_name: "Fight montage", positive_local_styles: ["full energy drop", "aggressive trap drums", "distorted guitars", "punchy 808", "fast hits every beat", "arcade energy"], negative_local_styles: ["breakdown", "quiet"], duration_ms: 20000, lines: [] },
    { section_name: "Knockout", positive_local_styles: ["sudden stop", "slow motion breakdown", "deep boom", "reverse swell", "epic pad"], negative_local_styles: ["drums"], duration_ms: 7000, lines: [] },
    { section_name: "Stats", positive_local_styles: ["staccato stomp hits on every bar", "tight drums return", "rising energy"], negative_local_styles: ["melody"], duration_ms: 8000, lines: [] },
    { section_name: "Finale", positive_local_styles: ["final massive hit", "big cymbal", "ringing tail", "ends cleanly"], negative_local_styles: ["new groove", "long fade"], duration_ms: 7000, lines: [] },
  ],
};

async function compose(body, file) {
  const res = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192", {
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

// Two at a time (the API's concurrency limit).
for (let i = 1; i <= takes; i += 2) {
  await Promise.all(
    [i, i + 1].filter((n) => n <= takes).map((n) => compose({ composition_plan: plan, model_id: "music_v1" }, path.join(out, `trailer-${n}.mp3`))),
  );
}
