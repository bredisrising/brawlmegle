// Preloaded into the forge server by test/server/forge.test.ts (node --import): stands in for OpenAI and
// Tripo so the tests never spend credits. MOCK_DELAY_MS slows each OpenAI call; MOCK_CARD_FAIL=1 fails the card.
// A real 1x1 PNG, so the optimizer can make its WebP copies.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
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
  if (url.startsWith("https://openapi.tripo3d.ai/")) {
    if (url.endsWith("/files")) return json({ code: 0, data: { file_token: "tok" } });
    if (url.includes("/tasks/")) return json({ code: 0, data: { status: "success", output: { model_url: "https://tripo.mock/m.glb" } } });
    return json({ code: 0, data: { task_id: "task" } });
  }
  if (url.startsWith("https://tripo.mock/")) return new Response(Buffer.from("glTF"));
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
    if (url.endsWith("/gradio_api/file=/tmp/x.glb")) return new Response(Buffer.from("glTF-gradio-rigged"));
  }
  // The GPU box (forge/gpu/server.py). MOCK_GPU=fail fails the job, MOCK_GPU=hang never finishes it.
  if (url.startsWith("http://gpu.mock/")) {
    // MOCK_GPU_HF=token: a private HF Space, which turns away any request without that bearer token.
    if (process.env.MOCK_GPU_HF && new Headers(init.headers).get("authorization") !== `Bearer ${process.env.MOCK_GPU_HF}`) {
      return json({ error: "Repository not found" }, 404);
    }
    if (url.endsWith("/health")) return json({ ok: true, ready: process.env.MOCK_GPU !== "cold", queued: 0 });
    if (new Headers(init.headers).get("x-forge3d-key") !== "gpu-key") return json({ error: "bad key" }, 403);
    if (url.endsWith("/jobs")) return json({ id: "g1" }, 202);
    if (url.endsWith("/voxels.bin")) return new Response(Buffer.from([32, 0, 1, 2, 3]));
    if (url.endsWith("/shape.glb")) return new Response(Buffer.from("glTF-shape"));
    if (url.endsWith(".glb")) {
      const file = url.split("/").pop();
      return new Response(Buffer.from({ "rigged.glb": "glTF-local-rigged", "rigged.orig.glb": "glTF-local-orig" }[file] ?? "glTF-local"));
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
