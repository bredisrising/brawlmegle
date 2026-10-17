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
