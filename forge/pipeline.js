// The forge pipeline: scan frames -> brief -> model sheet -> card art, next to (back view ->) 3D model -> rig.
// Settings below were picked in research/forge-quality.md (2026-10-17); every one can be overridden from the env.
import { BRIEF_PROMPT, STYLE, sheetPrompt, cardPrompt, backPrompt } from "./prompts.js";
import { optimizeFighter, optimizeImage } from "./optimize.js";

const API = "https://api.openai.com/v1";
const BRIEF_MODEL = process.env.FORGE_BRIEF_MODEL ?? "gpt-5.4-mini";
/**
 * Our GPU box builds the model (FORGE_3D=local or gradio; Tripo is then only the fallback). Sunburst follows the style
 * prompt best for Tripo (about 19 s at 1536x2304). For the GPU box, flare at 1024x1536 draws a sheet TRELLIS turns
 * into an equally good fighter in 12-13 s (research/forge-gpu.md); FORGE_GPU_SHEET=0 keeps sunburst 1536x2304.
 */
const FAST_SHEET = Boolean(process.env.FORGE_3D_URL) && ["local", "gradio"].includes(process.env.FORGE_3D) && (process.env.FORGE_GPU_SHEET ?? "1") !== "0";
const IMAGE_MODEL = process.env.FORGE_IMAGE_MODEL ?? (FAST_SHEET ? "gpt-image-2.5-flare" : "gpt-image-2.5-sunburst");
const CARD_MODEL = process.env.FORGE_CARD_MODEL ?? "gpt-image-2.5-flare";
const IMAGE_QUALITY = process.env.FORGE_IMAGE_QUALITY ?? "medium";
/** "high" keeps faces closer to the photos. Only gpt-image-1 models accept it; gpt-image-2 rejects it. */
const INPUT_FIDELITY = process.env.FORGE_INPUT_FIDELITY ?? "high";
// FORGE_STYLE=goldsrc brings back the whole previous forge (low-poly sheet, 30k faces, single image), not just the look.
const GOLDSRC = STYLE === "goldsrc";
const flag = (name, fallback) => (process.env[name] ?? (fallback ? "1" : "0")) !== "0";
/**
 * Tripo only rebuilds the detail the sheet has, so for Tripo the detailed style draws it at the biggest
 * non-experimental 2:3 size (about 3 s slower than 1024x1536). TRELLIS reads the sheet at 1024 px tall anyway.
 */
const SHEET_SIZE = process.env.FORGE_SHEET_SIZE ?? (GOLDSRC || FAST_SHEET ? "1024x1536" : "1536x2304");
const CARD_SIZE = "1024x1536";
/**
 * Draw the back of the sheet too and build the model from front + back (multiview): a real back and hair from
 * behind. Off by default for speed (+20 s on the player's wait); FORGE_MULTIVIEW=1 turns it on.
 */
const MULTIVIEW = flag("FORGE_MULTIVIEW", false);
/** Partial sheet images streamed for the forging screen's preview (0 turns streaming off). */
const SHEET_PARTIALS = Number(process.env.FORGE_SHEET_PARTIALS ?? 3);

// --- Tripo (model sheet -> textured 3D model -> Mixamo-rigged GLB) ---------------------------------------
// https://developers.tripo3d.ai/llms.txt. Output URLs expire after 5 minutes, so models are downloaded at once.
const TRIPO = "https://openapi.tripo3d.ai/v3";
const TRIPO_MODEL = process.env.FORGE_TRIPO_MODEL ?? "v3.1-20260211";
/** 60000 suits Ultra geometry (FORGE_GEOMETRY_QUALITY=detailed); standard geometry doesn't use more than this. */
const FACE_LIMIT = Number(process.env.FORGE_FACE_LIMIT ?? (GOLDSRC ? 30000 : 40000));
/**
 * "detailed" is Tripo's Ultra geometry (+20 credits, about +12 s): crisper faces, ears, folds. Standard by default:
 * the new sheet and delight off carry most of the look, and players are waiting (research/forge-quality.md).
 */
const GEOMETRY_QUALITY = process.env.FORGE_GEOMETRY_QUALITY ?? "standard";
/**
 * Delight strips the lighting out of the sheet before texturing. Off keeps the sheet's painted shading (folds,
 * brows, cheekbones), which is most of what made the textures look flat. On is Tripo's default.
 */
const DELIGHT = flag("FORGE_DELIGHT", GOLDSRC);
/** v1.0 is Tripo's humanoid (biped) rigger; v3.0-20260909 is newer and opt-in. */
const RIG_MODEL = process.env.FORGE_RIG_MODEL ?? "v1.0-20240301";

// --- Our own GPU box (forge/gpu): model sheet -> textured, Mixamo-rigged GLB with TRELLIS.2 + Blender ----------
/**
 * "local" sends the sheet to the GPU service's job API (the AWS box, or the Docker Space); "gradio" to the ZeroGPU
 * Space's /forge3d endpoint. Tripo stays the fallback for any failure or timeout.
 */
const ENGINE_3D = process.env.FORGE_3D_URL && ["local", "gradio"].includes(process.env.FORGE_3D) ? process.env.FORGE_3D : null;
const LOCAL_URL = (process.env.FORGE_3D_URL ?? "").replace(/\/$/, "");
const LOCAL_TIMEOUT_MS = Number(process.env.FORGE_3D_TIMEOUT ?? 90) * 1000;

const tripoSettings = `tripo ${TRIPO_MODEL}${MULTIVIEW ? " multiview" : ""}, ${GEOMETRY_QUALITY} geometry, ${FACE_LIMIT} faces, delight ${DELIGHT ? "on" : "off"} + mixamo rig`;
export const models = {
  brief: BRIEF_MODEL,
  sheet: `${IMAGE_MODEL} ${SHEET_SIZE}, ${STYLE} style`,
  card: CARD_MODEL,
  quality: IMAGE_QUALITY,
  threeD: ENGINE_3D
    ? `GPU service (${ENGINE_3D}, ${LOCAL_URL}), then ${process.env.TRIPO_API_KEY ? tripoSettings : "nothing"} as the fallback`
    : process.env.TRIPO_API_KEY
      ? tripoSettings
      : "off (no TRIPO_API_KEY or FORGE_3D)",
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
 * Model sheet -> rigged GLB on our GPU box. Same result as makeModel ({ model, rigged }), plus the box's own
 * timings. Throws on any failure, or if it isn't done within FORGE_3D_TIMEOUT, so the caller can fall back to Tripo.
 * With `model` (a GLB), the box only rigs that model (forge/gpu/rescue.mjs).
 */
export async function makeModelLocal(sheet, onStep, model = null, { onPreview, settings } = {}) {
  const deadline = Date.now() + LOCAL_TIMEOUT_MS;
  // A stopped box doesn't refuse the connection, it just never answers: find out in 3 s, not 20.
  const health = await (await local("/health", {}, 3_000)).json();
  if (!health.ready) throw new Error(`GPU box not ready: ${health.error ?? "warming up"}`);
  const request = { image: sheet.toString("base64"), model: model?.toString("base64"), settings };
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
      if (job.optimized) return { model: null, rigged, optimized: true, timings: job.timings, original: () => get("rigged.orig.glb") };
      return { model: await get("model.glb"), rigged, timings: job.timings };
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

async function tripo(path, init = {}, timeoutMs = 60_000) {
  const res = await fetch(TRIPO + path, {
    ...init,
    headers: { authorization: `Bearer ${process.env.TRIPO_API_KEY}`, ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.code !== 0) throw new Error(`Tripo ${path} ${res.status}: ${body.message ?? body.msg ?? JSON.stringify(body).slice(0, 200)}`);
  return body.data;
}

const tripoJson = (path, payload) =>
  tripo(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

/** Polls a Tripo task until it finishes; returns its output. */
async function tripoWait(taskId, onProgress, timeoutMs = 300_000) {
  const start = Date.now();
  let misses = 0;
  for (;;) {
    let task;
    try {
      task = await tripo(`/tasks/${taskId}`);
      misses = 0;
    } catch (err) {
      // One dropped status poll shouldn't throw away a model that's still generating (and already paid for).
      if (++misses > 3 || Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (task.status === "success") return task.output;
    if (["failed", "cancelled", "banned", "expired", "unknown"].includes(task.status)) throw new Error(`Tripo task ${task.status}`);
    onProgress?.(task.progress ?? 0);
    if (Date.now() - start > timeoutMs) throw new Error("Tripo task timed out");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function upload(png) {
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "sheet.png");
  return (await tripo("/files", { method: "POST", body: form })).file_token;
}

/**
 * Model sheet (+ its back view, if any) -> rigged GLB. Returns { model, rigged } as buffers; `rigged` is null if
 * rigging failed, so the game can still use the static model (or its default fighter).
 */
export async function makeModel(sheet, onStep, back = null) {
  const [front, behind] = await Promise.all([upload(sheet), back ? upload(back) : null]);

  onStep("model");
  const settings = {
    model: TRIPO_MODEL,
    face_limit: FACE_LIMIT,
    geometry_quality: GEOMETRY_QUALITY,
    texture: true,
    pbr: true,
    texture_version: "v3.5-20260815",
    texture_quality: "detailed",
    delight: DELIGHT,
  };
  const gen = behind
    ? await tripoJson("/generation/multiview-to-model", { inputs: [{ front }, { back: behind }], ...settings })
    : await tripoJson("/generation/image-to-model", { input: front, ...settings });
  const genOut = await tripoWait(gen.task_id);
  const model = await download(genOut.pbr_model_url ?? genOut.model_url);

  onStep("rig");
  let rigged = null;
  try {
    // The rig model must be explicit: Tripo otherwise infers one from the generation and rejects it.
    const rig = await tripoJson("/animations/rig", { input: gen.task_id, model: RIG_MODEL, rig_type: "biped", spec: "mixamo", out_format: "glb" });
    const rigOut = await tripoWait(rig.task_id);
    rigged = await download(rigOut.model_url);
  } catch (err) {
    console.warn("rig failed, using the static model:", err.message);
  }
  return { model, rigged };
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
const COMMENTARY_PROMPT = `You are two fighting-game commentators calling a webcam fighting game at a college hackathon
(DubHacks, late at night). A is the hype play-by-play announcer, B is the dry, roasting color commentator.
Write 1 or 2 short lines (max 14 words each) for the moment described. Call each fighter by their "name" exactly
(it's their username); the brief's nickname and details are only flavor for the jokes. Start each line with one
delivery tag for the voice actor: A uses [shouting] or [excited], B uses [deadpan], [sarcastic] or [laughs]. Be funny and
specific: roast the fighting, the outfits and costume details, the hour, the record. NEVER comment on bodies,
faces, weight, skin, age or anything a person can't change. Keep it PG-13. Reply as JSON:
{"lines":[{"voice":"A"|"B","text":"..."}]}`;

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
 * ElevenLabs voices (much more alive than OpenAI's for this): A = Ed, the arena announcer who also does the barks,
 * B = Blue, a dry Gen-Z sports commentator. eleven_v3 reads [tags] like [excited] or [sarcastic] as delivery.
 */
const ELEVEN_VOICES = {
  A: process.env.ELEVEN_VOICE_A ?? "dHd5gvgSOzSfduK4CvEg",
  B: process.env.ELEVEN_VOICE_B ?? "kfU9VUUMjY4PWNoUfZ45",
};

async function speakEleven(text, voice) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICES[voice] ?? ELEVEN_VOICES.A}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVEN_MODEL ?? "eleven_v3",
      voice_settings: { stability: voice === "B" ? 0.5 : 0.3, similarity_boost: 0.8, style: voice === "B" ? 0.4 : 0.8, speed: 1.1 },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** One commentator line as MP3 bytes (ElevenLabs when configured, else OpenAI). */
export async function speak(text, voice) {
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      return await speakEleven(text, voice);
    } catch (err) {
      console.warn("elevenlabs failed, falling back to openai:", err.message);
    }
  }
  const res = await fetch(API + "/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: VOICES[voice] ?? VOICES.A,
      input: text.replace(/\[[^\]]*\]\s*/g, ""),
      response_format: "mp3",
      instructions: voice === "B"
        ? "Dry, witty fighting-game color commentator. Quick, deadpan, a little smug."
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
    const sheet = await timed("sheet", () => editImage(frames, sheetPrompt(job.brief), IMAGE_MODEL, SHEET_SIZE, SHEET_PARTIALS > 0 ? onPartial : null));
    job.sheetUrl = store.write("sheet.png", sheet);
    // Its WebP copy right away, next to the 3D step, instead of at the end (optimize.js skips copies that exist).
    const webpCopies = () => (store.dir ? optimizeFighter(store.dir, {}, { glb: false }) : Promise.resolve());
    webpCopies();

    // The card and the 3D model both only need the sheet, so they run side by side. Without a Tripo key (or if
    // it fails) glbUrl stays empty and the game uses its default fighter.
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
    // The back view only sharpens the model: if it fails, the model is built from the front alone.
    const backView = () =>
      timed("back", () => editImage(sheetRef, backPrompt()))
        .then((back) => (store.write("back.png", back), back))
        .catch((err) => (console.warn("back view failed, building from the front only:", err.message ?? err), null));
    const onStep = (step) => ((job.step = step), store.save());
    const tripoModel = () =>
      (MULTIVIEW ? backView() : Promise.resolve(null)).then((back) => {
        job.engine3d = "tripo";
        return timed("model", () => makeModel(sheet, onStep, back));
      });
    // Our GPU service first (FORGE_3D=local or gradio). On any failure or timeout Tripo builds the model as before;
    // the GPU's try stays in timings.localTry so the wait it added shows up.
    const localStart = Date.now();
    // The box's intermediates for the forging screen: stage 1's sparse voxels, then the untextured shape.
    const PREVIEWS = { "voxels.bin": ["preview-voxels.bin", "previewVoxelsUrl"], "shape.glb": ["preview-shape.glb", "previewMeshUrl"] };
    const onPreview = (name, data) => {
      if (!PREVIEWS[name] || job.status !== "forging") return;
      const [file, key] = PREVIEWS[name];
      job[key] = store.write(file, data);
      store.save();
    };
    const localModel = () =>
      timed("model", () => (ENGINE_3D === "gradio" ? makeModelGradio(sheet, onStep) : makeModelLocal(sheet, onStep, null, { onPreview })))
        .then((out) => {
          job.engine3d = ENGINE_3D;
          job.gpuTimings = out.timings;
          job.glbOptimized = Boolean(out.optimized);
          original = out.original ?? null;
          return out;
        })
        .catch((err) => {
          job.localError = String(err.message ?? err);
          job.timings.localTry = Date.now() - localStart;
          console.warn("GPU 3D step failed:", job.localError, process.env.TRIPO_API_KEY ? "(falling back to Tripo)" : "");
          if (!process.env.TRIPO_API_KEY) throw err;
          job.step = "model";
          return tripoModel();
        });
    const modelJob =
      ENGINE_3D || process.env.TRIPO_API_KEY
        ? (ENGINE_3D ? localModel() : tripoModel())
            .then(({ model, rigged }) => {
              if (model) job.modelUrl = store.write("model.glb", model);
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
