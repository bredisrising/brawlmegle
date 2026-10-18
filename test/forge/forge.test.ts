import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ForgedFighter } from '../../src/types';

// config.ts reads window.location at import; the tests run in node.
vi.stubGlobal('window', { location: { search: '' } });
let forge: typeof import('../../src/forge/forge');
let roster: typeof import('../../src/forge/roster');
beforeAll(async () => {
  forge = await import('../../src/forge/forge');
  roster = await import('../../src/forge/roster');
});
afterEach(() => vi.unstubAllGlobals());

const API = 'http://forge.test/';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('forge client', () => {
  it('maps server fighters, dropping unknown fields', () => {
    const f = forge.toForgedFighter(
      { id: 'a', name: '', status: 'forging', step: 'sheet', sheetUrl: 'http://x/sheet.png', glbUrl: '', timings: { brief: 3 }, brief: { title: 'The Menace' } },
      'Kid',
    );
    expect(f).toEqual({ id: 'a', name: 'Kid', status: 'forging', step: 'sheet', sheetUrl: 'http://x/sheet.png', brief: { title: 'The Menace' } });
  });

  it("keeps the live preview's files and builds the forging card's stages from them", async () => {
    const { forgePreview } = await import('../../src/forge/status');
    const f = forge.toForgedFighter({
      id: 'a',
      name: 'Kid',
      status: 'forging',
      step: 'rig',
      sheetPartialUrl: 'http://x/sheet-partial-1.webp',
      previewVoxelsUrl: 'http://x/preview-voxels.bin',
      previewMeshUrl: 'http://x/preview-shape.glb',
      brief: { name: 'Static Storm', archetype: 'street boxer', build: 'athletic', signature: ['red wraps', 'a headband'], palette: ['#112233', 'red'] },
    });
    expect(forgePreview(f)).toEqual({
      name: 'Static Storm',
      archetype: 'street boxer',
      dossier: ['Build: athletic', 'Signature: red wraps, a headband'],
      palette: ['#112233'],
      sheetUrl: 'http://x/sheet-partial-1.webp', // the partial until the final sheet exists
      voxelsUrl: 'http://x/preview-voxels.bin',
      meshUrl: 'http://x/preview-shape.glb',
      step: 'rig',
    });
    expect(forgePreview({ ...f, sheetUrl: 'http://x/sheet.png' })).toMatchObject({ sheetUrl: 'http://x/sheet.png', sheetFinal: true });
  });

  it('submits only the frames it has, then polls until ready', async () => {
    const calls: { url: string; body?: { name: string; frames: string[] } }[] = [];
    const statuses: Partial<ForgedFighter>[] = [
      { status: 'scanning' },
      { status: 'forging', step: 'brief' },
      { status: 'forging', step: 'sheet', sheetUrl: 'http://forge.test/api/forge/f1/sheet.png' },
      { status: 'ready', name: 'Kid Haymaker', cardUrl: 'http://forge.test/api/forge/f1/card.png' },
    ];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (init?.method === 'POST') return json({ id: 'f1' }, 202);
      return json({ id: 'f1', name: 'Kid Haymaker', ...statuses.shift() });
    });
    const seen: string[] = [];
    const fighter = await forge.forgeFighter('Kid Haymaker', ['data:image/jpeg;base64,AAA', '', 'data:image/jpeg;base64,BBB'], (f) => seen.push(f.step ?? f.status), { api: API, pollMs: 1 });
    expect(calls[0].url).toBe('http://forge.test/api/forge');
    expect(calls[0].body).toEqual({ name: 'Kid Haymaker', frames: ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'] });
    expect(calls[1].url).toBe('http://forge.test/api/forge/f1');
    expect(fighter).toMatchObject({ id: 'f1', status: 'ready', cardUrl: 'http://forge.test/api/forge/f1/card.png' });
    expect(fighter.glbUrl).toBeUndefined(); // no 3D step yet: the game uses its default model
    expect(seen).toEqual(['scanning', 'scanning', 'brief', 'sheet', 'ready']);
  });

  it('reports a server-side failure as a failed fighter', async () => {
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? json({ id: 'f2' }, 202) : json({ id: 'f2', status: 'failed', error: 'OpenAI 500' }),
    );
    const fighter = await forge.forgeFighter('X', ['data:image/jpeg;base64,AAA', '', ''], undefined, { api: API, pollMs: 1 });
    expect(fighter).toMatchObject({ status: 'failed', error: 'OpenAI 500', name: 'X' });
  });

  it('throws when the forge rejects the scan, or there is nothing to send', async () => {
    vi.stubGlobal('fetch', async () => json({ error: '3 forges already running' }, 429));
    await expect(forge.submitForge('X', ['data:image/jpeg;base64,AAA', '', ''], API)).rejects.toThrow(/429.*already running/);
    await expect(forge.submitForge('X', ['', '', ''], API)).rejects.toThrow(/no frames/);
  });

  it('gives up after repeated network errors', async () => {
    let posted = false;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return (posted = true), json({ id: 'f3' }, 202);
      throw new TypeError('Failed to fetch');
    });
    const fighter = await forge.forgeFighter('X', ['data:image/jpeg;base64,AAA', '', ''], undefined, { api: API, pollMs: 1 });
    expect(posted).toBe(true);
    expect(fighter).toMatchObject({ id: 'f3', status: 'failed', error: 'Failed to fetch' });
  });

  it('mocks everything without a forge server', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const fighter = await forge.forgeFighter('Mock', ['', '', ''], undefined, { api: '' });
    expect(fighter.status).toBe('ready');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('roster', () => {
  it('puts server fighters first and dedupes by id', () => {
    const a = { id: 'a', name: 'A', status: 'ready' } as const;
    const b = { id: 'b', name: 'B', status: 'ready' } as const;
    const local = { id: 'a', name: 'A (old copy)', status: 'ready' } as const;
    expect(roster.mergeRosters([a], [local, b], []).map((f) => f.name)).toEqual(['A', 'B']);
  });

  it('reads ready fighters from the forge server, and survives it being down', async () => {
    vi.stubGlobal('fetch', async () =>
      json([
        { id: 's1', name: 'Server Sam', status: 'ready', cardUrl: 'http://forge.test/api/forge/s1/card.png', timings: {} },
        { id: 's2', name: 'Half Done', status: 'forging' },
      ]),
    );
    expect((await roster.fetchServerFighters(API)).map((f) => f.id)).toEqual(['s1']);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await roster.fetchServerFighters(API)).toEqual([]);
    expect(await roster.fetchServerFighters('')).toEqual([]);
  });
});

describe('delete my fighter (client)', () => {
  /** A Map-backed localStorage. */
  const memoryStorage = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), map: m };
  };

  it('hands the owner key and delete code over once the forge starts', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/api/forge') ? json({ id: 'f1', ownerKey: 'k'.repeat(43), deleteCode: 'ABCD-EFGH-JKMN-PQRS' }, 202) : json({ id: 'f1', status: 'ready' }),
    );
    const owners: unknown[] = [];
    await forge.forgeFighter('X', ['data:image/jpeg;base64,AAA', '', ''], undefined, { api: API, pollMs: 1, onOwner: (o) => owners.push(o) });
    expect(owners).toEqual([{ id: 'f1', key: 'k'.repeat(43), code: 'ABCD-EFGH-JKMN-PQRS' }]);
    // An older forge server without owner keys: no owner, and the forge still works.
    vi.stubGlobal('fetch', async (url: string) => (url.endsWith('/api/forge') ? json({ id: 'f2' }, 202) : json({ id: 'f2', status: 'ready' })));
    expect(await forge.startForge('X', ['data:image/jpeg;base64,AAA', '', ''], API)).toEqual({ id: 'f2', owner: null });
  });

  it('formats a typed delete code', () => {
    expect(forge.formatDeleteCode('abcdefghjkmnpqrs')).toBe('ABCD-EFGH-JKMN-PQRS');
    expect(forge.formatDeleteCode(' abcd efgh-jkmn pqrs tail')).toBe('ABCD-EFGH-JKMN-PQRS');
    expect(forge.formatDeleteCode('oil')).toBe('011');
    expect(forge.isDeleteCode('ABCD-EFGH-JKMN-PQRS')).toBe(true);
    expect(forge.isDeleteCode('ABCD-EFGH')).toBe(false);
  });

  it('deletes with the key or the code and says when it is already gone', async () => {
    const calls: { url: string; body: unknown }[] = [];
    let status = 200;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return status === 200 ? json({ ok: true, id: 'f1', name: 'Rico' }) : json({ error: 'nope' }, status);
    });
    expect(await forge.deleteFighter({ id: 'f1', key: 'secret' }, API)).toEqual({ ok: true, id: 'f1', name: 'Rico' });
    expect(calls[0]).toEqual({ url: 'http://forge.test/api/fighters/f1/delete', body: { key: 'secret' } });
    expect(await forge.deleteFighter({ code: 'ABCD-EFGH-JKMN-PQRS' }, API)).toMatchObject({ ok: true, id: 'f1' });
    expect(calls[1]).toEqual({ url: 'http://forge.test/api/fighters/delete', body: { code: 'ABCD-EFGH-JKMN-PQRS' } });
    status = 404;
    expect(await forge.deleteFighter({ id: 'f1', key: 'secret' }, API)).toEqual({ ok: false, gone: true, error: 'nope' });
    status = 403;
    expect(await forge.deleteFighter({ id: 'f1', key: 'wrong' }, API)).toEqual({ ok: false, gone: false, error: 'nope' });
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await forge.deleteFighter({ id: 'f1', key: 'secret' }, API)).toMatchObject({ ok: false, gone: false });
  });

  it('keeps owner keys apart from saved fighters, and forgets a deleted fighter everywhere', async () => {
    const store = memoryStorage();
    vi.stubGlobal('localStorage', store);
    roster.saveFighter({ id: 'f1', name: 'Rico', status: 'ready' });
    roster.saveFighter({ id: 'f2', name: 'Dylan', status: 'ready' });
    roster.saveOwner({ id: 'f1', key: 'secret-1' }, 'Rico');
    expect(store.map.get('brawlegle.roster')).not.toContain('secret-1');
    expect(roster.ownedFighters()).toMatchObject([{ id: 'f1', key: 'secret-1', name: 'Rico' }]);
    store.map.set('brawlegle.leaderboard', JSON.stringify({ f1: { wins: 1, losses: 0, draws: 0, streak: 1, bestStreak: 1 }, f2: { wins: 2, losses: 0, draws: 0, streak: 0, bestStreak: 2 } }));

    roster.forgetFighter('f1');
    expect(roster.ownedFighters()).toEqual([]);
    expect((await roster.listFighters('')).map((f) => f.id)).toEqual(['f2', 'default']);
    expect(Object.keys(JSON.parse(store.map.get('brawlegle.leaderboard')!))).toEqual(['f2']);

    // Junk in storage never breaks it.
    store.map.set('brawlegle.owned', '[1,2]');
    expect(roster.ownedFighters()).toEqual([]);
    store.map.set('brawlegle.owned', '{"x":{"key":""},"y":{"key":"k"}}');
    expect(roster.ownedFighters().map((o) => o.id)).toEqual(['y']);
  });
});
