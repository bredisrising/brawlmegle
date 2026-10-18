import { config } from '../config';
import type { ForgedFighter, PlayerId } from '../types';

/**
 * Fight records for the leaderboard. The forge server keeps the shared copy (every laptop sees the same standings,
 * GET /api/records, POST /api/matches); this browser keeps a cached copy so screens can read records instantly and
 * so a round still counts here if the server can't be reached.
 */
const KEY = 'brawlegle.leaderboard';

export type FighterRecord = {
  wins: number;
  losses: number;
  draws: number;
  streak: number;
  bestStreak: number;
};

const emptyRecord = (): FighterRecord => ({ wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0 });
const api = () => config.forgeApi.replace(/\/+$/, '');

function isRecord(value: unknown): value is FighterRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['wins', 'losses', 'draws', 'streak', 'bestStreak'].every((key) => typeof record[key] === 'number' && Number.isFinite(record[key]));
}

function clean(stored: unknown): Record<string, FighterRecord> {
  if (!stored || typeof stored !== 'object') return {};
  return Object.fromEntries(Object.entries(stored).filter(([, value]) => isRecord(value))) as Record<string, FighterRecord>;
}

function readRecords(): Record<string, FighterRecord> {
  try {
    return clean(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return {};
  }
}

function writeRecords(records: Record<string, FighterRecord>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
  } catch {
    // The round still completes if storage is unavailable (for example, private browsing).
  }
}

export function fighterRecord(fighterId: string): FighterRecord {
  return readRecords()[fighterId] ?? emptyRecord();
}

/** A snapshot for leaderboard screens (the local copy; see fetchRecords for the shared one). */
export function fighterRecords(): Readonly<Record<string, FighterRecord>> {
  return readRecords();
}

/** The shared records from the server (refreshing the local copy); the local copy if the server can't be reached. */
export async function fetchRecords(): Promise<Readonly<Record<string, FighterRecord>>> {
  if (!config.forgeApi) return readRecords();
  try {
    const res = await fetch(`${api()}/api/records`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${res.status}`);
    const shared = clean(((await res.json()) as { records?: unknown }).records);
    const merged = { ...readRecords(), ...shared };
    writeRecords(merged);
    return merged;
  } catch {
    return readRecords();
  }
}

export function totalMatches(record: FighterRecord) {
  return record.wins + record.losses + record.draws;
}

export function winRate(record: FighterRecord) {
  const decided = record.wins + record.losses;
  return decided ? Math.round((record.wins / decided) * 100) : 0;
}

/**
 * Save one completed round. The host is authoritative for network matches. A side left out (a CPU, which wears
 * someone else's fighter) isn't recorded; the human side still is.
 */
export function recordMatch(fighters: Partial<Record<PlayerId, ForgedFighter>>, winner: PlayerId | null) {
  const records = readRecords();
  for (const id of ['p1', 'p2'] as const) {
    const fighter = fighters[id];
    if (!fighter) continue;
    const previous = records[fighter.id] ?? emptyRecord();
    if (!winner) records[fighter.id] = { ...previous, draws: previous.draws + 1, streak: 0 };
    else if (winner === id) {
      const streak = previous.streak + 1;
      records[fighter.id] = { ...previous, wins: previous.wins + 1, streak, bestStreak: Math.max(previous.bestStreak, streak) };
    } else records[fighter.id] = { ...previous, losses: previous.losses + 1, streak: 0 };
  }
  writeRecords(records);
  if (!config.forgeApi) return;
  const matchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  void fetch(`${api()}/api/matches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forge-key': config.forgeKey },
    body: JSON.stringify({ matchId, p1: fighters.p1?.id ?? null, p2: fighters.p2?.id ?? null, winner }),
  }).catch(() => {});
}

// Freshen the local copy once at startup, so roster tiles show the shared records.
if (typeof window !== 'undefined') void fetchRecords();
