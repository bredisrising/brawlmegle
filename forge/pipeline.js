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

export const models = { brief: BRIEF_MODEL, sheet: IMAGE_MODEL, card: CARD_MODEL, quality: IMAGE_QUALITY };

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

    // The card and the 3D model both only need the sheet, so they run side by side.
    // TODO: start the image-to-3D + rig job here once we've picked a provider; until then glbUrl stays empty
    // and the game falls back to the stock fighter.
    job.step = "model";
    store.save();
    const card = await timed("card", () => editImage([{ data: sheet, type: "image/png" }], cardPrompt(job.brief), CARD_MODEL));
    job.cardUrl = store.write("card.png", card);

    job.status = "ready";
    delete job.step;
  } catch (err) {
    job.status = "failed";
    job.error = String(err.message ?? err);
  }
  store.save();
}
