// The forge pipeline: scan frames -> brief -> model sheet -> card art, next to the 3D model and its rig (our GPU box).
// Settings below were picked in research/forge-quality.md (2026-10-17); every one can be overridden from the env.
import { BRIEF_PROMPT, STYLE, sheetPrompt, cardPrompt } from "./prompts.js";
import { optimizeFighter, optimizeImage } from "./optimize.js";
import { checkRig, available as rigCheckAvailable } from "./rigcheck.js";

const API = "https://api.openai.com/v1";
const BRIEF_MODEL = process.env.FORGE_BRIEF_MODEL ?? "gpt-5.4-mini";
/**
 * Our GPU box builds the model (FORGE_3D=local or gradio). Flare at 1024x1536 draws a sheet TRELLIS turns into as
 * good a fighter as sunburst's 1536x2304 in 12-13 s less (research/forge-gpu.md); FORGE_GPU_SHEET=0 keeps sunburst.
 */
const FAST_SHEET = Boolean(process.env.FORGE_3D_URL) && ["local", "gradio"].includes(process.env.FORGE_3D) && (process.env.FORGE_GPU_SHEET ?? "1") !== "0";
const IMAGE_MODEL = process.env.FORGE_IMAGE_MODEL ?? (FAST_SHEET ? "gpt-image-2.5-flare" : "gpt-image-2.5-sunburst");
const CARD_MODEL = process.env.FORGE_CARD_MODEL ?? "gpt-image-2.5-flare";
const IMAGE_QUALITY = process.env.FORGE_IMAGE_QUALITY ?? "medium";
/** "high" keeps faces closer to the photos. Only gpt-image-1 models accept it; gpt-image-2 rejects it. */
const INPUT_FIDELITY = process.env.FORGE_INPUT_FIDELITY ?? "high";
// FORGE_STYLE=goldsrc brings back the old low-poly Half-Life 1 look of the sheet.
const GOLDSRC = STYLE === "goldsrc";
/** TRELLIS reads the sheet at 1024 px tall; sunburst draws it at the biggest 2:3 size (FORGE_GPU_SHEET=0). */
const SHEET_SIZE = process.env.FORGE_SHEET_SIZE ?? (GOLDSRC || FAST_SHEET ? "1024x1536" : "1536x2304");
/**
 * A showcase forge (`quality: "hq"`, the game's `?forge=hq`): the big sunburst sheet and the GPU box's slower settings
 * (12 steps, 60k faces, 2048 texture). About 60 s instead of 35, for fighters people will look at up close.
 */
const HQ = { imageModel: "gpt-image-2.5-sunburst", sheetSize: "1536x2304", gpu: { steps: 12, faces: 60000, texture: 2048 } };
const CARD_SIZE = "1024x1536";
/** Partial sheet images streamed for the forging screen's preview (0 turns streaming off). */
const SHEET_PARTIALS = Number(process.env.FORGE_SHEET_PARTIALS ?? 3);

// --- Our own GPU box (forge/gpu): model sheet -> textured, Mixamo-rigged GLB with TRELLIS.2 + Blender ----------
/**
 * "local" sends the sheet to the GPU service's job API (the AWS box, or the Docker Space); "gradio" to the ZeroGPU
 * Space's /forge3d endpoint. Without either, fighters ship without a 3D model (the game gives them the default body).
 */
const ENGINE_3D = process.env.FORGE_3D_URL && ["local", "gradio"].includes(process.env.FORGE_3D) ? process.env.FORGE_3D : null;
const LOCAL_URL = (process.env.FORGE_3D_URL ?? "").replace(/\/$/, "");
const LOCAL_TIMEOUT_MS = Number(process.env.FORGE_3D_TIMEOUT ?? 90) * 1000;

export const models = {
  brief: BRIEF_MODEL,
  sheet: `${IMAGE_MODEL} ${SHEET_SIZE}, ${STYLE} style`,
  card: CARD_MODEL,
  quality: IMAGE_QUALITY,
  threeD: ENGINE_3D ? `GPU service (${ENGINE_3D}, ${LOCAL_URL})` : "off (no FORGE_3D)",
};

// A private Hugging Face Space (forge/gpu/hf_space.py) also wants an HF token on every request.
const hfAuth = () => (process.env.FORGE_3D_HF_TOKEN ? { authorization: `Bearer ${process.env.FORGE_3D_HF_TOKEN}` } : {});

async function local(path, init = {}, timeoutMs = 20_000) {
  const res = await fetch(LOCAL_URL + path, {
    ...init,
    headers: { "x-forge3d-key": process.env.FORGE_3D_KEY ?? "", ...hfAuth(), ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`GPU ${path} ${res.status}: ${body.error ?? "no details"}`);
  }
  return res;
}

/**
 * The GPU box's own account of its rig (forge/gpu/rig_blender.py): which weighting path made it ("bone-heat",
 * "bone-heat-retry" or "envelope"), whether its weight check passed, and the paths it tried. Null from an older box.
 */
export function boxRig(report) {
  if (!report?.rig) return null;
  return {
    path: report.rig,
    ok: Boolean(report.rig_ok),
    attempt: report.attempt ?? 1,
    tried: (report.attempts ?? []).map((a) => `${a.path}${a.ok ? "" : " (failed)"}`),
    ...(report.rig_ok ? {} : { fails: report.check?.fails ?? [] }),
    minCoverage: report.check?.min_coverage,
  };
}

/**
 * Model sheet -> rigged GLB on our GPU box ({ model, rigged }, as buffers), plus the box's own
 * timings and its rig report (`rig`, see boxRig). Throws on any failure, or if it isn't done within FORGE_3D_TIMEOUT.
 * With `model` (a GLB), the box only rigs that model (forge/gpu/rescue.mjs).
 */
/** How long a scan waits for a warming GPU box before giving up on it, and how often it looks in on it. */
const WARMUP_WAIT_MS = Number(process.env.FORGE_3D_WARMUP_WAIT ?? 360) * 1000;
const WARMUP_POLL_MS = Number(process.env.FORGE_3D_WARMUP_POLL ?? 2000);

/**
 * The GPU box powers itself off when it's had nothing to do for a while (forge/gpu/server.py, FORGE3D_IDLE_STOP_MIN):
 * an idle GPU costs as much as a busy one. Someone about to forge "wants" it: that resets its idle clock if it's up,
 * and bingus's waker (forge/gpu/waker.sh, polling GET /api/gpu/wanted) starts it if it's stopped. The waker holds the
 * AWS key; this server never does.
 */
let gpuWanted = 0;
export function wantGpu() {
  if (ENGINE_3D !== "local") return;
  gpuWanted = Date.now();
  local("/keepalive", { method: "POST" }, 2_000).catch(() => {});
}
/** When a forge last wanted the GPU box (ms, 0 = never). */
export const gpuWantedAt = () => gpuWanted;

const health = () => local("/health", {}, 3_000).then((res) => res.json(), () => null);

export async function makeModelLocal(sheet, onStep, model = null, { onPreview, settings, rigAttempt, face, faceOnly } = {}) {
  // A stopped box doesn't refuse the connection, it just never answers: find out in 3 s, not 20.
  let state = await health();
  // Stopped (idle), starting or loading (~1 min from cold): wait for it rather than fail the scan. A box that's up
  // but broken still fails straight away.
  if (!state?.ready) {
    wantGpu();
    onStep("warmup");
  }
  for (const until = Date.now() + WARMUP_WAIT_MS; !state?.ready && !state?.error && Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, WARMUP_POLL_MS));
    state = await health();
    gpuWanted = Date.now();
  }
  if (!state?.ready) throw new Error(`GPU box not ready: ${state?.error ?? (state ? "warming up" : "not answering")}`);
  const deadline = Date.now() + LOCAL_TIMEOUT_MS;
  // rigAttempt > 1: a re-rig after the rig check turned the first one down (a box that knows another way to weight a
  // model can take it as the cue; one that doesn't just rigs it again).
  // face: paint the sheet's face on (true/false; the box's FORGE3D_FACE_PROJECT otherwise). faceOnly: `model` is already
  // rigged, only paint its face (forge/gpu/face-rescue.mjs).
  const request = {
    image: sheet.toString("base64"),
    model: model?.toString("base64"),
    settings,
    ...(rigAttempt ? { rigAttempt } : {}),
    ...(typeof face === "boolean" ? { face } : {}),
    ...(faceOnly ? { faceOnly: true } : {}),
  };
  const { id } = await (await local("/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) })).json();
  onStep("model");
  const get = async (file, timeoutMs = 60_000) => Buffer.from(await (await local(`/jobs/${id}/${file}`, {}, timeoutMs)).arrayBuffer());
  let step = "model";
  let misses = 0;
  const relayed = new Set();
  for (;;) {
    if (Date.now() > deadline) throw new Error(`GPU job timed out after ${LOCAL_TIMEOUT_MS / 1000} s`);
    await new Promise((r) => setTimeout(r, 500));
    let job;
    try {
      job = await (await local(`/jobs/${id}`, {}, 5_000)).json();
      misses = 0;
    } catch (err) {
      if (++misses > 5) throw err;
      continue;
    }
    // The forging screen's preview: the sparse voxels, then the untextured shape, as soon as the box has them.
    for (const name of Object.keys(job.previews ?? {})) {
      if (!onPreview || relayed.has(name)) continue;
      relayed.add(name);
      get(name, 10_000)
        .then((data) => onPreview(name, data))
        .catch((err) => console.warn(`preview ${name} failed:`, err.message));
    }
    if (job.status === "rig" && step !== "rig") onStep((step = "rig"));
    if (job.status === "failed") throw new Error(`GPU job failed: ${job.error}`);
    if (job.status === "done") {
      // An optimized GLB (the box ran optimize.js) is ~2 MB instead of ~11: only that is on the critical path. The
      // unrigged model isn't used by the game, so it's skipped; the unoptimized original comes later via `original`.
      const rigged = await get("rigged.glb");
      // The same model without its skeleton, for a re-rig if the rig check turns this one down.
      const unrigged = () => get("model.glb");
      const rig = boxRig(job.report);
      if (rig && (rig.path !== "bone-heat" || !rig.ok)) console.warn(`GPU rig ${id.slice(0, 8)}: ${JSON.stringify(rig)}`);
      const faceStep = job.face ?? null; // the face step's report: { painted, seconds, ... }, null when it didn't run
      if (job.optimized) return { model: null, rigged, optimized: true, timings: job.timings, original: () => get("rigged.orig.glb"), unrigged, rig, face: faceStep };
      const plain = await get("model.glb");
      return { model: plain, rigged, timings: job.timings, unrigged: async () => plain, rig, face: faceStep };
    }
  }
}

/**
 * The same through the ZeroGPU Space's Gradio API (forge/gpu/zerogpu/app.py): POST the sheet to
 * /gradio_api/call/forge3d, then read its event stream ("model", "rig", then the rigged GLB's URL). Returns only
 * the rigged model (`model` is null).
 */
export async function makeModelGradio(sheet, onStep) {
  const deadline = Date.now() + LOCAL_TIMEOUT_MS;
  const { event_id: eventId } = await (
    await local("/gradio_api/call/forge3d", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: [sheet.toString("base64")] }) })
  ).json();
  onStep("model");
  const res = await local(`/gradio_api/call/forge3d/${eventId}`, {}, Math.max(1_000, deadline - Date.now()));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let step = "model";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error("GPU Space closed the stream before the model was done");
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: *(.*)$/m.exec(block)?.[1];
      const data = /^data: *(.*)$/m.exec(block)?.[1];
      if (event === "error") throw new Error(`GPU Space: ${data && data !== "null" ? data : "failed"}`);
      if (event !== "generating" && event !== "complete") continue;
      const [file, status] = JSON.parse(data);
      if (status?.status === "rig" && step !== "rig") onStep((step = "rig"));
      if (event === "complete") {
        if (!file?.url) throw new Error("GPU Space returned no model");
        reader.cancel().catch(() => {});
        // Only ever from the Space itself (the HF token goes along).
        const url = new URL(file.url);
        const rigged = Buffer.from(await (await local(url.pathname + url.search, {}, 60_000)).arrayBuffer());
        return { model: null, rigged, timings: status?.timings };
      }
    }
  }
}

// --- Rig QA: no fighter ships a rig that doesn't move (forge/rigcheck.js) ----------------------------------------------

/** What fighter.json keeps of a rig check. */
const rigSummary = (engine, report) => ({
  engine,
  ok: report.ok,
  score: report.score,
  ms: report.stats.ms,
  ...(report.ok ? {} : { problems: report.problems.filter((p) => p.level === "fail").map((p) => p.message) }),
});

/**
 * Checks a freshly rigged GLB the way the game will pose it. If it fails, tries the rescues in order (each returns
 * { rigged, optimized?, original?, engine }) and checks each result the same way. Returns the first candidate that
 * passes, or null: the fighter then ships without a glbUrl and the game gives it the default fighter's body. Records
 * every attempt in job.rigCheck; the first rejected GLB is kept as rigged.rejected.glb (never served) for a look.
 * Without the checker's packages (cd forge && npm ci) the rig ships unchecked, and says so.
 */
export async function gateRig(job, first, rescues, store) {
  const id = String(job.id ?? "").slice(0, 8);
  if (!(await rigCheckAvailable())) {
    job.rigCheck = { skipped: "rig checker not installed (cd forge && npm ci)" };
    console.warn(`forge ${id}: rig NOT checked: ${job.rigCheck.skipped}`);
    return first;
  }
  const attempts = [];
  let candidate = first;
  for (const rescue of [null, ...rescues]) {
    if (rescue) {
      console.warn(`forge ${id}: trying ${rescue.name}`);
      try {
        candidate = await rescue.run();
      } catch (err) {
        attempts.push({ engine: rescue.engine, ok: false, error: String(err.message ?? err).slice(0, 300) });
        console.warn(`forge ${id}: ${rescue.name} failed: ${err.message ?? err}`);
        continue;
      }
    }
    const report = await checkRig(candidate.rigged).catch((err) => ({
      ok: false,
      score: 0,
      problems: [{ level: "fail", message: `checker crashed: ${err.message}` }],
      stats: { ms: 0 },
    }));
    // The GPU box's weighting path, next to the check's verdict on it.
    attempts.push({ ...rigSummary(candidate.engine, report), ...(candidate.rig ? { rig: candidate.rig.path } : {}) });
    if (report.ok) {
      job.rigCheck = { ...attempts.at(-1), ...(attempts.length > 1 ? { attempts } : {}) };
      if (attempts.length > 1) console.warn(`forge ${id}: rig check passed on attempt ${attempts.length} (${candidate.engine}, score ${report.score})`);
      return candidate;
    }
    console.warn(`forge ${id}: RIG CHECK FAILED (${candidate.engine}, score ${report.score}): ${attempts.at(-1).problems.join("; ")}`);
    if (!rescue && store) store.write("rigged.rejected.glb", candidate.rigged);
  }
  job.rigCheck = { ok: false, attempts };
  console.warn(`forge ${id}: no rig passed the check; shipping without a 3D model (the game uses the default body)`);
  return null;
}

async function openai(path, init, timeoutMs) {
  const res = await fetch(API + path, {
    ...init,
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${path} ${res.status}: ${body.error?.message ?? "no details"}`);
  return body;
}

/** @param {{data: Buffer, type: string}[]} frames */
export async function makeBrief(frames) {
  const body = await openai(
    "/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: BRIEF_MODEL,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: BRIEF_PROMPT },
              ...frames.map((f) => ({ type: "image_url", image_url: { url: `data:${f.type};base64,${f.data.toString("base64")}` } })),
            ],
          },
        ],
      }),
    },
    60_000,
  );
  const message = body.choices?.[0]?.message;
  // A refusal comes back as content: null, which JSON.parse would quietly turn into a null brief.
  const brief = typeof message?.content === "string" ? JSON.parse(message.content) : null;
  if (!brief || typeof brief !== "object") throw new Error(`brief: ${message?.refusal ?? "no JSON from the vision model"}`);
  return brief;
}

// --- Commentators (SPEC "Commentators"): a fast LLM writes the calls, OpenAI TTS voices them -------------
const TTS_MODEL = process.env.FORGE_TTS_MODEL ?? "gpt-4o-mini-tts";
/** Play-by-play (A) and color (B). */
const VOICES = { A: process.env.FORGE_VOICE_A ?? "onyx", B: process.env.FORGE_VOICE_B ?? "coral" };
const COMMENTARY_PROMPT = `You are the commentator on a live fighting-game broadcast, like the casters at EVO: fast,
loud, excited the whole time, calling exactly what just happened and, now and then, why it worked or what has to
change. Every line is yours: voice "A". Write 1 or 2 lines (max 12 words each) for the moment described.
Call each fighter by their "name" exactly, and by name rather than he or she. A fighter's brief (archetype, outfit, signature details) can make a call
specific now and then, but it's a fight, not a fashion show. Talk like real fight commentators: no internet slang,
memes or catchphrases ("left the chat", "cooking", "ghosted", "Wi-Fi", "airplane mode", "NPC", "touch grass"), no
jokes about the time, sleep, the hackathon or the players' lives, nothing mean. NEVER comment on bodies, faces,
weight, skin, age or anything a person can't change. Start each line with one delivery tag for the voice: [shouting],
[excited] or [impressed]. Reply as JSON:
{"lines":[{"voice":"A","text":"..."}]}`;

/** @param {{moment: string, fighters: Record<string, {name: string, brief?: unknown}>}} ctx */
export async function commentate(ctx) {
  const body = await openai(
    "/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: BRIEF_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: COMMENTARY_PROMPT },
          { role: "user", content: JSON.stringify(ctx) },
        ],
      }),
    },
    12_000,
  );
  const text = body.choices?.[0]?.message?.content;
  const lines = typeof text === "string" ? JSON.parse(text).lines : null;
  if (!Array.isArray(lines)) return [];
  return lines
    .filter((l) => (l.voice === "A" || l.voice === "B") && typeof l.text === "string")
    .slice(0, 2)
    .map((l) => ({ voice: l.voice, text: l.text.slice(0, 140) }));
}

/**
 * ElevenLabs voices (much more alive than OpenAI's for this): A = Phil, an explosive play-by-play commentator, B = Monika,
 * a high-energy live sports commentator. Both stay hyped. eleven_v3 reads [tags] like [shouting] or [excited] as
 * delivery. (The barks, FIGHT! and K.O., are Ed.)
 */
const ELEVEN_VOICES = {
  A: process.env.ELEVEN_VOICE_A ?? "LG95yZDEHg6fCZdQjLqj",
  B: process.env.ELEVEN_VOICE_B ?? "Cvv0EXhC1Zv7b4a2QfWl",
};
const ELEVEN_MODEL = process.env.ELEVEN_MODEL ?? "eleven_v3";
const ELEVEN_SETTINGS = { stability: 0.3, similarity_boost: 0.8, style: 0.85, speed: 1.12 };

/** What a cached clip depends on besides its text: change the voice or its settings and old clips aren't reused. */
export function voiceKey(voice) {
  return process.env.ELEVENLABS_API_KEY ? `${ELEVEN_VOICES[voice] ?? ELEVEN_VOICES.A}:${ELEVEN_MODEL}:${JSON.stringify(ELEVEN_SETTINGS)}` : `openai:${VOICES[voice] ?? VOICES.A}`;
}

/**
 * Our ElevenLabs plan takes 5 calls at once; past that they come back 429. A match asks for its lines all together
 * (both laptops), so calls wait for a slot here: lines being said right now first, lines fetched ahead after.
 */
const ELEVEN_AT_ONCE = Number(process.env.ELEVEN_CONCURRENCY ?? 4);
let elevenBusy = 0;
const elevenWaiting = { now: [], ahead: [] };
function elevenSlot(urgent) {
  if (elevenBusy < ELEVEN_AT_ONCE) {
    elevenBusy++;
    return Promise.resolve();
  }
  return new Promise((resolve) => elevenWaiting[urgent ? "now" : "ahead"].push(resolve));
}
function elevenDone() {
  const next = elevenWaiting.now.shift() ?? elevenWaiting.ahead.shift();
  if (next) next();
  else elevenBusy--;
}

async function speakEleven(text, voice, urgent) {
  for (let attempt = 0; ; attempt++) {
    await elevenSlot(urgent);
    let res;
    try {
      res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICES[voice] ?? ELEVEN_VOICES.A}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: ELEVEN_MODEL,
          voice_settings: ELEVEN_SETTINGS,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } finally {
      elevenDone();
    }
    // Busy (someone else on the key, or the plan's limit): wait and go again rather than give up.
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1) + Math.random() * 300));
      continue;
    }
    throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * One commentator line as MP3 bytes: ElevenLabs when configured (and only ElevenLabs: another voice for some lines
 * sounds like a different commentator, so a line it can't voice isn't voiced), else OpenAI. `urgent`: to be said now,
 * as opposed to fetched ahead.
 */
export async function speak(text, voice, { urgent = true } = {}) {
  if (process.env.ELEVENLABS_API_KEY) return speakEleven(text, voice, urgent);
  const res = await fetch(API + "/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: VOICES[voice] ?? VOICES.A,
      input: text.replace(/\[[^\]]*\]\s*/g, ""),
      response_format: "mp3",
      instructions: voice === "B"
        ? "Hyped fighting-game co-commentator. Fast, excited, punchy, live-broadcast energy."
        : "Hyped fighting-game announcer. Fast, loud, punchy, arena energy.",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Generates a new image from reference images plus a prompt. Returns PNG bytes. */
export async function editImage(refs, prompt, model = IMAGE_MODEL, size = SHEET_SIZE, onPartial = null) {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", IMAGE_QUALITY);
  if (INPUT_FIDELITY && model.startsWith("gpt-image-1")) form.append("input_fidelity", INPUT_FIDELITY);
  refs.forEach((ref, i) => form.append("image[]", new Blob([ref.data], { type: ref.type }), `ref${i}.${ref.type.split("/")[1]}`));
  if (onPartial) {
    try {
      return await streamImage(form, onPartial);
    } catch (err) {
      // Streaming is only for the preview: if it's refused, draw the image the plain way.
      if (!err.refused) throw err;
      console.warn("partial images refused, drawing without them:", err.message);
      form.delete("stream");
      form.delete("partial_images");
    }
  }
  const body = await openai("/images/edits", { method: "POST", body: form }, 180_000);
  return Buffer.from(body.data[0].b64_json, "base64");
}

/**
 * The same edit, streamed: OpenAI sends a partial image or two before the final one (sunburst sends one ~5 s before
 * the end, already close to final). `onPartial(png, index)` gets each; returns the final PNG.
 */
async function streamImage(form, onPartial) {
  form.set("stream", "true");
  form.set("partial_images", String(SHEET_PARTIALS));
  const res = await fetch(API + "/images/edits", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(`OpenAI /images/edits ${res.status}: ${body.error?.message ?? "no details"}`);
    err.refused = res.status === 400 && /stream|partial/i.test(body.error?.message ?? body.error?.param ?? "");
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error("OpenAI image stream ended without an image");
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = /^data: *(.*)$/m.exec(block)?.[1];
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      if (event.type === "error" || event.error) throw new Error(`OpenAI image stream: ${event.error?.message ?? "error"}`);
      if (!event.b64_json) continue;
      const png = Buffer.from(event.b64_json, "base64");
      if (event.type?.endsWith("partial_image")) {
        try {
          onPartial(png, event.partial_image_index ?? 0);
        } catch (err) {
          console.warn("partial image handler failed:", err.message);
        }
      } else {
        reader.cancel().catch(() => {});
        return png;
      }
    }
  }
}

/**
 * Runs every step for one fighter, updating `job` as it goes.
 * @param {object} job  the fighter record (mutated)
 * @param {{data: Buffer, type: string}[]} frames
 * @param {{save: () => void, write: (file: string, data: Buffer) => string}} store
 */
export async function runForge(job, frames, store) {
  /** Fetches the GPU box's unoptimized GLB, when the box sent an optimized one (kept after the fighter is ready). */
  let original = null;
  const timed = async (key, fn) => {
    const start = Date.now();
    const result = await fn();
    job.timings[key] = Date.now() - start;
    return result;
  };
  try {
    job.status = "forging";
    job.step = "brief";
    store.save();
    job.brief = await timed("brief", () => makeBrief(frames));
    if (job.name === "") job.name = typeof job.brief.name === "string" ? job.brief.name.slice(0, 40) : "";

    job.step = "sheet";
    store.save();
    // The forging screen shows the sheet developing: each partial OpenAI streams goes out as a small WebP.
    let partials = 0;
    const onPartial = (png) => {
      const n = ++partials;
      optimizeImage(png, { width: 512, height: 768, quality: 70 })
        .then((webp) => {
          job.sheetPartialUrl = store.write(`sheet-partial-${n}.webp`, webp);
          store.save();
        })
        .catch((err) => console.warn("sheet partial failed:", err.message));
    };
    const hq = job.quality === "hq";
    const sheet = await timed("sheet", () =>
      editImage(frames, sheetPrompt(job.brief), hq ? HQ.imageModel : IMAGE_MODEL, hq ? HQ.sheetSize : SHEET_SIZE, SHEET_PARTIALS > 0 ? onPartial : null),
    );
    job.sheetUrl = store.write("sheet.png", sheet);
    // Its WebP copy right away, next to the 3D step, instead of at the end (optimize.js skips copies that exist).
    const webpCopies = () => (store.dir ? optimizeFighter(store.dir, {}, { glb: false }) : Promise.resolve());
    webpCopies();

    // The card and the 3D model both only need the sheet, so they run side by side. Without a GPU service (or if it
    // fails) glbUrl stays empty and the game uses its default fighter.
    job.step = "model";
    store.save();
    const sheetRef = [{ data: sheet, type: "image/png" }];
    // The card is decoration: if it fails (moderation, timeout), the fighter still ships without one.
    const cardJob = timed("card", () => editImage(sheetRef, cardPrompt(job.brief), CARD_MODEL, CARD_SIZE))
      .then((card) => {
        job.cardUrl = store.write("card.png", card);
        store.save();
        webpCopies();
      })
      .catch((err) => {
        job.cardError = String(err.message ?? err);
        console.warn("card step failed:", job.cardError);
      });
    const onStep = (step) => ((job.step = step), store.save());
    // Our GPU service (FORGE_3D=local or gradio) builds and rigs the model. The box's intermediates for the forging screen: stage 1's sparse voxels, then the untextured shape.
    const PREVIEWS = { "voxels.bin": ["preview-voxels.bin", "previewVoxelsUrl"], "shape.glb": ["preview-shape.glb", "previewMeshUrl"] };
    const onPreview = (name, data) => {
      if (!PREVIEWS[name] || job.status !== "forging") return;
      const [file, key] = PREVIEWS[name];
      job[key] = store.write(file, data);
      store.save();
    };
    const localModel = () =>
      timed("model", () => (ENGINE_3D === "gradio" ? makeModelGradio(sheet, onStep) : makeModelLocal(sheet, onStep, null, { onPreview, settings: hq ? HQ.gpu : undefined })))
        .then((out) => {
          job.engine3d = ENGINE_3D;
          job.gpuTimings = out.timings;
          if (out.rig) job.gpuRig = out.rig;
          if (out.face) job.gpuFace = out.face;
          job.glbOptimized = Boolean(out.optimized);
          original = out.original ?? null;
          return out;
        });
    // When the rig check turns a rig down: the GPU box rigs the same model once more, another way.
    const rescuesFor = (out) => {
      const list = [];
      if (ENGINE_3D === "local" && out.unrigged) {
        list.push({
          name: "GPU re-rig",
          engine: "local",
          run: async () => ({ ...(await makeModelLocal(sheet, () => {}, await out.unrigged(), { rigAttempt: 2 })), engine: "local" }),
        });
      }
      return list;
    };
    const modelJob =
      ENGINE_3D
        ? localModel()
            .then(async (out) => {
              if (out.model) job.modelUrl = store.write("model.glb", out.model);
              let rigged = out.rigged;
              if (rigged) {
                // Checked before glbUrl is set, so not even the forging preview shows a rig that doesn't move.
                const first = { ...out, engine: job.engine3d };
                const passed = await timed("rigCheck", () => gateRig(job, first, rescuesFor(out), store));
                if (!passed) {
                  // No glbUrl: a ready fighter without one fights with the default fighter's body (FighterView).
                  original = null;
                  job.glbOptimized = false;
                  job.rigged = false;
                  return;
                }
                if (passed !== first) {
                  job.rigEngine = passed.engine;
                  if (passed.rig) job.gpuRig = passed.rig;
                  if (passed.face) job.gpuFace = passed.face;
                  job.glbOptimized = Boolean(passed.optimized);
                  original = passed.original ?? null;
                }
                rigged = passed.rigged;
              }
              if (rigged) job.glbUrl = store.write("rigged.glb", rigged);
              else job.glbUrl = job.modelUrl;
              job.modelUrl ??= job.glbUrl;
              job.rigged = Boolean(rigged);
            })
            .catch((err) => {
              job.modelError = String(err.message ?? err);
              console.warn("3D step failed:", job.modelError);
            })
        : Promise.resolve();
    await Promise.all([cardJob, modelJob]);
    // Before "ready", so no browser ever caches the 10 MB original: WebP textures + meshopt GLB, WebP card (optimize.js).
    // The GPU box already optimizes the GLB (and faster), so then only the card and sheet copies are left, if any.
    if (store.dir) await timed("optimize", () => optimizeFighter(store.dir, job, { glb: !job.glbOptimized }));

    job.status = "ready";
    delete job.step;
  } catch (err) {
    job.status = "failed";
    job.error = String(err.message ?? err);
  }
  try {
    store.save();
  } catch (err) {
    console.error("could not save fighter", job.id, err.message);
  }
  // Keep the unoptimized original next to it, like optimize.js does, without making the player wait for it.
  if (original && job.status === "ready" && job.glbUrl?.endsWith("/rigged.glb")) {
    original()
      .then((glb) => store.write("rigged.orig.glb", glb))
      .catch((err) => console.warn("original GLB not kept:", err.message));
  }
}
