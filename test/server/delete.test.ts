// "Delete my fighter": the real forge/server.js (OpenAI and the GPU box mocked, mock-fetch.mjs) hands out an owner key and a
// delete code once per forge, keeps only their hashes, and deletes a fighter for good with either: its folder, its
// record, its highlights and its memory-card entry. Also the admin script (forge/delete-fighter.mjs).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const KEY = 'test-key';
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString('base64')}`;
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill();
});

function seed(data: string, f: Record<string, unknown>, files: string[] = []) {
  const dir = path.join(data, String(f.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fighter.json'), JSON.stringify({ status: 'ready', timings: {}, ...f }));
  for (const file of files) fs.writeFileSync(path.join(dir, file), 'x');
}

const webm = () => {
  const b = Buffer.alloc(2048, 7);
  b.writeUInt32BE(0x1a45dfa3, 0);
  return new Uint8Array(b);
};

async function startForge(env: Record<string, string> = {}, data = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-del-'))) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--import', path.join(__dirname, 'mock-fetch.mjs'), 'forge/server.js'], {
    cwd: ROOT,
    env: { ...process.env, OPENAI_API_KEY: 'sk-test', FORGE_ACCESS_KEY: KEY, FORGE_PORT: String(port), FORGE_DATA: data, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  let log = '';
  child.stdout!.on('data', (d) => (log += String(d)));
  child.stderr!.on('data', (d) => (log += String(d)));
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d) => String(d).includes('forge on') && resolve());
    child.once('exit', (code) => reject(new Error(`forge exited ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (url: string, body: unknown) =>
    fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forge-key': KEY }, body: JSON.stringify(body) });
  const forge = async (body: Record<string, unknown> = {}) => {
    const res = await post('/api/forge', { name: 'A', frames: [JPEG], ...body });
    expect(res.status).toBe(202);
    const created = (await res.json()) as { id: string; ownerKey: string; deleteCode: string };
    for (let i = 0; i < 100; i++) {
      const f = (await (await fetch(`${base}/api/forge/${created.id}`)).json()) as { status: string };
      if (f.status === 'ready' || f.status === 'failed') return created;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('forge never finished');
  };
  const del = (id: string, key: unknown) => post(`/api/fighters/${id}/delete`, { key });
  const delCode = (code: unknown) => post('/api/fighters/delete', { code });
  const list = async () => ((await (await fetch(`${base}/api/fighters`)).json()) as { id: string }[]).map((f) => f.id);
  const records = async () => ((await (await fetch(`${base}/api/records`)).json()) as { records: Record<string, { wins: number }> }).records;
  const highlights = async () => ((await (await fetch(`${base}/api/highlights`)).json()) as { highlights: { p1: { id?: string } }[] }).highlights;
  const upload = (p1: { id?: string; name: string }) =>
    fetch(`${base}/api/highlights`, {
      method: 'POST',
      headers: {
        'content-type': 'video/webm',
        'x-forge-key': KEY,
        'x-highlight-meta': encodeURIComponent(JSON.stringify({ p1, p2: { name: 'Dylan' }, winner: 'p1', move: 'uppercut', combo: 1, roundTime: 10, duration: 5 })),
      },
      body: webm(),
    });
  return { base, data, post, forge, del, delCode, list, records, highlights, upload, log: () => log };
}

describe('delete my fighter', () => {
  it('issues the owner key and delete code once, and keeps only their hashes', async () => {
    const s = await startForge();
    const { id, ownerKey, deleteCode } = await s.forge({ username: 'rico' });
    expect(Buffer.from(ownerKey, 'base64url')).toHaveLength(32);
    expect(deleteCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);

    const stored = fs.readFileSync(path.join(s.data, id, 'fighter.json'), 'utf8');
    const saved = JSON.parse(stored) as Record<string, unknown>;
    expect(saved.ownerKeyHash).toBe(sha256(ownerKey));
    expect(saved.deleteCodeHash).toBe(sha256(deleteCode.replace(/-/g, '')));
    expect(stored).not.toContain(ownerKey);
    expect(stored).not.toContain(deleteCode.replace(/-/g, ''));

    // Never handed out again, and never the hashes either.
    for (const url of [`/api/forge/${id}`, '/api/fighters', '/api/profiles/rico']) {
      const text = await (await fetch(`${s.base}${url}`)).text();
      expect(text, url).toContain(id);
      for (const secret of [ownerKey, deleteCode, sha256(ownerKey), 'ownerKeyHash', 'deleteCodeHash']) expect(text, url).not.toContain(secret);
    }
    expect(s.log()).not.toContain(ownerKey);
    expect(s.log()).not.toContain(deleteCode);

    // Two forges, two different keys.
    const other = await s.forge();
    expect(other.ownerKey).not.toBe(ownerKey);
    expect(other.deleteCode).not.toBe(deleteCode);
  });

  it('refuses a wrong key and leaves everything in place', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-del-'));
    seed(data, { id: 'old-one', name: 'old', createdAt: 1 }, ['front.jpg']);
    const s = await startForge({}, data);
    const { id, ownerKey } = await s.forge();
    const other = await s.forge();
    for (const key of ['nope', '', null, 42, other.ownerKey, ownerKey.slice(0, -1)]) expect((await s.del(id, key)).status, String(key)).toBe(403);
    expect(fs.existsSync(path.join(s.data, id, 'front.jpg'))).toBe(true);
    expect(await s.list()).toContain(id);
    // A fighter from before owner keys can't be deleted from the browser at all (delete-fighter.mjs does those).
    for (const key of ['', 'x', ownerKey]) expect((await s.del('old-one', key)).status).toBe(403);
    expect(fs.existsSync(path.join(data, 'old-one', 'front.jpg'))).toBe(true);
    // Without the forge's access key, nothing.
    const res = await fetch(`${s.base}/api/fighters/${id}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: ownerKey }) });
    expect(res.status).toBe(403);
  });

  it('deletes the files, record, highlights and memory-card entry, and the previous fighter is current again', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-del-'));
    seed(data, { id: 'p-old', name: 'phoenix', username: 'phoenix', createdAt: 1 }, ['front.jpg', 'card.png']);
    fs.writeFileSync(path.join(data, 'records.json'), JSON.stringify({ 'p-old': { wins: 2, losses: 1, draws: 0, streak: 0, bestStreak: 2 } }));
    const s = await startForge({}, data);
    const { id, ownerKey } = await s.forge({ name: 'phoenix', username: 'phoenix' });
    expect(await s.list()).toEqual([id]); // the rescan replaced the old one on the memory card
    // Backups and extras the rescue scripts leave behind go too.
    for (const file of ['rigged.glb.pre-rescue', 'card.png.pre-face', 'rigged.orig.glb']) fs.writeFileSync(path.join(data, id, file), 'x');
    expect(fs.readdirSync(path.join(data, id))).toContain('front.jpg');

    // A record and two highlights for the new fighter, one for someone else.
    expect((await s.post('/api/matches', { matchId: 'm1', p1: id, p2: 'p-old', winner: 'p1' })).status).toBe(200);
    expect((await s.upload({ id, name: 'phoenix' })).status).toBe(201);
    expect((await s.upload({ id, name: 'phoenix' })).status).toBe(201);
    expect((await s.upload({ name: 'dylan' })).status).toBe(201);
    expect((await s.records())[id]).toBeDefined();
    const before = fs.readdirSync(path.join(data, 'highlights')).filter((f) => f.endsWith('.webm'));
    expect(before).toHaveLength(3);

    const res = await s.del(id, ownerKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id, name: 'phoenix' });

    expect(fs.existsSync(path.join(data, id))).toBe(false);
    expect((await fetch(`${s.base}/api/forge/${id}`)).status).toBe(404);
    expect((await fetch(`${s.base}/api/forge/${id}/card.png`)).status).toBe(404);
    expect(await s.list()).toEqual(['p-old']);
    const profile = (await (await fetch(`${s.base}/api/profiles/phoenix`)).json()) as { fighter: { id: string } | null };
    expect(profile.fighter?.id).toBe('p-old');

    // Its record is gone (on disk too); the old fighter keeps its own (2 wins, plus the 1 loss to the deleted one).
    const recs = await s.records();
    expect(recs[id]).toBeUndefined();
    expect(recs['p-old']).toMatchObject({ wins: 2, losses: 2 });
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(data, 'records.json'), 'utf8')))).toEqual(['p-old']);

    // Only the highlight without it is left, its clip too.
    const left = await s.highlights();
    expect(left).toHaveLength(1);
    expect(left[0].p1.id).toBeUndefined();
    expect(fs.readdirSync(path.join(data, 'highlights')).filter((f) => f.endsWith('.webm'))).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(data, 'highlights', 'index.json'), 'utf8'))).toHaveLength(1);

    // Gone is gone: 404, a clip of a fight that was still on isn't kept, and a restart doesn't bring any of it back.
    expect((await s.del(id, ownerKey)).status).toBe(404);
    expect((await s.upload({ id, name: 'phoenix' })).status).toBe(410);
    expect(await s.highlights()).toHaveLength(1);
    for (const child of running.splice(0)) child.kill();
    const again = await startForge({}, data);
    expect(await again.list()).toEqual(['p-old']);
    expect((await again.records())[id]).toBeUndefined();
    expect(await again.highlights()).toHaveLength(1);
  });

  it('deletes with the delete code, however it is typed', async () => {
    const s = await startForge();
    const { id, deleteCode } = await s.forge();
    const keep = await s.forge();
    expect((await s.delCode('ABCD')).status).toBe(400);
    expect((await s.delCode('0000-0000-0000-0000')).status).toBe(403);
    // Lower case, spaces instead of dashes, an O for a zero and an l for a one all still work.
    const typed = ` ${deleteCode.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')} `;
    const res = await s.delCode(typed);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id });
    expect(fs.existsSync(path.join(s.data, id))).toBe(false);
    expect(await s.list()).toEqual([keep.id]);
    expect((await s.delCode(deleteCode)).status).toBe(403);
  });

  it("won't delete a fighter mid-forge", async () => {
    const s = await startForge({ MOCK_DELAY_MS: '1500' });
    const res = await s.post('/api/forge', { name: 'A', frames: [JPEG] });
    const { id, ownerKey } = (await res.json()) as { id: string; ownerKey: string };
    expect((await s.del(id, ownerKey)).status).toBe(409);
    expect(fs.existsSync(path.join(s.data, id))).toBe(true);
  });

  it('rate-limits delete tries, codes apart from keys', async () => {
    const s = await startForge({ FORGE_MAX_DELETES: '2' });
    const { id, ownerKey } = await s.forge();
    expect((await s.delCode('0000-0000-0000-0000')).status).toBe(403);
    expect((await s.delCode('0000-0000-0000-0001')).status).toBe(403);
    expect((await s.delCode('0000-0000-0000-0002')).status).toBe(429);
    // Guessing codes doesn't lock out an owner with a key.
    expect((await s.del(id, 'wrong')).status).toBe(403);
    expect((await s.del(id, ownerKey)).status).toBe(200);
    expect((await s.del(id, ownerKey)).status).toBe(429);
  });

  it('lets the game page call it cross-origin', async () => {
    const s = await startForge();
    const res = await fetch(`${s.base}/api/fighters/x/delete`, {
      method: 'OPTIONS',
      headers: { origin: 'https://brawlmegle.vip', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-forge-key' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://brawlmegle.vip');
  });
});

describe('delete-fighter.mjs (admin)', () => {
  const script = (data: string, port: string, ...args: string[]) =>
    spawnSync(process.execPath, ['forge/delete-fighter.mjs', ...args], { cwd: ROOT, env: { ...process.env, FORGE_DATA: data, FORGE_PORT: port }, encoding: 'utf8' });

  it('deletes every fighter under a username through the running server', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-del-'));
    seed(data, { id: 'd-1', name: 'dylan', username: 'dylan', createdAt: 1 }, ['front.jpg', 'rigged.glb.pre-rescue']);
    seed(data, { id: 'd-2', name: 'dylan', username: 'dylan', createdAt: 2 }, ['front.jpg']);
    seed(data, { id: 'guest', name: 'guest', createdAt: 3 });
    fs.writeFileSync(path.join(data, 'records.json'), JSON.stringify({ 'd-2': { wins: 1, losses: 0, draws: 0, streak: 1, bestStreak: 1 } }));
    const s = await startForge({}, data);
    const port = new URL(s.base).port;
    expect((await s.upload({ id: 'd-1', name: 'dylan' })).status).toBe(201);

    // Without --yes it only lists them.
    const dry = script(data, port, 'Dylan');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('d-1');
    expect(dry.stdout).toContain('d-2');
    expect(dry.stdout).toContain('would be deleted');
    expect(fs.existsSync(path.join(data, 'd-1'))).toBe(true);

    const run = script(data, port, 'dylan', '--yes');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('through the running server');
    expect(fs.existsSync(path.join(data, 'd-1'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'd-2'))).toBe(false);
    expect(await s.list()).toEqual(['guest']);
    expect((await s.records())['d-2']).toBeUndefined();
    expect(await s.highlights()).toEqual([]);

    expect(script(data, port, 'nobody').status).toBe(1);
  });

  type Rated = { rating: Record<'p1' | 'p2', { before: number; after: number; rated: number }> | null; duplicate?: boolean };

  it('rates rounds between two people, and a rescan keeps the rating', async () => {
    const s = await startForge();
    const rico = await s.forge({ username: 'rico' });
    const dyl = await s.forge({ username: 'dyl' });
    const first = (await (await s.post('/api/matches', { matchId: 'r1', p1: rico.id, p2: dyl.id, winner: 'p1' })).json()) as Rated;
    expect(first.rating).toEqual({ p1: { before: 1000, after: 1020, rated: 1 }, p2: { before: 1000, after: 980, rated: 1 } });
    // The same round reported twice moves nothing.
    expect(await (await s.post('/api/matches', { matchId: 'r1', p1: rico.id, p2: dyl.id, winner: 'p1' })).json()).toMatchObject({ duplicate: true });
    // A rescan under the same username is the same player: the rating carries over.
    const again = await s.forge({ username: 'rico' });
    const records = (await (await fetch(`${s.base}/api/records`)).json()) as { records: Record<string, { rating?: number; rated?: number }> };
    expect(records.records[again.id]).toMatchObject({ rating: 1020, rated: 1 });
    const draw = (await (await s.post('/api/matches', { matchId: 'r2', p1: dyl.id, p2: again.id, winner: null })).json()) as Rated;
    expect(draw.rating?.p2.before).toBe(1020);
    expect(draw.rating?.p1.after).toBeGreaterThan(980); // the lower-rated side gains from a draw
  });

  it("doesn't rate someone against their own rescan, or a stand-in", async () => {
    const s = await startForge();
    const a = await s.forge({ username: 'rico' });
    const b = await s.forge({ username: 'rico' });
    expect(((await (await s.post('/api/matches', { matchId: 's1', p1: a.id, p2: b.id, winner: 'p1' })).json()) as Rated).rating).toBeNull();
    expect(((await (await s.post('/api/matches', { matchId: 's2', p1: a.id, p2: 'stand-in-x', winner: 'p1' })).json()) as Rated).rating).toBeNull();
  });

  it("drops a player's rating with their last fighter", async () => {
    const s = await startForge();
    const rico = await s.forge({ username: 'rico' });
    const dyl = await s.forge({ username: 'dyl' });
    await s.post('/api/matches', { matchId: 'd1', p1: rico.id, p2: dyl.id, winner: 'p1' });
    expect((await s.del(rico.id, rico.ownerKey)).status).toBe(200);
    const ratings = JSON.parse(fs.readFileSync(path.join(s.data, 'ratings.json'), 'utf8')) as Record<string, { rating: number }>;
    expect(ratings['u:rico']).toBeUndefined();
    expect(ratings['u:dyl']).toMatchObject({ rating: 980 });
  });

  it('deletes on disk by id when the server is stopped', () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-del-'));
    seed(data, { id: 'a-1', name: 'ann', createdAt: 1 }, ['front.jpg', 'card.png']);
    seed(data, { id: 'b-1', name: 'bob', createdAt: 2 });
    fs.writeFileSync(path.join(data, 'records.json'), JSON.stringify({ 'a-1': { wins: 1 }, 'b-1': { wins: 2 } }));
    fs.mkdirSync(path.join(data, 'highlights'));
    fs.writeFileSync(path.join(data, 'highlights', 'h1.webm'), 'x');
    fs.writeFileSync(path.join(data, 'highlights', 'h2.webm'), 'x');
    fs.writeFileSync(path.join(data, 'highlights', 'index.json'), JSON.stringify([{ id: 'h1', file: 'h1.webm', p1: { id: 'a-1' } }, { id: 'h2', file: 'h2.webm', p2: { id: 'b-1' } }]));

    const run = script(data, '1', 'a-1', '--yes');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('on disk');
    expect(fs.existsSync(path.join(data, 'a-1'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'b-1'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(data, 'records.json'), 'utf8'))).toEqual({ 'b-1': { wins: 2 } });
    expect(JSON.parse(fs.readFileSync(path.join(data, 'highlights', 'index.json'), 'utf8')).map((h: { id: string }) => h.id)).toEqual(['h2']);
    expect(fs.existsSync(path.join(data, 'highlights', 'h1.webm'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'highlights', 'h2.webm'))).toBe(true);
  });
});
