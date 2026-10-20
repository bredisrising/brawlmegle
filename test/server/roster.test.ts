// The memory card on the forge server: a rescan replaces your fighter (one per username), hidden fighters drop off,
// and the leaderboard carries a username's earlier fighters' records into the one shown.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const running: ChildProcess[] = [];
afterAll(() => running.forEach((c) => c.kill()));

function fighter(data: string, f: Record<string, unknown>) {
  fs.mkdirSync(path.join(data, String(f.id)), { recursive: true });
  fs.writeFileSync(path.join(data, String(f.id), 'fighter.json'), JSON.stringify({ status: 'ready', timings: {}, ...f }));
}

async function startForge(data: string) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--import', path.join(__dirname, 'mock-fetch.mjs'), 'forge/server.js'], {
    cwd: ROOT,
    env: { ...process.env, OPENAI_API_KEY: 'sk-test', FORGE_PORT: String(port), FORGE_DATA: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d) => String(d).includes('forge on') && resolve());
    child.once('exit', (code) => reject(new Error(`forge exited ${code}`)));
  });
  return `http://127.0.0.1:${port}`;
}

describe('memory card', () => {
  it('shows one fighter per username (the newest ready one), skips hidden ones, and merges their records', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-roster-'));
    fighter(data, { id: 'p-old', name: 'phoenix', username: 'phoenix', createdAt: 1 });
    fighter(data, { id: 'p-new', name: 'phoenix', username: 'phoenix', createdAt: 3 });
    fighter(data, { id: 'p-forging', name: 'phoenix', username: 'phoenix', createdAt: 4, status: 'forging' });
    fighter(data, { id: 'd-old', name: 'dylan', username: 'dylan', createdAt: 1 });
    fighter(data, { id: 'd-broken', name: 'dylan', username: 'dylan', createdAt: 5, hidden: true });
    fighter(data, { id: 'guest', name: 'guest', createdAt: 2 });
    const record = (wins: number, losses: number, bestStreak: number) => ({ wins, losses, draws: 0, streak: 0, bestStreak });
    fs.writeFileSync(path.join(data, 'records.json'), JSON.stringify({ 'p-old': record(5, 3, 3), 'p-new': record(1, 0, 1), 'd-old': record(10, 9, 4) }));
    const base = await startForge(data);

    const list = (await (await fetch(`${base}/api/fighters`)).json()) as { id: string }[];
    expect(list.map((f) => f.id)).toEqual(['p-new', 'guest', 'd-old']);
    // An old id still works (links, a saved memory card).
    expect((await fetch(`${base}/api/forge/p-old`)).status).toBe(200);

    const { records } = (await (await fetch(`${base}/api/records`)).json()) as { records: Record<string, { wins: number; losses: number; bestStreak: number }> };
    expect(records['p-new']).toMatchObject({ wins: 6, losses: 3, bestStreak: 3 });
    expect(records['d-old']).toMatchObject({ wins: 10, losses: 9 });

    // Typing your username brings back your fighter, never the hidden broken one.
    const profile = (await (await fetch(`${base}/api/profiles/dylan`)).json()) as { fighter: { id: string } | null };
    expect(profile.fighter?.id).toBe('d-old');
  });
});
