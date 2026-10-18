// Runs the real forge server (forge/server.js) with OpenAI and Tripo mocked out (mock-fetch.mjs), so these never
// spend credits.
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

afterEach(() => {
  for (const child of running.splice(0)) child.kill();
});

async function startForge(env: Record<string, string> = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
  const child = spawn(process.execPath, ['--import', path.join(__dirname, 'mock-fetch.mjs'), 'forge/server.js'], {
    cwd: ROOT,
    env: { ...process.env, OPENAI_API_KEY: 'sk-test', TRIPO_API_KEY: 'tripo-test', FORGE_ACCESS_KEY: KEY, FORGE_PORT: String(port), FORGE_DATA: data, ...env },
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
    expect(f.glbUrl).toMatch(/rigged\.glb$/);
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

  describe('FORGE_3D=local (the GPU box)', () => {
    const gpu = { FORGE_3D: 'local', FORGE_3D_URL: 'http://gpu.mock', FORGE_3D_KEY: 'gpu-key' };
    const done = (x: Record<string, unknown>) => x.status !== 'scanning' && x.status !== 'forging';

    it('builds the rigged model on the GPU box, not Tripo', async () => {
      const { base, forge, until } = await startForge(gpu);
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(f.status).toBe('ready');
      expect(f.engine3d).toBe('local');
      expect(f.rigged).toBe(true);
      expect(f.glbUrl).toMatch(/rigged\.glb$/);
      expect(await (await fetch(`${base}/api/forge/${id}/rigged.glb`)).text()).toBe('glTF-local-rigged');
      expect(await (await fetch(`${base}/api/forge/${id}/model.glb`)).text()).toBe('glTF-local');
    });

    it('falls back to Tripo when the GPU job fails', async () => {
      const { forge, until } = await startForge({ ...gpu, MOCK_GPU: 'fail' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(f.status).toBe('ready');
      expect(f.engine3d).toBe('tripo');
      expect(String(f.localError)).toMatch(/blender/);
      expect(f.glbUrl).toMatch(/rigged\.glb$/);
    });

    it('falls back to Tripo when the GPU job takes too long', async () => {
      const { forge, until } = await startForge({ ...gpu, MOCK_GPU: 'hang', FORGE_3D_TIMEOUT: '1' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(f.engine3d).toBe('tripo');
      expect(String(f.localError)).toMatch(/timed out/);
      expect(f.glbUrl).toMatch(/rigged\.glb$/);
    });

    it('sends the HF token to a private Space', async () => {
      const { forge, until } = await startForge({ ...gpu, MOCK_GPU_HF: 'hf_x', FORGE_3D_HF_TOKEN: 'hf_x' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      expect((await until(id, done)).engine3d).toBe('local');
    });

    it('a box that is still warming up falls back to Tripo right away', async () => {
      const { forge, until } = await startForge({ ...gpu, MOCK_GPU: 'cold' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(f.engine3d).toBe('tripo');
      expect(String(f.localError)).toMatch(/not ready/);
    });

    it('a wrong GPU key falls back to Tripo too', async () => {
      const { forge, until } = await startForge({ ...gpu, FORGE_3D_KEY: 'nope' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(f.engine3d).toBe('tripo');
      expect(String(f.localError)).toMatch(/403/);
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
      expect(await (await fetch(`${base}/api/forge/${id}/rigged.glb`)).text()).toBe('glTF-gradio-rigged');
    });

    it('falls back to Tripo when the Space errors', async () => {
      const { forge, until } = await startForge({ ...space, MOCK_GRADIO: 'error' });
      const { id } = (await (await forge({ name: 'A', frames: [JPEG] })).json()) as { id: string };
      const f = await until(id, done);
      expect(f.engine3d).toBe('tripo');
      expect(String(f.localError)).toMatch(/GPU Space/);
    });
  });

  it('answers a JSON null body with 400, not 500', async () => {
    const { forge } = await startForge();
    expect((await forge(null)).status).toBe(400);
  });
});
