// Auto-labels recorded fighting with a vision model, so real matches become training/eval data with no manual
// labeling. For each moment (a strike the reader produced, or a quiet stretch to catch misses), it takes ~1 s of the
// camera video as one strip of frames and asks what the person actually did.
//
//   node scripts/auto-label.mjs --video round.webm --match round.jsonl [--offset ms] [--quiet 3000] > labels.jsonl
//   node scripts/auto-label.mjs --video 40256.mp4 --labels test/intent/labels/40256.json   (check it against hand labels)
//
// --match: a recorded match (MatchRecorder JSONL: frames with t, and {intent} lines). Video time 0 = the first frame's t
// (+ --offset ms if the video started later or earlier). Needs OPENAI_API_KEY (repo .env) and ffmpeg.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
for (const line of fs.existsSync(path.join(root, ".env")) ? fs.readFileSync(path.join(root, ".env"), "utf8").split("\n") : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
// gpt-5.4 beat gpt-5.4-mini clearly on the hand-labeled stock clips (40256: style 9/14 vs 6/14; 36564: style 8/8).
const MODEL = process.env.LABEL_MODEL ?? "gpt-5.4";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "label-"));

const PROMPT = `These are consecutive frames (left to right, about half a second) from a camera watching a person
fight. Say what the person does. Strikes: a straight punch (fist driven straight forward),
a hook (fist swung round from the side, elbow bent), an uppercut (fist driven upward from low), a knee, a kick.
Other: block (both fists up in front of the face, held), duck (head and shoulders drop), dodge left/right (head moves
sideways), no_punch (anything else: idle, guard, fixing hair, waving, reaching, adjusting). If two strikes happen,
report the one at the middle frames. For the striking arm or leg, say which side OF THE IMAGE it is on (image-left or
image-right), not the person's left or right. Reply JSON only:
{"action":"straight|hook|uppercut|knee|kick|block|duck|dodge|no_punch|unclear","side":"image-left|image-right|both|none","confidence":0.0-1.0}`;

/** One strip of frames from [t0, t0 + span] ms of the video. */
function strip(video, t0, span = Number(args.span ?? 600), n = Number(args.frames ?? 8)) {
  const out = path.join(tmp, `s${Math.round(t0)}.jpg`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, t0) / 1000), "-t", String(span / 1000), "-i", video,
    "-vf", `fps=${(n * 1000) / span},scale=256:-2,tile=${n}x1`, "-frames:v", "1", "-q:v", "4", out]);
  return fs.readFileSync(out).toString("base64");
}

async function ask(image) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }] }],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${body.error?.message ?? ""}`);
  return JSON.parse(body.choices[0].message.content);
}

/** The moments to label: [{t (ms in video time), claim}] */
function moments() {
  if (args.labels) {
    const l = JSON.parse(fs.readFileSync(args.labels, "utf8"));
    return l.labels.map((x) => ({ t: (x.start + x.end) / 2, truth: x }));
  }
  const lines = fs.readFileSync(args.match, "utf8").trim().split("\n").map((s) => JSON.parse(s));
  const frames = lines.filter((x) => x.image);
  const t0 = frames[0].t - Number(args.offset ?? 0);
  const end = frames[frames.length - 1].t - t0;
  const claims = lines.filter((x) => x.intent && !["anticipate", "cancel"].includes(x.intent.kind)).map((x) => ({ t: x.intent.t - t0, claim: x.intent }));
  // Quiet stretches (nothing read): did the reader miss something?
  const quiet = [];
  const gap = Number(args.quiet ?? 3000);
  for (let t = 1000; t < end - 500; t += gap) if (!claims.some((c) => Math.abs(c.t - t) < 1200)) quiet.push({ t, claim: null });
  return [...claims, ...quiet].sort((a, b) => a.t - b.t);
}

const list = moments();
for (const m of list) {
  try {
    const span = Number(args.span ?? 600);
    const label = await ask(strip(args.video, m.t - span / 2));
    // An unmirrored camera: the person's right side is on the image's left (`--mirrored` if the video is mirrored).
    const flip = args.mirrored === undefined;
    label.hand = label.side === "both" || label.side === "none" ? label.side : (label.side === "image-left") === flip ? "right" : "left";
    console.log(JSON.stringify({ t: Math.round(m.t), ...(m.truth ? { truth: m.truth } : { claim: m.claim }), label }));
  } catch (err) {
    console.log(JSON.stringify({ t: Math.round(m.t), error: String(err.message ?? err) }));
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
