import type { ForgedFighter, PlayerId } from '../types';

const KEY = 'brawlegle.leaderboard';

export type FighterRecord = {
  wins: number;
  losses: number;
  draws: number;
  streak: number;
  bestStreak: number;
};

const emptyRecord = (): FighterRecord => ({ wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0 });

function isRecord(value: unknown): value is FighterRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['wins', 'losses', 'draws', 'streak', 'bestStreak'].every((key) => typeof record[key] === 'number' && Number.isFinite(record[key]));
}

function readRecords(): Record<string, FighterRecord> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!stored || typeof stored !== 'object') return {};
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => isRecord(value))) as Record<string, FighterRecord>;
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

/** A snapshot for leaderboard screens; callers should treat it as read-only. */
export function fighterRecords(): Readonly<Record<string, FighterRecord>> {
  return readRecords();
}

export function totalMatches(record: FighterRecord) {
  return record.wins + record.losses + record.draws;
}

export function winRate(record: FighterRecord) {
  const decided = record.wins + record.losses;
  return decided ? Math.round((record.wins / decided) * 100) : 0;
}

/** Save one completed round for each fighter. The host is authoritative for network matches. */
export function recordMatch(fighters: Partial<Record<PlayerId, ForgedFighter>>, winner: PlayerId | null) {
  if (!fighters.p1 || !fighters.p2) return;
  const records = readRecords();
  for (const id of ['p1', 'p2'] as const) {
    const fighter = fighters[id]!;
    const previous = records[fighter.id] ?? emptyRecord();
    if (!winner) records[fighter.id] = { ...previous, draws: previous.draws + 1, streak: 0 };
    else if (winner === id) {
      const streak = previous.streak + 1;
      records[fighter.id] = { ...previous, wins: previous.wins + 1, streak, bestStreak: Math.max(previous.bestStreak, streak) };
    } else records[fighter.id] = { ...previous, losses: previous.losses + 1, streak: 0 };
  }
  writeRecords(records);
}
