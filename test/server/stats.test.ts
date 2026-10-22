// The owners' stats (forge/stats.js): the game's moments (src/analytics.ts) are kept without names or addresses, junk
// and floods are dropped, and the report adds them up per visit: the funnel, opponents, bots, scans, errors. Also
// the real server's two endpoints, and that the server's list of moments matches the game's.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module
import { MOMENTS, createStats } from '../../forge/stats.js';

const ROOT = path.resolve(__dirname, '../..');
const running: ChildProcess[] = [];
afterEach(() => {
  for (const child of running.splice(0)) child.kill();
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stats-'));
/** 2026-10-22 10:00 Pacific. */
const NOON = Date.parse('2026-10-22T17:00:00Z');

function statsAt(dir: string, at = { t: NOON }) {
  return createStats({ dir: pathToFileURL(`${dir}/`), now: () => at.t });
}

/** A whole visit's moments, as one batch sent `sentAt` ms after the page opened. */
const visit = (s: string, e: { n: string; t?: number; p?: Record<string, unknown> }[], extra: Record<string, unknown> = {}) => ({
  s,
  t: 60_000,
  e: e.map((m, i) => ({ t: m.t ?? i * 1000, ...m })),
  ...extra,
});

async function flushed() {
  // Appends are async: let them land.
  await new Promise((r) => setTimeout(r, 50));
}

describe('moments', () => {
  it('keeps known moments with plain facts, and nothing else', async () => {
    const dir = tmp();
    const stats = statsAt(dir);
    const kept = stats.record(
      visit('abc123def456', [
        { n: 'visit', p: { browser: 'Chrome', returning: false, nested: { no: 1 }, 'Bad-Key': 1, long: 'x'.repeat(500) } },
        { n: 'not_a_moment' },
        { n: 'match_end', p: { opp: 'bot', bot: 'gary', result: 'win', secs: 95.4 } },
      ]),
    );
    expect(kept).toBe(2);
    await flushed();
    const lines = fs.readFileSync(path.join(dir, 'moments-2026-10-22.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.n)).toEqual(['visit', 'match_end']);
    expect(lines[0].p).toEqual({ browser: 'Chrome', returning: false, long: 'x'.repeat(120) });
    // Stamped by when it happened: the batch went a minute after the page opened.
    expect(lines[0].at).toBe(NOON - 60_000);
    expect(Object.keys(lines[0]).sort()).toEqual(['at', 'n', 'p', 's']);
  });

  it('drops a malformed batch and caps a visit that sends too much', () => {
    const stats = statsAt(tmp());
    expect(stats.record(null)).toBe(0);
    expect(stats.record({ s: 'x', e: [{ n: 'visit' }] })).toBe(0);
    expect(stats.record({ s: '../../etc', e: [{ n: 'visit' }] })).toBe(0);
    let kept = 0;
    for (let i = 0; i < 10; i++) kept += stats.record(visit('loopy123', Array.from({ length: 60 }, () => ({ n: 'search' }))));
    expect(kept).toBe(400);
  });

  it("lists the same moments as the game's analytics", () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/analytics.ts'), 'utf8');
    const union = src.slice(src.indexOf('export type Moment ='), src.indexOf('type Value'));
    const game = [...union.matchAll(/\| '([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(game).toEqual([...MOMENTS].sort());
  });
});

describe('the report', () => {
  it('adds up visits: funnel, opponents, bots, scans, camera, errors, owners left out', async () => {
    const dir = tmp();
    const stats = statsAt(dir);
    // A new visitor from LinkedIn: camera on, scans, fights Gary (wins), then a stranger (loses).
    stats.record(
      visit('aaaaaa111111', [
        { n: 'visit', p: { ref: 'linkedin.com', browser: 'Chrome', os: 'Mac', device: 'computer', returning: false } },
        { n: 'cam_ask', p: { blocked: false } },
        { n: 'cam_on', p: { asked: true } },
        { n: 'play', p: { mode: 'find_fight' } },
        { n: 'fighter', p: { kind: 'scan' } },
        { n: 'scan_start' },
        { n: 'scan_sent', p: { sides: 3, secs: 21 } },
        { n: 'forge_done', p: { ok: true, skipped: false, secs: 70 } },
        { n: 'search' },
        { n: 'bot_in', p: { bot: 'gary', waited: 5 } },
        { n: 'fight_start', p: { opp: 'bot', bot: 'gary' } },
        { n: 'match_end', p: { opp: 'bot', bot: 'gary', result: 'win', secs: 100, pose_fps: 28, quality: 0 } },
        { n: 'search' },
        { n: 'matched', p: { as: 'host', waited: 12, over_bot: false } },
        { n: 'fight_start', p: { opp: 'stranger' } },
        { n: 'match_end', p: { opp: 'stranger', result: 'loss', secs: 120, rtt: 80, path: 'relay', pose_fps: 30 } },
        { n: 'error', p: { kind: 'js', msg: 'TypeError: x is undefined' } },
        { n: 'leave', p: { secs: 400, matches: 2 } },
      ]),
    );
    // A returning visitor who says "Not now" to the camera and leaves.
    stats.record(visit('bbbbbb222222', [{ n: 'visit', p: { browser: 'Safari', returning: true } }, { n: 'cam_ask' }, { n: 'cam_later' }, { n: 'leave', p: { secs: 20 } }]));
    // ...and back after "Title" (the same visit): the popup again, counted once.
    stats.record(visit('bbbbbb222222', [{ n: 'visit', p: { returning: true, reload: true } }, { n: 'cam_ask' }, { n: 'cam_later' }]));
    // One of us: not counted unless asked.
    stats.record(visit('cccccc333333', [{ n: 'visit', p: { returning: true } }, { n: 'fight_start', p: { opp: 'cpu' } }], { o: 1 }));
    await flushed();

    const r = stats.report({ days: 7, facts: { fighters: [], ratings: {}, highlights: 3 } });
    expect(r.days).toHaveLength(7);
    expect(r.days.at(-1)).toBe('2026-10-22');
    expect(r.funnel).toEqual({ visited: 2, camOn: 1, fighter: 1, fight: 1, finished: 1, again: 1, human: 1 });
    expect(r.daily.at(-1)).toMatchObject({ day: '2026-10-22', visits: 2, new: 1, camOn: 1, players: 1, scans: 1, forged: 1, matches: 2, human: 1, bot: 1, errors: 1 });
    expect(r.camera).toMatchObject({ asked: 2, on: 1, onAsked: 1, later: 1 });
    expect(r.bots).toEqual([{ bot: 'gary', matches: 1, playerWins: 1, botWins: 0, draws: 0 }]);
    expect(r.opponents.find((o: { opp: string }) => o.opp === 'stranger')).toMatchObject({ matches: 1, loss: 1 });
    expect(r.scans).toMatchObject({ started: 1, sent: 1, ok: 1, medianScanSecs: 21, medianForgeSecs: 70 });
    expect(r.matchmaking).toMatchObject({ searches: 2, botIns: 1, matched: 1, medianWaitHuman: 12 });
    expect(r.sources.referrers).toEqual(expect.arrayContaining([{ key: 'linkedin.com', n: 1 }, { key: '(direct)', n: 1 }]));
    expect(r.tech.medianRtt).toBe(80);
    expect(r.errors[0]).toMatchObject({ error: 'js: TypeError: x is undefined', n: 1, visits: 1 });
    expect(r.sessions.median).toBe(400);
    expect(r.server.highlights).toBe(3);

    expect(stats.report({ owners: true }).funnel.visited).toBe(3);
  });

  it("counts a Title reload as the same visit, and puts days in Pacific time", async () => {
    const dir = tmp();
    const at = { t: Date.parse('2026-10-22T06:30:00Z') }; // 11:30 pm on the 21st, Pacific
    const stats = statsAt(dir, at);
    stats.record(visit('dddddd444444', [{ n: 'visit', p: { returning: false } }, { n: 'title' }]));
    at.t += 3_600_000; // 12:30 am on the 22nd: the same tab after "Title"
    stats.record(visit('dddddd444444', [{ n: 'visit', p: { returning: true, reload: true } }]));
    await flushed();
    const r = stats.report({ days: 2 });
    expect(r.days).toEqual(['2026-10-21', '2026-10-22']);
    expect(r.funnel.visited).toBe(1);
    expect(r.daily[0]).toMatchObject({ visits: 1, new: 1 });
  });

  it('sums what the forge knows: forges per day and how long they took, ratings', () => {
    const stats = statsAt(tmp());
    const fighters = [
      { id: 'a', username: 'ankit', status: 'ready', createdAt: NOON - 1000, timings: { brief: 3000, sheet: 60_000, model: 47_000 } },
      { id: 'b', status: 'failed', createdAt: NOON - 2000, timings: {} },
      { id: 'c', name: 'Old one', status: 'ready', createdAt: NOON - 30 * 86_400_000 },
    ];
    const ratings = { 'u:ankit': { rating: 1022, rated: 3 }, 'f:c': { rating: 978, rated: 3 } };
    const r = stats.report({ days: 1, facts: { fighters, ratings, highlights: 0 } });
    expect(r.server).toMatchObject({ fighters: 2, usernames: 1, ratedPlayers: 2, rankedPlayers: 0, ratedFights: 3 });
    expect(r.server.forges).toEqual([{ day: '2026-10-22', forges: 2, ready: 1, failed: 1, medianSecs: 110 }]);
    expect(r.server.topRatings.map((p: { player: string }) => p.player)).toEqual(['ankit', 'Old one']);
  });
});

describe('the forge server', () => {
  async function startForge(env: Record<string, string>) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const data = tmp();
    const child = spawn(process.execPath, ['--import', path.join(__dirname, 'mock-fetch.mjs'), 'forge/server.js'], {
      cwd: ROOT,
      env: { ...process.env, OPENAI_API_KEY: 'sk-test', FORGE_PORT: String(port), FORGE_DATA: data, MATCHMAKER_HEALTH_URL: 'http://127.0.0.1:9/health', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (d) => String(d).includes('forge on') && resolve());
      child.once('exit', (code) => reject(new Error(`forge exited ${code}`)));
    });
    return { base: `http://127.0.0.1:${port}`, data };
  }

  it('takes beacons without a key, and shows the report only with the stats key', async () => {
    const { base } = await startForge({ FORGE_STATS_KEY: 'owners-only' });
    const beacon = await fetch(`${base}/api/moments`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(visit('eeeeee555555', [{ n: 'visit', p: { returning: false } }, { n: 'cam_on', p: { asked: true } }])),
    });
    expect(beacon.status).toBe(204);
    // Junk is shrugged off (it's only counting).
    expect((await fetch(`${base}/api/moments`, { method: 'POST', body: 'not json' })).status).toBe(204);
    expect((await fetch(`${base}/api/stats`)).status).toBe(403);
    expect((await fetch(`${base}/api/stats`, { headers: { 'x-stats-key': 'guess' } })).status).toBe(403);
    await flushed();
    const res = await fetch(`${base}/api/stats?days=3`, { headers: { 'x-stats-key': 'owners-only' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const r = await res.json();
    expect(r.days).toHaveLength(3);
    expect(r.funnel).toMatchObject({ visited: 1, camOn: 1 });
    expect(r.live).toBeNull(); // no matchmaker here
    expect(r.server).toMatchObject({ fighters: 0 });
  });

  it('has no stats page without a stats key', async () => {
    const { base } = await startForge({ FORGE_STATS_KEY: '' }); // (blank wins over a key in the repo's .env)
    expect((await fetch(`${base}/api/stats`, { headers: { 'x-stats-key': '' } })).status).toBe(404);
  });
});
