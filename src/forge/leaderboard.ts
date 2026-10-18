import type { ForgedFighter, PlayerId } from '../types';

const KEY = 'brawlegle.leaderboard';
type MatchResult = 'win' | 'loss' | 'draw';

export type FighterRecord = {
  wins: number;
  losses: number;
  draws: number;
  streak: number;
  bestStreak: number;
  /** Newest last; retained only for the leaderboard's recent-form tiebreaker. */
  recentResults: MatchResult[];
};

const emptyRecord = (): FighterRecord => ({ wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0, recentResults: [] });

function toRecord(value: unknown): FighterRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!['wins', 'losses', 'draws', 'streak', 'bestStreak'].every((key) => typeof record[key] === 'number' && Number.isFinite(record[key]))) return null;
  // Records saved before recent form was introduced remain valid, with an empty recent record.
  const results = Array.isArray(record.recentResults) && record.recentResults.every((result) => result === 'win' || result === 'loss' || result === 'draw')
    ? record.recentResults.slice(-7) as MatchResult[]
    : [];
  return { wins: record.wins as number, losses: record.losses as number, draws: record.draws as number, streak: record.streak as number, bestStreak: record.bestStreak as number, recentResults: results };
}

function readRecords(): Record<string, FighterRecord> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!stored || typeof stored !== 'object') return {};
    return Object.fromEntries(Object.entries(stored).flatMap(([id, value]) => {
      const record = toRecord(value);
      return record ? [[id, record]] : [];
    }));
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

/** Win rate over the fighter's latest seven completed rounds (draws don't count as wins or losses). */
export function recentWinRate(record: FighterRecord) {
  const decided = record.recentResults.filter((result) => result !== 'draw');
  return decided.length ? Math.round((decided.filter((result) => result === 'win').length / decided.length) * 100) : 0;
}

/** Save one completed round for each fighter. The host is authoritative for network matches. */
export function recordMatch(fighters: Partial<Record<PlayerId, ForgedFighter>>, winner: PlayerId | null) {
  if (!fighters.p1 || !fighters.p2) return;
  const records = readRecords();
  for (const id of ['p1', 'p2'] as const) {
    const fighter = fighters[id]!;
    const previous = records[fighter.id] ?? emptyRecord();
    const result: MatchResult = !winner ? 'draw' : winner === id ? 'win' : 'loss';
    const recentResults = [...previous.recentResults, result].slice(-7);
    if (!winner) records[fighter.id] = { ...previous, draws: previous.draws + 1, streak: 0, recentResults };
    else if (winner === id) {
      const streak = previous.streak + 1;
      records[fighter.id] = { ...previous, wins: previous.wins + 1, streak, bestStreak: Math.max(previous.bestStreak, streak), recentResults };
    } else records[fighter.id] = { ...previous, losses: previous.losses + 1, streak: 0, recentResults };
  }
  writeRecords(records);
}
