// Preloaded into the forge server by test/server/forge.test.ts (node --import): stands in for OpenAI and
// Tripo so the tests never spend credits. MOCK_DELAY_MS slows each OpenAI call; MOCK_CARD_FAIL=1 fails the card.
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const delay = Number(process.env.MOCK_DELAY_MS ?? 0);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let gpuPolls = 0;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith("https://api.openai.com/")) {
    await sleep(delay);
    if (url.endsWith("/chat/completions")) {
      const brief = { name: "Mock Menace", face: "x", distinctive: ["a"], build: "athletic", prop: "a mop", palette: [], scout_report: "y" };
      return json({ choices: [{ message: { content: JSON.stringify(brief) } }] });
    }
    if (url.endsWith("/images/edits")) {
      const model = init.body.get("model");
      if (process.env.MOCK_CARD_FAIL && model === (process.env.FORGE_CARD_MODEL ?? "gpt-image-2.5-flare")) {
        return json({ error: { message: "Your request was rejected by the safety system" } }, 400);
      }
      return json({ data: [{ b64_json: PNG.toString("base64") }] });
    }
  }
  if (url.startsWith("https://openapi.tripo3d.ai/")) {
    if (url.endsWith("/files")) return json({ code: 0, data: { file_token: "tok" } });
    if (url.includes("/tasks/")) return json({ code: 0, data: { status: "success", output: { model_url: "https://tripo.mock/m.glb" } } });
    return json({ code: 0, data: { task_id: "task" } });
  }
  if (url.startsWith("https://tripo.mock/")) return new Response(Buffer.from("glTF"));
  // The GPU box (forge/gpu/server.py). MOCK_GPU=fail fails the job, MOCK_GPU=hang never finishes it.
  if (url.startsWith("http://gpu.mock/")) {
    if (url.endsWith("/health")) return json({ ok: true, ready: process.env.MOCK_GPU !== "cold", queued: 0 });
    if (new Headers(init.headers).get("x-forge3d-key") !== "gpu-key") return json({ error: "bad key" }, 403);
    if (url.endsWith("/jobs")) return json({ id: "g1" }, 202);
    if (url.endsWith(".glb")) return new Response(Buffer.from(url.endsWith("/rigged.glb") ? "glTF-local-rigged" : "glTF-local"));
    gpuPolls++;
    if (process.env.MOCK_GPU === "fail") return json({ status: "failed", error: "rig: blender exited 1" });
    if (process.env.MOCK_GPU === "hang") return json({ status: "model", timings: {} });
    const status = gpuPolls < 2 ? "model" : gpuPolls < 3 ? "rig" : "done";
    return json({ status, timings: { generate: 9.1, export: 3.2, model: 12.4, rig: 3.0 }, rigged: status === "done" });
  }
  throw new Error(`mock-fetch: unexpected ${url}`);
};
