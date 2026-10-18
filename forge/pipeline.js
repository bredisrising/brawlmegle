// The forge pipeline: scan frames -> brief -> model sheet -> card art (and later the 3D model, in parallel with the card).
import { BRIEF_PROMPT, sheetPrompt, cardPrompt } from "./prompts.js";

const API = "https://api.openai.com/v1";
const BRIEF_MODEL = process.env.FORGE_BRIEF_MODEL ?? "gpt-5.4-mini";
// Picked from a head-to-head on 2026-10-17: sunburst follows the style prompt best (18 s at medium), flare is the
// fastest (12 s) and fine for the card, which runs next to the 3D step anyway. chatgpt-image-latest came out as
// 2D pixel art, and gpt-image-2 was slower and smoother.
const IMAGE_MODEL = process.env.FORGE_IMAGE_MODEL ?? "gpt-image-2.5-sunburst";
const CARD_MODEL = process.env.FORGE_CARD_MODEL ?? "gpt-image-2.5-flare";
const IMAGE_QUALITY = process.env.FORGE_IMAGE_QUALITY ?? "medium";
/** "high" keeps faces closer to the photos. Only gpt-image-1 models accept it; gpt-image-2 rejects it. */
const INPUT_FIDELITY = process.env.FORGE_INPUT_FIDELITY ?? "high";

export const models = { brief: BRIEF_MODEL, sheet: IMAGE_MODEL, card: CARD_MODEL, quality: IMAGE_QUALITY, threeD: process.env.TRIPO_API_KEY ? `tripo ${TRIPO_MODEL}, ${FACE_LIMIT} faces + mixamo rig` : "off (no TRIPO_API_KEY)" };

// --- Tripo (image -> low-poly 3D model -> Mixamo-rigged GLB) ------------------------------------------
// https://developers.tripo3d.ai/llms.txt. Output URLs expire after 5 minutes, so models are downloaded at once.
const TRIPO = "https://openapi.tripo3d.ai/v3";
// Picked from a side-by-side on 2026-10-17: H v3.1 at 30k faces with detailed textures had the best face and hair
// detail (40 credits, ~67 s); P1 at 6k faces with fast textures was blurry, P1 at 20k detailed cost 60 credits.
const TRIPO_MODEL = process.env.FORGE_TRIPO_MODEL ?? "v3.1-20260211";
const FACE_LIMIT = Number(process.env.FORGE_FACE_LIMIT ?? 30000);
/** v1.0 is Tripo's humanoid (biped) rigger; v3.0-20260909 is newer and opt-in. */
const RIG_MODEL = process.env.FORGE_RIG_MODEL ?? "v1.0-20240301";

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
  for (;;) {
    const task = await tripo(`/tasks/${taskId}`);
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

/**
 * Model sheet -> rigged GLB. Returns { model, rigged } as buffers; `rigged` is null if rigging failed, so the
 * game can still use the static model (or its default fighter).
 */
export async function makeModel(sheet, onStep) {
  const form = new FormData();
  form.append("file", new Blob([sheet], { type: "image/png" }), "sheet.png");
  const { file_token } = await tripo("/files", { method: "POST", body: form });

  onStep("model");
  const gen = await tripoJson("/generation/image-to-model", {
    input: file_token,
    model: TRIPO_MODEL,
    face_limit: FACE_LIMIT,
    texture: true,
    pbr: true,
    texture_version: "v3.5-20260815",
    texture_quality: "detailed",
  });
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
  return JSON.parse(body.choices[0].message.content);
}

/** Generates a new image from reference images plus a prompt. Returns PNG bytes. */
export async function editImage(refs, prompt, model = IMAGE_MODEL) {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", "1024x1536");
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
    if (job.name === "") job.name = job.brief.name ?? "";

    job.step = "sheet";
    store.save();
    const sheet = await timed("sheet", () => editImage(frames, sheetPrompt(job.brief)));
    job.sheetUrl = store.write("sheet.png", sheet);

    // The card and the 3D model both only need the sheet, so they run side by side. Without a Tripo key (or if
    // it fails) glbUrl stays empty and the game uses its default fighter.
    job.step = "model";
    store.save();
    const cardJob = timed("card", () => editImage([{ data: sheet, type: "image/png" }], cardPrompt(job.brief), CARD_MODEL)).then((card) => {
      job.cardUrl = store.write("card.png", card);
      store.save();
    });
    const modelJob = process.env.TRIPO_API_KEY
      ? timed("model", () => makeModel(sheet, (step) => ((job.step = step), store.save())))
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
  store.save();
}
