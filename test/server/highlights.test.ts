// The forge server's highlights (K.O. replay clips for the title screen's reel): the real forge/server.js, with
// OpenAI and Tripo mocked out (mock-fetch.mjs) like forge.test.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const KEY = 'test-key';
const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill();
});

/** A WebM-looking body: the EBML magic, then filler. */
const webm = (bytes = 4096) => {
  const b = Buffer.alloc(bytes, 7);
  b.writeUInt32BE(0x1a45dfa3, 0);
  return b;
};

const META = {
  p1: { id: 'a6535b14-7e5d-4b33-9685-765e2df703da', name: 'Rico' },
  p2: { id: 'cpu', name: 'Dylan', cpu: true },
  winner: 'p1',
  move: 'uppercut',
  combo: 5,
  roundTime: 23.4,
  duration: 6.8,
};

async function startForge(env: Record<string, string> = {}, data = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hl-'))) {
  const port = 20000 + Math.floor(Math.random() * 20000);
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
  const upload = (body: Buffer = webm(), meta: unknown = META, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/highlights`, {
      method: 'POST',
      headers: { 'content-type': 'video/webm;codecs=vp9', 'x-forge-key': KEY, 'x-highlight-meta': encodeURIComponent(JSON.stringify(meta)), ...headers },
      body: new Uint8Array(body),
    });
  const list = async () => ((await (await fetch(`${base}/api/highlights`)).json()) as { highlights: Record<string, unknown>[] }).highlights;
  /** A clip's URL on this server (the list hands out absolute URLs). */
  const local = (url: unknown) => String(url).replace(/^https?:\/\/[^/]+/, base);
  return { base, data, upload, list, local };
}

describe('highlights', () => {
  it('stores a clip with its metadata and lists the newest first', async () => {
    const { upload, list, local } = await startForge();
    expect(await list()).toEqual([]);
    const first = await upload();
    expect(first.status).toBe(201);
    const second = await upload(webm(), { ...META, winner: 'p2', move: 'fireball', combo: 1, p1: { name: 'Zoë 🥊' } });
    expect(second.status).toBe(201);
    const all = await list();
    expect(all.map((h) => h.move)).toEqual(['fireball', 'uppercut']);
    expect(all[1]).toMatchObject({ winner: 'p1', combo: 5, roundTime: 23.4, duration: 6.8, bytes: 4096, p1: { name: 'Rico', id: META.p1.id }, p2: { name: 'Dylan', cpu: true } });
    expect(all[0].p1).toEqual({ name: 'Zoë 🥊', cpu: false });
    expect(typeof all[0].createdAt).toBe('number');
    expect(all[0]).not.toHaveProperty('file');

    const clip = await fetch(local(all[1].url));
    expect(clip.status).toBe(200);
    expect(clip.headers.get('content-type')).toBe('video/webm');
    expect(clip.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await clip.arrayBuffer()).equals(webm())).toBe(true);
  });

  it('answers byte ranges, as <video> asks for them', async () => {
    const { upload, local } = await startForge();
    const h = (await (await upload()).json()) as { url: string };
    const part = await fetch(local(h.url), { headers: { range: 'bytes=0-3' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 0-3/4096');
    expect(Buffer.from(await part.arrayBuffer()).readUInt32BE(0)).toBe(0x1a45dfa3);
    expect((await fetch(local(h.url), { headers: { range: 'bytes=5000-' } })).status).toBe(416);
  });

  it('refuses uploads without the key, of the wrong type, or too big', async () => {
    const { upload, list } = await startForge({ FORGE_HIGHLIGHT_MAX_BYTES: '10000' });
    expect((await upload(webm(), META, { 'x-forge-key': 'nope' })).status).toBe(403);
    expect((await upload(webm(), META, { 'content-type': 'image/png' })).status).toBe(415);
    expect((await upload(webm(20_000))).status).toBe(413);
    // Says it's WebM but isn't.
    expect((await upload(Buffer.alloc(4096, 1))).status).toBe(400);
    expect(await list()).toEqual([]);
  });

  it('validates the metadata', async () => {
    const { upload, list } = await startForge();
    const bad = [
      { ...META, winner: 'p3' },
      { ...META, p1: { name: '' } },
      { ...META, p2: undefined },
      { ...META, move: '<script>' },
      { ...META, combo: 0 },
      { ...META, combo: 2.5 },
      { ...META, roundTime: -1 },
      { ...META, duration: 120 },
    ];
    for (const meta of bad) expect((await upload(webm(), meta)).status, JSON.stringify(meta)).toBe(400);
    expect((await upload(webm(), META, { 'x-highlight-meta': '%E0%A4%A' })).status).toBe(400);
    // Long names are cut, control characters dropped, unknown fields not kept, a bad id left out.
    const res = await upload(webm(), { ...META, p1: { name: `A\u0000B${'x'.repeat(80)}`, id: '../../etc' }, extra: 'nope' });
    expect(res.status).toBe(201);
    const [h] = await list();
    expect(h.p1).toEqual({ name: `A B${'x'.repeat(37)}`, cpu: false });
    expect(h).not.toHaveProperty('extra');
  });

  it('keeps only the newest clips, and deletes the rest', async () => {
    const { upload, list, data, local } = await startForge({ FORGE_HIGHLIGHT_KEEP: '3' });
    const urls: string[] = [];
    for (let i = 0; i < 4; i++) urls.push(((await (await upload(webm(), { ...META, combo: i + 1 })).json()) as { url: string }).url);
    const all = await list();
    expect(all.map((h) => h.combo)).toEqual([4, 3, 2]);
    expect((await fetch(local(urls[0]))).status).toBe(404);
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.readdirSync(path.join(data, 'highlights')).filter((f) => f.endsWith('.webm'))).toHaveLength(3);
  });

  it('rate-limits uploads', async () => {
    const { upload } = await startForge({ FORGE_MAX_HIGHLIGHTS: '2' });
    expect((await upload()).status).toBe(201);
    expect((await upload()).status).toBe(201);
    expect((await upload()).status).toBe(429);
  });

  it('keeps highlights across a restart', async () => {
    const first = await startForge();
    expect((await first.upload()).status).toBe(201);
    await new Promise((r) => setTimeout(r, 100));
    for (const child of running.splice(0)) child.kill();
    const again = await startForge({}, first.data);
    const all = await again.list();
    expect(all).toHaveLength(1);
    expect((await fetch(again.local(all[0].url))).status).toBe(200);
  });

  it('lets the game page send the metadata header cross-origin', async () => {
    const { base } = await startForge();
    const res = await fetch(`${base}/api/highlights`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-forge-key, x-highlight-meta' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('x-highlight-meta');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});
