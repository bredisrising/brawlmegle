import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// config.ts reads window.location at import; the tests run in node.
vi.stubGlobal('window', { location: { search: '' } });
let forge: typeof import('../../src/forge/forge');
let roster: typeof import('../../src/forge/roster');
beforeAll(async () => {
  forge = await import('../../src/forge/forge');
  roster = await import('../../src/forge/roster');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const API = 'http://forge.test/';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** A request that never answers (stalled Wi-Fi): it only ends when its signal aborts. */
const stalled = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    if (!signal) return; // no signal: hangs forever
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

describe('forge client under a bad network', () => {
  it('fails a forge whose status requests stall, instead of waiting forever', async () => {
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? json({ id: 'f1' }, 202) : stalled(init)));
    const fighter = await forge.forgeFighter('X', ['data:image/jpeg;base64,AAA', '', ''], undefined, { api: API, pollMs: 1, requestTimeoutMs: 5 });
    expect(fighter).toMatchObject({ id: 'f1', status: 'failed' });
  });

  it('rides out a few failed polls and still gets the fighter', async () => {
    let polls = 0;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ id: 'f2' }, 202);
      if (++polls <= 4) throw new TypeError('Failed to fetch');
      return json({ id: 'f2', name: 'Kid', status: 'ready' });
    });
    const fighter = await forge.forgeFighter('Kid', ['data:image/jpeg;base64,AAA', '', ''], undefined, { api: API, pollMs: 1 });
    expect(fighter.status).toBe('ready');
  });

  it('stops polling when the caller aborts', async () => {
    const abort = new AbortController();
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? json({ id: 'f3' }, 202) : stalled(init)));
    const forging = forge.forgeFighter('X', ['data:image/jpeg;base64,AAA', '', ''], undefined, { api: API, pollMs: 1, signal: abort.signal });
    setTimeout(() => abort.abort(new Error('left the screen')), 5);
    await expect(forging).rejects.toThrow('left the screen');
  });

  it('gives up on a scan upload that stalls', async () => {
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => stalled(init));
    await expect(forge.submitForge('X', ['data:image/jpeg;base64,AAA', '', ''], API, undefined, 5)).rejects.toThrow(/reach the forge/);
  });

  it('gives up on a profile lookup that stalls', async () => {
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => stalled(init));
    await expect(forge.findProfile('ankit', API, 5)).rejects.toThrow();
  });
});

describe('usernames', () => {
  it('rejects names that are only dots (the profile URL would collapse to /api/)', () => {
    expect(new URL(`${API}api/profiles/..`).pathname).toBe('/api/'); // why
    expect(forge.normalizeUsername('..')).toBeNull();
    expect(forge.normalizeUsername('.')).toBeNull();
    expect(forge.normalizeUsername(' A.B ')).toBe('a.b');
    expect(forge.normalizeUsername('.ankit.')).toBe('.ankit.');
  });
});

describe('memory card', () => {
  const storage = (value: string | null) => ({ getItem: () => value, setItem: vi.fn() });

  it('survives junk in localStorage', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const junk of ['null', '{"a":1}', '"x"', '[null, 3, {"name":"no id"}]', 'not json']) {
      vi.stubGlobal('localStorage', storage(junk));
      const list = await roster.listFighters('');
      expect(list.map((f) => f.id)).toContain('default');
    }
    vi.stubGlobal('localStorage', storage('[null, {"id":"saved-1","name":"Saved","status":"ready"}]'));
    expect((await roster.listFighters('')).map((f) => f.id)).toContain('saved-1');
  });
});
