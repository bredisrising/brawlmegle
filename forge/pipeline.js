// The forge pipeline: scan frames -> brief -> model sheet -> card art, next to (back view ->) 3D model -> rig.
// Settings below were picked in research/forge-quality.md (2026-10-17); every one can be overridden from the env.
import { BRIEF_PROMPT, STYLE, sheetPrompt, cardPrompt, backPrompt } from "./prompts.js";

const API = "https://api.openai.com/v1";
const BRIEF_MODEL = process.env.FORGE_BRIEF_MODEL ?? "gpt-5.4-mini";
// Sunburst follows the style prompt best (about 19 s at medium, even at 1536x2304); flare is the fastest (12 s) and
// fine for the card, which runs next to the 3D step anyway.
const IMAGE_MODEL = process.env.FORGE_IMAGE_MODEL ?? "gpt-image-2.5-sunburst";
const CARD_MODEL = process.env.FORGE_CARD_MODEL ?? "gpt-image-2.5-flare";
const IMAGE_QUALITY = process.env.FORGE_IMAGE_QUALITY ?? "medium";
/** "high" keeps faces closer to the photos. Only gpt-image-1 models accept it; gpt-image-2 rejects it. */
const INPUT_FIDELITY = process.env.FORGE_INPUT_FIDELITY ?? "high";
// FORGE_STYLE=goldsrc brings back the whole previous forge (low-poly sheet, 30k faces, single image), not just the look.
const GOLDSRC = STYLE === "goldsrc";
const flag = (name, fallback) => (process.env[name] ?? (fallback ? "1" : "0")) !== "0";
/**
 * Tripo only rebuilds the detail the sheet has, so the detailed style draws it at the biggest non-experimental
 * 2:3 size (about 3 s slower than 1024x1536). The card is only shown small.
 */
const SHEET_SIZE = process.env.FORGE_SHEET_SIZE ?? (GOLDSRC ? "1024x1536" : "1536x2304");
const CARD_SIZE = "1024x1536";
/**
 * Draw the back of the sheet too and build the model from front + back (multiview): a real back and hair from
 * behind. Off by default for speed (+20 s on the player's wait); FORGE_MULTIVIEW=1 turns it on.
 */
const MULTIVIEW = flag("FORGE_MULTIVIEW", false);

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
/** "local" sends the sheet to the GPU service first; Tripo stays the fallback for any failure or timeout. */
const LOCAL_3D = (process.env.FORGE_3D ?? "tripo") === "local" && Boolean(process.env.FORGE_3D_URL);
const LOCAL_URL = (process.env.FORGE_3D_URL ?? "").replace(/\/$/, "");
const LOCAL_TIMEOUT_MS = Number(process.env.FORGE_3D_TIMEOUT ?? 90) * 1000;

const tripoSettings = `tripo ${TRIPO_MODEL}${MULTIVIEW ? " multiview" : ""}, ${GEOMETRY_QUALITY} geometry, ${FACE_LIMIT} faces, delight ${DELIGHT ? "on" : "off"} + mixamo rig`;
export const models = {
  brief: BRIEF_MODEL,
  sheet: `${IMAGE_MODEL} ${SHEET_SIZE}, ${STYLE} style`,
  card: CARD_MODEL,
  quality: IMAGE_QUALITY,
  threeD: LOCAL_3D
    ? `local GPU (${LOCAL_URL}), then ${process.env.TRIPO_API_KEY ? tripoSettings : "nothing"} as the fallback`
    : process.env.TRIPO_API_KEY
      ? tripoSettings
      : "off (no TRIPO_API_KEY or FORGE_3D=local)",
};

async function local(path, init = {}, timeoutMs = 20_000) {
  const res = await fetch(LOCAL_URL + path, {
    ...init,
    headers: { "x-forge3d-key": process.env.FORGE_3D_KEY ?? "", ...init.headers },
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
 */
export async function makeModelLocal(sheet, onStep) {
  const deadline = Date.now() + LOCAL_TIMEOUT_MS;
  const { id } = await (
    await local("/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: sheet.toString("base64") }) })
  ).json();
  onStep("model");
  let step = "model";
  let misses = 0;
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
    if (job.status === "rig" && step !== "rig") onStep((step = "rig"));
    if (job.status === "failed") throw new Error(`GPU job failed: ${job.error}`);
    if (job.status === "done") {
      const get = async (file) => Buffer.from(await (await local(`/jobs/${id}/${file}`, {}, 60_000)).arrayBuffer());
      const [rigged, model] = await Promise.all([get("rigged.glb"), get("model.glb")]);
      return { model, rigged, timings: job.timings };
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

/** Generates a new image from reference images plus a prompt. Returns PNG bytes. */
export async function editImage(refs, prompt, model = IMAGE_MODEL, size = SHEET_SIZE) {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", IMAGE_QUALITY);
  if (INPUT_FIDELITY && model.startsWith("gpt-image-1")) form.append("input_fidelity", INPUT_FIDELITY);
  refs.forEach((ref, i) => form.append("image[]", new Blob([ref.data], { type: ref.type }), `ref${i}.${ref.type.split("/")[1]}`));
  const body = await openai("/images/edits", { method: "POST", body: form }, 180_000);
  return Buffer.from(body.data[0].b64_json, "base64");
}

/**
 * Runs every step for one fighter, updating `job` as it goes.
 * @param {object} job  the fighter record (mutated)
 * @param {{data: Buffer, type: string}[]} frames
 * @param {{save: () => void, write: (file: string, data: Buffer) => string}} store
 */
export async function runForge(job, frames, store) {
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
    const sheet = await timed("sheet", () => editImage(frames, sheetPrompt(job.brief)));
    job.sheetUrl = store.write("sheet.png", sheet);

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
    // Our GPU box first (FORGE_3D=local). On any failure or timeout Tripo builds the model as before; the GPU's
    // try stays in timings.localTry so the wait it added shows up.
    const localStart = Date.now();
    const localModel = () =>
      timed("model", () => makeModelLocal(sheet, onStep))
        .then((out) => {
          job.engine3d = "local";
          job.gpuTimings = out.timings;
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
      LOCAL_3D || process.env.TRIPO_API_KEY
        ? (LOCAL_3D ? localModel() : tripoModel())
            .then(({ model, rigged }) => {
              job.modelUrl = store.write("model.glb", model);
              if (rigged) job.glbUrl = store.write("rigged.glb", rigged);
              else job.glbUrl = job.modelUrl;
              job.rigged = Boolean(rigged);
            })
            .catch((err) => {
              job.modelError = String(err.message ?? err);
              console.warn("3D step failed:", job.modelError);
            })
        : Promise.resolve();
    await Promise.all([cardJob, modelJob]);

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
}
