// Generates takes of the walkout music with the ElevenLabs Music API (POST /v1/music). Original music in the style
// of a fighting-game walkout, never Capcom's tracks. Needs ELEVENLABS_API_KEY in the repo root .env (never printed).
//   node scripts/make-walkout-music.mjs <outDir> [takes=4] [start=1] [variants=groove]
// Writes <outDir>/take-<n>-<variant>.mp3. Variants: groove (the full beat), plan, and three drum-free midrange layers:
// plucks, toms, tones. Beat-track the takes (want 92.0 bpm and a G sub; the groove prompt landed 4 of 4 on G), cut the
// pick onto the timeline below and ship it as public/walkout/walkout.mp3.
// The timeline (director/walkoutTiming.ts): beat k at 1.10 + k*0.65214 s (92.0 bpm), so the cuts on beat 3 of each bar
// land at 2.40, 5.01, 7.62 and the VS at 10.23: a low G swell, the drop at 1.10, DJ stops (low end out) before 2.40 and
// 5.01, a fill into 7.62, a clap build into one big hit at 10.23 and a dead stop at 11.10.
// The shipped track (v2) is a groove take with three layer takes on top. The groove take's drop lands 2.635 s in (fitted
// beat 0.65228 s, so no stretch), with a riser before it, a last hit on beat 16 (13.07 s) and a bare 808 tail after it
// (13.25-14.30 s). Cut with numpy/scipy:
//   groove   take 2.635 s on -> 1.10, copied 1:1; out beat 9 (6.97-7.62) swapped for take beat 15 (its kick roll).
//            Splices sit 20 ms before the beat with 24 ms crossfades, so the new beat's attack is untouched.
//   layers   1.10-10.21, each take's beat 0 on the drop: a toms take (beat 0 at 0.030 s) band-passed 90-1200 Hz x0.4,
//            a plucks take (0.033 s) band-passed 250-2500 Hz x0.2. They fill the original's busy midrange.
//   arcs     one tom hit from the toms take (0.03-0.33 s) replayed at a falling speed (x3.4 -> x0.87, 60 ms time
//            constant), so it sweeps ~500 Hz -> ~130 Hz like the original's booming kicks; on beats 1, 1&, 3, 3& and 4a
//            of every bar, x0.4.
//   arches   one held G3 note from a tones take (0.037-0.6 s) sped up to D4/E4/C#4/Eb4 with a pitch arch (up 1.5-2
//            semitones, then down past the start), 0.28-0.34 s long, at 3.55, 4.04, 5.01, 6.15, 8.76, 9.25 (x0.6): where
//            the original has its arching, voice-range synth lines.
//   drop     the take's first 16th (2.635 s + 0.17 s) also at 0.94: the double hit.
//   swell    0-0.94: the 808 tail reversed, low-passed at 220 Hz, rising from 25%; the riser (1.55-2.62 s) ends at 0.94.
//   stops    2.30-2.40 (short, like the original) and 4.69-5.01: below 160 Hz muted, the rest ducked to 30% / 15%, back
//            in hard on the cut, with the drop's first 0.35 s layered on 2.40, 5.01 and 7.62 (x0.55, 0.65, 0.5).
//   fill     the beat-2 clap (take 3.29 s, high-passed 400 Hz) as 16ths at 7.13, 7.30, 7.46, getting louder.
//   build    the clap at 8.93, 9.25, 9.58, 9.74, 9.90, 9.99, 10.07, 10.15 (8ths, 16ths, 32nds, crescendo), the riser
//            again into 10.23, and the low end cut for the last 16th.
//   VS       at 10.23: the drop's first 0.55 s (x1.3) + the take's last hit with its 808 ring + the riser reversed and
//            high-passed at 2 kHz (the crash). 60 ms fade to silence at 11.04-11.10, silence to 11.30.
//   master   +4.1 dB from 200 Hz to 5 kHz (zero-phase band-pass mixed in at 0.6), -0.5 dB below 70 Hz and above 5 kHz,
//            a lookahead true-peak limiter at -1.8 dBFS (up to 5 dB, on the VS hit and the build claps), gain to
//            -14 LUFS, mp3 44.1 kHz 160 kbps: -14.1 LUFS, -1.4 dBTP. Hits measured at 1.101 / 2.406 / 5.014 / 7.625 /
//            10.233. (v1 was the same cut without layers, arcs and arches, a half-beat first stop and a flat +3.5 dB mid.)
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
const takes = Number(process.argv[3] ?? 4);
const start = Number(process.argv[4] ?? 1);
const variants = (process.argv[5] ?? "groove").split(",");
fs.mkdirSync(out, { recursive: true });

// What the original's bed is: ~92 bpm, everything on G with a sustained G1 sub (49 Hz) under it, kick on 1 and 3 plus
// a pickup at the end of the bar, a big clap on 2 and 4, busy hats, almost no melody. "Tuned to G" and "G1" matter: with
// only "G minor" most takes put the 808 on C# or D#. Section lengths in a plan are ignored (intros come out 5-9 s), so
// the groove prompt (a short riser, then straight in) cuts best; plan takes give longer intros to borrow from.
const GROOVE =
  "Original dark hard-hitting hip-hop trap instrumental, exactly 92 BPM, in G minor with everything tuned to G. Half a " +
  "second of rising reverse cymbal, then a massive downbeat hit. One continuous sustained 808 sub bass note on G1 drones " +
  "under the whole beat, sliding down and back up at the end of every other bar. Booming kick on beats 1 and 3 with a " +
  "pickup kick at the end of the bar, huge snappy clap on beats 2 and 4, busy crisp sixteenth-note hi-hats and shakers " +
  "with quick rolls, dark gritty low synth hits on G. Menacing, heavy, almost no melody. Instrumental, no vocals.";
const STYLE = [
  "dark hard-hitting hip-hop trap instrumental, 92 BPM, key of G minor",
  "one continuous sustained 808 sub bass note on low G droning under the whole beat",
  "booming kick on beats 1 and 3 with a pickup kick at the end of the bar, huge clap on beats 2 and 4",
  "sparse crisp hi-hats with short rolls, deep pitch-dropping 808 booms",
  "menacing, heavy, gritty, minimal melody, fighting game boss entrance",
];
const AVOID = ["vocals", "rap", "singing", "piano", "guitar", "brass", "orchestral", "lo-fi", "happy", "major key", "supersaw", "dubstep wobble", "fast tempo"];
const PLAN = {
  positive_global_styles: STYLE,
  negative_global_styles: AVOID,
  sections: [
    { section_name: "Intro", positive_local_styles: ["low G sub drone swelling up", "dark ominous rumble", "reverse cymbal riser sucking into the drop", "no drums"], negative_local_styles: ["drums", "melody", "hi-hats", "silence"], duration_ms: 3000, lines: [] },
    { section_name: "Drop", positive_local_styles: ["massive double-hit drop, two booming hits a sixteenth apart on the downbeat", "kick on 1 and 3, huge clap on 2 and 4", "808 sub sustaining low G", "808 and kick drop out for half a beat then slam back in, DJ stop"], negative_local_styles: ["quiet", "build up", "melody"], duration_ms: 5200, lines: [] },
    { section_name: "Groove", positive_local_styles: ["same heavy beat continues", "808 slides down and back up to G", "descending pitch-drop 808 booms", "short tom and snare fill"], negative_local_styles: ["quiet", "breakdown", "melody"], duration_ms: 5200, lines: [] },
    { section_name: "Build", positive_local_styles: ["snare roll building faster", "rising riser and noise sweep", "808 holding G"], negative_local_styles: ["drop", "silence"], duration_ms: 3000, lines: [] },
    { section_name: "Hit", positive_local_styles: ["one massive impact hit with crash cymbal and 808 boom", "then hard stop", "silence with short reverb tail"], negative_local_styles: ["groove", "new melody", "fade out", "drums continuing"], duration_ms: 3000, lines: [] },
  ],
};
// Drum-free layers for the midrange, lined up on the drop like the groove (they all start on a beat at ~0.03 s).
// The model won't do real pitch swoops: "zaps" and "pitch-bent stabs" come out as steady notes on G, so the arcs and
// arches are made in the cut by replaying a note at a changing speed (see above).
const LAYERS = {
  plucks:
    "Original dark trap instrumental layer, exactly 92 BPM, in G minor over a G pedal. No drums, no bass, no 808, no " +
    "percussion. Only a busy midrange: short pitch-bent detuned synth stabs around D5 and E-flat 5 that arch up a " +
    "semitone and slide back down on the off-beats, gritty plucked synth chops on sixteenth notes, an eerie wavering high " +
    "synth tone hovering around D6, low growling distorted synth swells around G3 that rise into each bar line. Menacing " +
    "minor-second tension between D and E-flat. Starts immediately as a steady loop, no intro, no ending. Instrumental, no vocals.",
  toms:
    "Original dark trap instrumental layer, exactly 92 BPM, in G minor. No kick, no clap, no hi-hats, no bass, no 808. " +
    "Only the midrange: deep pitched tom booms that fall in pitch from about B4 down to C3 on the off-beat eighth notes, " +
    "short pitch-bent detuned synth stabs that arch up a semitone and back down around D5 and E-flat 5, rim clicks and " +
    "finger snaps on sixteenths, menacing minor-second tension between D and E-flat. Starts immediately as a steady loop, " +
    "no intro, no ending. Instrumental, no vocals.",
  tones:
    "Original dark trap instrumental layer, exactly 92 BPM, in G minor. No kick, no clap, no hi-hats, no bass, no 808. " +
    "Only the midrange: short resonant synth zaps that swoop down in pitch from about C5 to C3 within a sixteenth note, " +
    "on the off-beat eighth notes; pitch-bent detuned synth stabs that rise a semitone and fall back around D5 and E-flat 5; " +
    "an eerie wavering synth tone around D6. Menacing minor-second tension between D and E-flat over G. Starts " +
    "immediately as a steady loop, no intro, no ending. Instrumental, no vocals.",
};
const BODY = {
  groove: { prompt: GROOVE, music_length_ms: 15000, force_instrumental: true, model_id: "music_v1" },
  plan: { composition_plan: PLAN, model_id: "music_v1" },
  ...Object.fromEntries(
    Object.entries(LAYERS).map(([k, prompt]) => [k, { prompt, music_length_ms: 15000, force_instrumental: true, model_id: "music_v1" }]),
  ),
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

// Two at a time (the API's concurrency limit); existing takes are kept.
const jobs = [];
for (let i = start; i < start + takes; i++) for (const v of variants) jobs.push([BODY[v], path.join(out, `take-${i}-${v}.mp3`)]);
const todo = jobs.filter(([body, file]) => body && !fs.existsSync(file));
while (todo.length) await Promise.all(todo.splice(0, 2).map(([body, file]) => compose(body, file)));
