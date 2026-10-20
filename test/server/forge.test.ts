// Runs the real forge server (forge/server.js) with OpenAI and the GPU box mocked out (mock-fetch.mjs), so these
// never spend credits.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const KEY = 'test-key';
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString('base64')}`;
const running: ChildProcess[] = [];
/** The rigged models the mocked engines hand back (test/server/fixtures/rigFixtures.mjs). */
const GOOD_RIG = fs.readFileSync(path.join(__dirname, 'fixtures/rig-good.glb'));
const COLLAPSED_RIG = fs.readFileSync(path.join(__dirname, 'fixtures/rig-collapsed.glb'));
const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer());
/** The rig checker needs the forge's own packages (cd forge && npm ci); without them the gate is skipped. */
/** The mocked GPU box (forge/gpu/server.py) every forge builds its model on, unless a test says otherwise. */
const GPU = { FORGE_3D: 'local', FORGE_3D_URL: 'http://gpu.mock', FORGE_3D_KEY: 'gpu-key' };
const hasRigCheck = fs.existsSync(path.join(ROOT, 'forge/node_modules/@gltf-transform/core'));

afterEach(() => {
  for (const child of running.splice(0)) child.kill();
});

async function startForge(env: Record<string, string> = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  const child = spawn(process.execPath, ['--import', path.join(__dirname, 'mock-fetch.mjs'), 'forge/server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...GPU, OPENAI_API_KEY: 'sk-test', FORGE_ACCESS_KEY: KEY, FORGE_PORT: String(port), FORGE_DATA: data, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d) => String(d).includes('forge on') && resolve());
    child.once('exit', (code) => reject(new Error(`forge exited ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const forge = (body: unknown) =>
    fetch(`${base}/api/forge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forge-key': KEY }, body: JSON.stringify(body) });
  const until = async (id: string, done: (f: Record<string, unknown>) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const f = (await (await fetch(`${base}/api/forge/${id}`)).json()) as Record<string, unknown>;
      if (done(f)) return f;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('forge never finished');
  };
  /** A forge request whose body trickles in over `ms`, like a 3-photo upload on venue Wi-Fi. */
  const slowForge = (ms: number) =>
    new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ name: 'A', frames: [JPEG] });
      const req = http.request(`${base}/api/forge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forge-key': KEY } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.write(body.slice(0, 10));
      setTimeout(() => req.end(body.slice(10)), ms);
    });
  return { base, data, forge, slowForge, until };
}

describe('forge server', () => {
  it('never serves the raw scan photos', async () => {
    const { base, forge, until } = await startForge();
    const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
    const f = await until(id, (x) => x.status !== 'scanning' && x.status !== 'forging');
    expect(f.status).toBe('ready');
    expect((await fetch(`${base}/api/forge/${id}/sheet.png`)).status).toBe(200);
    expect((await fetch(`${base}/api/forge/${id}/front.jpg`)).status).toBe(404);
  });

  it.skipIf(!fs.existsSync(path.join(ROOT, 'forge/node_modules/sharp')))('sends browsers the WebP copies of the card and sheet', async () => {
    const { base, forge, until } = await startForge();
    const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
    const f = await until(id, (x) => x.status !== 'scanning' && x.status !== 'forging');
    expect(f.cardUrl).toMatch(/card\.webp$/);
    expect(f.sheetUrl).toMatch(/sheet\.webp$/);
    const card = await fetch(String(f.cardUrl).replace(/^https?:\/\/[^/]+/, base));
    expect(card.headers.get('content-type')).toBe('image/webp');
    expect((await fetch(`${base}/api/forge/${id}/card.png`)).status).toBe(200); // the original stays
    expect((await fetch(`${base}/api/forge/${id}/rigged.orig.glb`)).status).toBe(404); // backups aren't served
  });

  it('a failed card keeps the fighter (and its 3D model)', async () => {
    const { forge, until } = await startForge({ MOCK_CARD_FAIL: '1' });
    const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
    const f = await until(id, (x) => x.status !== 'scanning' && x.status !== 'forging');
    expect(f.status).toBe('ready');
    expect(f.glbUrl).toMatch(/rigged\.glb(\?v=\d+)?$/);
    expect(f.cardUrl).toBeUndefined();
    expect(String(f.cardError)).toMatch(/safety/);
  });

  it('parallel requests cannot get past the active-forge cap', async () => {
    const { slowForge } = await startForge({ FORGE_MAX_ACTIVE: '1', MOCK_DELAY_MS: '2000' });
    const statuses = await Promise.all([1, 2, 3, 4].map(() => slowForge(300)));
    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
  });

  it('an upload cut off halfway gives its slot back', async () => {
    const { base, forge } = await startForge({ FORGE_MAX_ACTIVE: '1' });
    const req = http.request(`${base}/api/forge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forge-key': KEY } });
    req.on('error', () => {});
    req.write('{"frames": ["');
    await new Promise((r) => setTimeout(r, 200));
    req.destroy();
    await new Promise((r) => setTimeout(r, 200));
    expect((await forge({ name: 'A', frames: [JPEG] })).status).toBe(202);
  });

  it('streams the sheet: a partial image shows while it draws', async () => {
    const { forge, until } = await startForge();
    const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
    const f = await until(id, (x) => x.status === 'ready' && Boolean(x.sheetPartialUrl));
    expect(f.sheetPartialUrl).toMatch(/sheet-partial-1\.webp$/);
    expect((await fetch(String(f.sheetPartialUrl))).status).toBe(200);
  });

  it('draws the sheet the plain way when the model refuses to stream', async () => {
    const { forge, until } = await startForge({ MOCK_STREAM: 'refuse' });
    const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
    const f = await until(id, (x) => x.status !== 'scanning' && x.status !== 'forging');
    expect(f.status).toBe('ready');
    expect(f.sheetUrl).toBeTruthy();
    expect(f.sheetPartialUrl).toBeUndefined();
  });

  describe('FORGE_3D=local (the GPU box)', () => {
    const gpu = GPU;
    const done = (x: Record<string, unknown>) => x.status !== 'scanning' && x.status !== 'forging';

    it("relays the box's previews and keeps its optimized GLB as it is", async () => {
      const { base, data, forge, until } = await startForge({ ...gpu, MOCK_GPU: 'previews' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(f.engine3d).toBe('local');
      expect(f.previewVoxelsUrl).toMatch(/preview-voxels\.bin$/);
      expect(f.previewMeshUrl).toMatch(/preview-shape\.glb$/);
      expect([...new Uint8Array(await (await fetch(String(f.previewVoxelsUrl))).arrayBuffer())]).toEqual([32, 0, 1, 2, 3]);
      expect(f.glbOptimized).toBe(true);
      expect((await bytes(await fetch(`${base}/api/forge/${id}/rigged.glb`))).equals(GOOD_RIG)).toBe(true);
      // The unoptimized original follows in the background, after the fighter is ready.
      for (let i = 0; i < 40 && !fs.existsSync(path.join(data, id, 'rigged.orig.glb')); i++) await new Promise((r) => setTimeout(r, 50));
      expect(fs.readFileSync(path.join(data, id, 'rigged.orig.glb'), 'utf8')).toBe('glTF-local-orig');
    });

    it('builds the rigged model on the GPU box', async () => {
      const { base, forge, until } = await startForge(gpu);
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(f.status).toBe('ready');
      expect(f.engine3d).toBe('local');
      expect(f.rigged).toBe(true);
      expect(f.glbUrl).toMatch(/rigged\.glb(\?v=\d+)?$/);
      expect((await bytes(await fetch(`${base}/api/forge/${id}/rigged.glb`))).equals(GOOD_RIG)).toBe(true);
      expect(await (await fetch(`${base}/api/forge/${id}/model.glb`)).text()).toBe('glTF-local');
    });

    // No other engine to fall back on: the fighter ships with its card and no 3D model (the game's default body).
    it('a failed GPU job: the fighter is ready without a model, and says why', async () => {
      const { forge, until } = await startForge({ ...gpu, MOCK_GPU: 'fail' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(f.status).toBe('ready');
      expect(String(f.modelError)).toMatch(/blender/);
      expect(f.glbUrl).toBeUndefined();
    });

    it('a GPU job that takes too long is given up on', async () => {
      const { forge, until } = await startForge({ ...gpu, MOCK_GPU: 'hang', FORGE_3D_TIMEOUT: '1' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(String(f.modelError)).toMatch(/timed out/);
      expect(f.glbUrl).toBeUndefined();
    });

    it('sends the HF token to a private Space', async () => {
      const { forge, until } = await startForge({ ...gpu, MOCK_GPU_HF: 'hf_x', FORGE_3D_HF_TOKEN: 'hf_x' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      expect((await until(id, done)).engine3d).toBe('local');
    });

    it('a box still warming up when the wait runs out: no model', async () => {
      const { forge, until } = await startForge({ ...gpu, MOCK_GPU: 'cold', FORGE_3D_WARMUP_WAIT: '0' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(String(f.modelError)).toMatch(/not ready/);
    });

    it('a wrong GPU key: no model', async () => {
      const { forge, until } = await startForge({ ...gpu, FORGE_3D_KEY: 'nope' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(String(f.modelError)).toMatch(/403/);
    });
  });

  describe('FORGE_3D=gradio (the ZeroGPU Space)', () => {
    const space = { FORGE_3D: 'gradio', FORGE_3D_URL: 'https://gradio.mock', FORGE_3D_KEY: 'gpu-key', FORGE_3D_HF_TOKEN: 'hf_x' };
    const done = (x: Record<string, unknown>) => x.status !== 'scanning' && x.status !== 'forging';

    it('builds the rigged model on the Space', async () => {
      const { base, forge, until } = await startForge(space);
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(f.engine3d).toBe('gradio');
      expect(f.rigged).toBe(true);
      expect(f.modelUrl).toBe(f.glbUrl);
      expect(f.gpuTimings).toEqual({ model: 20.5, rig: 3.1 });
      expect((await bytes(await fetch(`${base}/api/forge/${id}/rigged.glb`))).equals(GOOD_RIG)).toBe(true);
    });

    it('a Space that errors: no model', async () => {
      const { forge, until } = await startForge({ ...space, MOCK_GRADIO: 'error' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(String(f.modelError)).toMatch(/GPU Space/);
    });
  });

  describe.skipIf(!hasRigCheck)('the rig check gate', () => {
    const gpu = GPU;
    const done = (x: Record<string, unknown>) => x.status !== 'scanning' && x.status !== 'forging';
    type RigCheck = { ok: boolean; score: number; engine: string; problems?: string[]; attempts?: { engine: string; ok: boolean; error?: string }[] };

    it('checks every rig and records it', async () => {
      const { data, forge, until } = await startForge(gpu);
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      const check = f.rigCheck as RigCheck;
      expect(check.ok).toBe(true);
      expect(check.engine).toBe('local');
      expect(check.score).toBeGreaterThan(50);
      expect(check.attempts).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(path.join(data, id, 'fighter.json'), 'utf8')).rigCheck.ok).toBe(true);
    });

    it('a rig that fails the check is re-rigged on the GPU box, and the good one ships', async () => {
      const { base, data, forge, until } = await startForge({ ...gpu, MOCK_RIG: 'collapsed-once' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(f.status).toBe('ready');
      const check = f.rigCheck as RigCheck;
      expect(check.ok).toBe(true);
      expect(check.attempts!.map((a) => [a.engine, a.ok])).toEqual([['local', false], ['local', true]]);
      expect(f.rigEngine).toBe('local');
      expect(f.glbUrl).toMatch(/rigged\.glb(\?v=\d+)?$/);
      expect((await bytes(await fetch(`${base}/api/forge/${id}/rigged.glb`))).equals(GOOD_RIG)).toBe(true);
      // The rejected rig is kept for a look, never served.
      expect(fs.readFileSync(path.join(data, id, 'rigged.rejected.glb')).equals(COLLAPSED_RIG)).toBe(true);
      expect((await fetch(`${base}/api/forge/${id}/rigged.rejected.glb`)).status).toBe(404);
    });

    it('a rig that keeps failing never ships: no glbUrl, so the game uses the default body', async () => {
      const { base, forge, until } = await startForge({ ...gpu, MOCK_RIG: 'collapsed' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(f.status).toBe('ready');
      expect(f.glbUrl).toBeUndefined();
      expect(f.rigged).toBe(false);
      const check = f.rigCheck as RigCheck;
      expect(check.ok).toBe(false);
      // The GPU's rig, then its re-rig another way.
      expect(check.attempts!.map((a) => [a.engine, a.ok])).toEqual([['local', false], ['local', false]]);
      // Still on the memory card (with its card art); the broken GLB isn't reachable.
      const list = (await (await fetch(`${base}/api/fighters`)).json()) as { id: string }[];
      expect(list.map((x) => x.id)).toContain(id);
      expect((await fetch(`${base}/api/forge/${id}/rigged.glb`)).status).toBe(404);
    });
  });

  it('a powered-off GPU box: the forge asks for it, waits while it starts, then builds on it', async () => {
    const waker = 'waker-secret';
    const { base, forge, until } = await startForge({
      FORGE_3D: 'local', FORGE_3D_URL: 'http://gpu.mock', FORGE_3D_KEY: 'gpu-key', MOCK_GPU: 'asleep', FORGE_3D_WARMUP_POLL: '50', FORGE_GPU_WAKER_KEY: waker,
    });
    const wanted = async (key = waker) => {
      const res = await fetch(`${base}/api/gpu/wanted`, { headers: { 'x-waker-key': key } });
      return res.ok ? ((await res.json()) as { wanted: boolean }).wanted : res.status;
    };
    expect(await wanted('nope')).toBe(403);
    expect(await wanted()).toBe(false);
    // Opening the scan is the cue: bingus's waker starts the box from here.
    expect((await fetch(`${base}/api/capacity`)).ok).toBe(true);
    expect(await wanted()).toBe(true);
    const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
    const f = await until(id, (x) => x.status !== 'scanning' && x.status !== 'forging');
    expect(f.status).toBe('ready');
  });

  it('answers a JSON null body with 400, not 500', async () => {
    const { forge } = await startForge();
    expect((await forge(null)).status).toBe(400);
  });
});
