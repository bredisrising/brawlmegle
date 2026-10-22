import { beforeEach, describe, expect, it, vi } from 'vitest';

// The game's analytics (src/analytics.ts) in a stand-in browser: what it sends, where, and what it never sends.
type Beacon = { url: string; body: { s: string; t: number; o?: number; e: { n: string; t: number; p?: Record<string, unknown> }[] } };
let beacons: Beacon[];
let listeners: Record<string, (e?: unknown) => void>;
let local: Map<string, string>;
let tab: Map<string, string>;

function browser(search: string, { webdriver = false } = {}) {
  beacons = [];
  listeners = {};
  const storage = (m: Map<string, string>) => ({
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  });
  const gtag = vi.fn();
  vi.stubGlobal('window', { location: { search, hostname: 'brawlmegle.com', host: 'brawlmegle.com' }, gtag, addEventListener: (n: string, f: () => void) => (listeners[n] = f) });
  vi.stubGlobal('location', { search, hostname: 'brawlmegle.com', host: 'brawlmegle.com' });
  vi.stubGlobal('document', { referrer: 'https://www.linkedin.com/feed/', visibilityState: 'visible', addEventListener: (n: string, f: () => void) => (listeners[n] = f) });
  vi.stubGlobal('navigator', {
    webdriver,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
    language: 'en-US',
    sendBeacon: (url: string, blob: Blob) => {
      void blob.text().then((t) => beacons.push({ url, body: JSON.parse(t) }));
      return true;
    },
  });
  vi.stubGlobal('screen', { width: 1440, height: 900 });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('localStorage', storage(local));
  vi.stubGlobal('sessionStorage', storage(tab));
  return gtag;
}

async function load() {
  vi.resetModules();
  return import('../../src/analytics');
}

const sent = async () => {
  await new Promise((r) => setTimeout(r, 0));
  return beacons.flatMap((b) => b.body.e);
};

beforeEach(() => {
  vi.useRealTimers();
  local = new Map();
  tab = new Map();
});

describe('analytics', () => {
  it('sends a visit, then batches moments to our server and forwards them to GA4', async () => {
    const gtag = browser('?analytics=1&utm_source=linkedin');
    const a = await load();
    a.startAnalytics();
    a.track('play', { mode: 'find_fight' });
    a.track('match_end', { opp: 'bot', bot: 'gary', result: 'win', secs: 93.456, missing: undefined, nothing: null });
    listeners.pagehide();
    const e = await sent();
    expect(beacons[0].url).toBe('https://brawlmegle.com/api/moments');
    expect(e.map((m) => m.n)).toEqual(['visit', 'play', 'match_end', 'leave']);
    expect(e[0].p).toMatchObject({ ref: 'linkedin.com', utm: 'linkedin', os: 'Mac', browser: 'Chrome', device: 'computer', returning: false, reload: false });
    expect(e[2].p).toEqual({ opp: 'bot', bot: 'gary', result: 'win', secs: 93.46 });
    expect(e[3].p).toMatchObject({ matches: 1 });
    // GA4 gets the moments (it counts the visit itself, as page_view).
    expect(gtag).toHaveBeenCalledWith('event', 'play', { mode: 'find_fight' });
    expect(gtag.mock.calls.some((c) => c[1] === 'visit')).toBe(false);
    // One random id for the tab, kept for the Title reload.
    expect(beacons[0].body.s).toMatch(/^[a-z0-9]{16}$/);
    expect(tab.get('brawlmegle.session')).toBe(beacons[0].body.s);
  });

  it('is the same visit after a reload, and a returning browser says so', async () => {
    tab.set('brawlmegle.session', 'abcdef0123456789');
    local.set('brawlmegle.camIntro', '1');
    browser('?analytics=1');
    const a = await load();
    a.startAnalytics();
    listeners.pagehide();
    const e = await sent();
    expect(beacons[0].body.s).toBe('abcdef0123456789');
    expect(e[0].p).toMatchObject({ returning: true, reload: true });
  });

  it("marks the owners' browsers, sends once per page what should go once, and caps errors", async () => {
    local.set('brawlmegle.owner', '1');
    browser('?analytics=1');
    const a = await load();
    a.startAnalytics();
    a.trackOnce('cam_ask');
    a.trackOnce('cam_ask');
    for (let i = 0; i < 10; i++) a.trackError('js', new TypeError(`broke ${i}`));
    listeners.pagehide();
    const e = await sent();
    expect(beacons[0].body.o).toBe(1);
    expect(e.filter((m) => m.n === 'cam_ask')).toHaveLength(1);
    expect(e.filter((m) => m.n === 'error').map((m) => m.p?.msg)).toEqual(['TypeError: broke 0', 'TypeError: broke 1', 'TypeError: broke 2']);
  });

  it('sends nothing from dev, test browsers or ?analytics=0, and never throws', async () => {
    for (const [search, webdriver] of [['', false], ['?analytics=0', false], ['', true]] as const) {
      browser(search, { webdriver });
      const a = await load();
      a.startAnalytics();
      a.track('play', { mode: 'cpu' });
      listeners.pagehide?.();
      expect(await sent()).toEqual([]);
    }
    vi.stubGlobal('navigator', undefined);
    const a = await load();
    expect(() => (a.startAnalytics(), a.track('title'))).not.toThrow();
  });

  it('times things with mark and secsSince', async () => {
    vi.useFakeTimers();
    browser('?analytics=1');
    const a = await load();
    a.mark('search');
    vi.advanceTimersByTime(12_400);
    expect(a.secsSince('search')).toBe(12);
    expect(a.secsSince('never')).toBeNull();
  });
});
