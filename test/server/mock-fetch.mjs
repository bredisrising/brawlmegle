// Preloaded into the forge server by test/server/forge.test.ts (node --import): stands in for OpenAI and
// Tripo so the tests never spend credits. MOCK_DELAY_MS slows each OpenAI call; MOCK_CARD_FAIL=1 fails the card.
// A real 1x1 PNG, so the optimizer can make its WebP copies.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const delay = Number(process.env.MOCK_DELAY_MS ?? 0);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  throw new Error(`mock-fetch: unexpected ${url}`);
};
