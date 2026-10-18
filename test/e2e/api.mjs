// Forge API, called directly: usernames, fighters, bad ids, file requests and path traversal, and POSTs that
// must be rejected (4xx, never 5xx). Nothing here starts a real (paid) forge: every POST is invalid on purpose.
import { FORGE, FORGE_KEY, assert, done, http, note, test } from "./lib.mjs";

const api = (p) => `${FORGE}${p}`;
const is4xx = (r, what) => assert.ok(r.status >= 400 && r.status < 500, `${what}: expected 4xx, got ${r.status || r.error} ${r.text?.slice(0, 120) ?? ""}`);
const isJsonError = (r) => assert.ok(r.json && typeof r.json.error === "string", `expected a JSON {error}, got ${r.type} ${r.text?.slice(0, 80)}`);

let demo;

await test("profiles: demo has a ready fighter with a 3D model", async () => {
  const r = await http(api("/api/profiles/demo"));
  assert.equal(r.status, 200);
  assert.equal(r.json.username, "demo");
  demo = r.json.fighter;
  assert.ok(demo, "demo has no fighter");
  assert.equal(demo.status, "ready");
  assert.match(demo.glbUrl ?? "", /^https?:\/\/.+\.glb$/);
  note(`demo = ${demo.id}, ${r.ms} ms`);
});

await test("profiles: usernames are case- and space-insensitive", async () => {
  for (const u of ["DEMO", "Demo", "%20demo%20"]) {
    const r = await http(api(`/api/profiles/${u}`));
    assert.equal(r.status, 200, u);
    assert.equal(r.json.fighter?.id, demo?.id, u);
  }
});

await test("profiles: unknown username is 200 with fighter null", async () => {
  const r = await http(api(`/api/profiles/nobody-${Date.now()}`));
  assert.equal(r.status, 200);
  assert.equal(r.json.fighter, null);
});

await test("profiles: invalid usernames are 400 JSON", async () => {
  for (const u of ["a".repeat(25), "%3Cscript%3E", "a%2Fb", "%C3%A9t%C3%A9", "a%20b", "%00", "..", "%2E%2E"]) {
    const r = await http(api(`/api/profiles/${u}`));
    // ".." is a legal username by the regex (dots allowed), so it's a 200 with no fighter; everything else is 400.
    if (u === ".." || u === "%2E%2E") {
      assert.ok(r.status < 500, `${u}: ${r.status}`);
      continue;
    }
    assert.equal(r.status, 400, `${u}: ${r.status} ${r.text.slice(0, 80)}`);
    // nginx rejects some (e.g. %00) itself with an HTML page; the rest must be the forge's JSON error.
    if (!r.text.includes("nginx")) isJsonError(r);
  }
});

await test("profiles: malformed percent-encoding is 4xx, not 5xx", async () => {
  for (const u of ["%", "%E0%A4%A", "%FF", "%C0%AF", "%ED%A0%80"]) is4xx(await http(api(`/api/profiles/${u}`)), u);
}, { known: "E2E-05" });

await test("fighters: list is ready fighters with the fields the game needs", async () => {
  const r = await http(api("/api/fighters"));
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
  for (const f of r.json) {
    assert.equal(f.status, "ready", f.id);
    assert.ok(f.id && typeof f.name === "string", JSON.stringify(f).slice(0, 80));
  }
  note(`${r.json.length} fighters, ${r.ms} ms, ${r.text.length} bytes`);
});

await test("fighters: every card and 3D model URL resolves", async () => {
  const r = await http(api("/api/fighters"));
  for (const f of r.json) {
    for (const key of ["cardUrl", "glbUrl"]) {
      if (!f[key]) continue;
      const res = await fetch(f[key], { method: "GET", signal: AbortSignal.timeout(20_000) });
      await res.arrayBuffer();
      assert.equal(res.status, 200, `${f.name} ${key} ${f[key]}`);
    }
  }
});

await test("forge/:id: bad ids are 404 JSON", async () => {
  for (const id of ["nope", "__proto__", "constructor", "x".repeat(4000), "00000000-0000-0000-0000-000000000000"]) {
    const r = await http(api(`/api/forge/${id}`));
    assert.equal(r.status, 404, `${id.slice(0, 20)}: ${r.status}`);
    isJsonError(r);
  }
});

await test("forge/:id/file: unknown files and traversal never leak server files", async () => {
  const id = demo?.id ?? "nope";
  const attempts = [
    "fighter.json", "..%2Ffighter.json", "..%2F..%2Fserver.js", "%2e%2e%2f%2e%2e%2f%2e%2e%2f.env", "..%252F..%252F.env",
    "card.png%00.txt", "card.png/..", "rigged.glb%2F..%2F..%2F..%2F.env",
  ];
  for (const a of attempts) {
    const r = await http(api(`/api/forge/${id}/${a}`));
    assert.ok(r.status < 500, `${a}: ${r.status}`);
    assert.doesNotMatch(r.text, /OPENAI|TRIPO|sk-[A-Za-z0-9]{10}|import .* from|process\.env/, `${a} leaked something (${r.status} ${r.type})`);
  }
  for (const p of ["/api/forge/../../etc/passwd", "/api/..%2F..%2Fetc%2Fpasswd", "/api/forge/%2e%2e/%2e%2e/%2e%2e/etc/passwd"]) {
    const r = await http(api(p));
    assert.doesNotMatch(r.text, /root:x:0:0/, p);
  }
});

await test("forge/:id/file: raw scan photos are not public", async () => {
  // /api/fighters lists every id, so anyone can pull every player's raw camera photos by id.
  const r = await http(api("/api/fighters"));
  const open = [];
  for (const f of r.json) {
    for (const file of ["front.jpg", "front.png", "left.jpg", "left.png", "right.jpg", "right.png"]) {
      const res = await fetch(api(`/api/forge/${f.id}/${file}`), { signal: AbortSignal.timeout(20_000) });
      await res.arrayBuffer();
      if (res.status === 200) open.push(`${f.name}/${file}`);
    }
  }
  assert.deepEqual(open, [], `downloadable raw photos: ${open.join(", ")}`);
}, { known: "E2E-01" });

const post = (body, headers = {}) =>
  http(api("/api/forge"), { method: "POST", headers: { "content-type": "application/json", "x-forge-key": FORGE_KEY, ...headers }, body });

await test("POST /api/forge: no key / wrong key is 403", async () => {
  for (const key of [undefined, "nope", ""]) {
    const headers = { "content-type": "application/json" };
    if (key !== undefined) headers["x-forge-key"] = key;
    const r = await http(api("/api/forge"), { method: "POST", headers, body: '{"frames":[]}' });
    assert.equal(r.status, 403, `key ${JSON.stringify(key)}: ${r.status}`);
  }
});

await test("POST /api/forge: wrong content type is 415", async () => {
  const r = await http(api("/api/forge"), { method: "POST", headers: { "content-type": "text/plain", "x-forge-key": FORGE_KEY }, body: "{}" });
  assert.equal(r.status, 415);
});

await test("POST /api/forge: bad JSON and bad frames are 400", async () => {
  const bodies = ["{not json", "", '"x"', "42", "[]", "{}", '{"frames":[]}', '{"frames":"abc"}', '{"frames":[1,2]}', '{"frames":["aGVsbG8="]}', '{"frames":["a","b","c","d"]}', '{"frames":[null]}'];
  const bad = [];
  for (const b of bodies) {
    const r = await post(b);
    if (r.status !== 400) bad.push(`${b || "(empty)"} -> ${r.status || r.error} ${r.text?.slice(0, 60) ?? ""}`);
  }
  assert.deepEqual(bad, []);
});

await test("POST /api/forge: JSON null body is 4xx, not 5xx", async () => {
  is4xx(await post("null"), "null");
}, { known: "E2E-04" });

await test("POST /api/forge: oversized body is 413, not a crash", async () => {
  const big = `{"frames":["${"A".repeat(26 * 1024 * 1024)}"]}`;
  const r = await post(big);
  assert.equal(r.status, 413, `${r.status || r.error}`);
  // The server is still up afterwards.
  assert.equal((await http(api("/api/fighters"))).status, 200);
});

await test("POST /api/forge: 20 MB body (under the cap) of junk is 400", async () => {
  const r = await post(`{"frames":["${"A".repeat(20 * 1024 * 1024)}"]}`);
  assert.equal(r.status, 400, `${r.status || r.error} ${r.text?.slice(0, 80) ?? ""}`);
});

await test("CORS: other origins get no allow-origin header", async () => {
  const pre = await http(api("/api/forge"), { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
  assert.equal(pre.headers.get("access-control-allow-origin"), null);
  const get = await http(api("/api/fighters"), { headers: { origin: "https://evil.example" } });
  assert.equal(get.headers.get("access-control-allow-origin"), null);
  const ok = await http(api("/api/fighters"), { headers: { origin: FORGE } });
  assert.equal(ok.headers.get("access-control-allow-origin"), FORGE);
});

await test("other methods and paths are 4xx JSON", async () => {
  for (const [method, p] of [["PUT", "/api/forge"], ["DELETE", `/api/forge/${demo?.id}`], ["GET", "/api/"], ["GET", "/api/forge"], ["PATCH", "/api/fighters"]]) {
    const r = await http(api(p), { method });
    is4xx(r, `${method} ${p}`);
  }
  // The fighter survived the DELETE.
  assert.equal((await http(api(`/api/forge/${demo?.id}`))).status, 200);
});

await test("static: missing assets are 404, not index.html", async () => {
  const bad = [];
  for (const p of ["/assets/nope.js", "/favicon.ico", "/models/nope.glb"]) {
    const r = await http(api(p));
    if (r.status === 200 && r.type.includes("text/html")) bad.push(`${p} -> 200 text/html`);
  }
  assert.deepEqual(bad, []);
}, { known: "E2E-12" });

done("api");
