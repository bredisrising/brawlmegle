// Preloaded into the forge server by test/server/forge.test.ts (node --import): stands in for OpenAI and the GPU box
// so the tests never spend credits. MOCK_DELAY_MS slows each OpenAI call; MOCK_CARD_FAIL=1 fails the card.
// Rigged models are real tiny fighters (fixtures/rigFixtures.mjs), so the forge's rig check has something to check:
// MOCK_RIG=collapsed makes every rig a broken one (all weights on one spine bone), MOCK_RIG=collapsed-once only the
// first.
import fs from "node:fs";
// A real 1x1 PNG, so the optimizer can make its WebP copies.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const delay = Number(process.env.MOCK_DELAY_MS ?? 0);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let gpuPolls = 0;
let gpuHealth = 0;
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/rig-${name}.glb`, import.meta.url));
let rigs = 0;
/** The next rigged model any engine hands back. */
const rigged = () => {
  rigs++;
  const broken = process.env.MOCK_RIG === "collapsed" || (process.env.MOCK_RIG === "collapsed-once" && rigs === 1);
  return new Response(fixture(broken ? "collapsed" : "good"));
};

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith("https://api.openai.com/")) {
    await sleep(delay);
    if (url.endsWith("/chat/completions")) {
      const brief = { name: "Mock Menace", face: "x", distinctive: ["a"], build: "athletic", prop: "a mop", palette: [], scout_report: "y" };
      return json({ choices: [{ message: { content: JSON.stringify(brief) } }] });
    }
    if (url.endsWith("/images/edits")) {
      // The card: its own prompt (it can be the same image model as the sheet).
      if (process.env.MOCK_CARD_FAIL && /character select render/.test(String(init.body.get("prompt")))) {
        return json({ error: { message: "Your request was rejected by the safety system" } }, 400);
      }
      // The sheet streams (stream=true): one partial image, then the final one, like gpt-image-2.5-sunburst.
      // MOCK_STREAM=refuse answers it with a 400 like a model that can't stream.
      if (init.body.get("stream") === "true") {
        if (process.env.MOCK_STREAM === "refuse") return json({ error: { message: "stream is not supported for this model", param: "stream" } }, 400);
        const b64 = PNG.toString("base64");
        const sse = `event: image_edit.partial_image\ndata: ${JSON.stringify({ type: "image_edit.partial_image", partial_image_index: 0, b64_json: b64 })}\n\n` +
          `event: image_edit.completed\ndata: ${JSON.stringify({ type: "image_edit.completed", b64_json: b64 })}\n\n`;
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }
      return json({ data: [{ b64_json: PNG.toString("base64") }] });
    }
  }
  // The ZeroGPU Space (forge/gpu/zerogpu/app.py) through Gradio's API. MOCK_GRADIO=error fails the call.
  if (url.startsWith("https://gradio.mock/")) {
    if (new Headers(init.headers).get("authorization") !== "Bearer hf_x") return json({ error: "Repository not found" }, 404);
    if (url.endsWith("/gradio_api/call/forge3d")) return json({ event_id: "e1" });
    if (url.endsWith("/gradio_api/call/forge3d/e1")) {
      const stream =
        process.env.MOCK_GRADIO === "error"
          ? "event: error\ndata: null\n\n"
          : 'event: generating\ndata: [null, {"status": "model"}]\n\n' +
            'event: heartbeat\ndata: null\n\n' +
            'event: generating\ndata: [null, {"status": "rig"}]\n\n' +
            'event: complete\ndata: [{"path": "/tmp/x.glb", "url": "https://gradio.mock/gradio_api/file=/tmp/x.glb"}, {"status": "done", "timings": {"model": 20.5, "rig": 3.1}}]\n\n';
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.endsWith("/gradio_api/file=/tmp/x.glb")) return rigged();
  }
  // The GPU box (forge/gpu/server.py). MOCK_GPU=fail fails the job, MOCK_GPU=hang never finishes it.
  if (url.startsWith("http://gpu.mock/")) {
    // MOCK_GPU_HF=token: a private HF Space, which turns away any request without that bearer token.
    if (process.env.MOCK_GPU_HF && new Headers(init.headers).get("authorization") !== `Bearer ${process.env.MOCK_GPU_HF}`) {
      return json({ error: "Repository not found" }, 404);
    }
    if (url.endsWith("/health")) {
      // MOCK_GPU=asleep: a powered-off box (it never answers) for the first two looks, then up.
      if (process.env.MOCK_GPU === "asleep" && gpuHealth++ < 2) throw new TypeError("fetch failed");
      return json({ ok: true, ready: process.env.MOCK_GPU !== "cold", queued: 0 });
    }
    if (new Headers(init.headers).get("x-forge3d-key") !== "gpu-key") return json({ error: "bad key" }, 403);
    if (url.endsWith("/keepalive")) return json({ ok: true, ready: true });
    if (url.endsWith("/jobs")) return json({ id: "g1" }, 202);
    if (url.endsWith("/voxels.bin")) return new Response(Buffer.from([32, 0, 1, 2, 3]));
    if (url.endsWith("/shape.glb")) return new Response(Buffer.from("glTF-shape"));
    if (url.endsWith(".glb")) {
      const file = url.split("/").pop();
      if (file === "rigged.glb") return rigged();
      return new Response(Buffer.from({ "rigged.orig.glb": "glTF-local-orig" }[file] ?? "glTF-local"));
    }
    gpuPolls++;
    if (process.env.MOCK_GPU === "fail") return json({ status: "failed", error: "rig: blender exited 1" });
    if (process.env.MOCK_GPU === "hang") return json({ status: "model", timings: {} });
    // MOCK_GPU=previews: the box shows its voxels, then its shape, and sends an optimized GLB.
    const steps = process.env.MOCK_GPU === "previews" ? 5 : 3;
    const status = gpuPolls < steps - 1 ? "model" : gpuPolls < steps ? "rig" : "done";
    const previews = process.env.MOCK_GPU === "previews" ? { "voxels.bin": 1.2, ...(gpuPolls > 1 ? { "shape.glb": 4.1 } : {}) } : {};
    const optimized = process.env.MOCK_GPU === "previews" && status === "done";
    return json({ status, timings: { generate: 9.1, export: 3.2, model: 12.4, rig: 3.0 }, rigged: status === "done", previews, optimized });
  }
  throw new Error(`mock-fetch: unexpected ${url}`);
};
