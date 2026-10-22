import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FighterRecord } from '../../src/forge/leaderboard';

// config.ts reads window.location at import, and the module refreshes its records once: keep that off the network.
vi.stubGlobal('window', { location: { search: '' } });
vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
let board: typeof import('../../src/forge/leaderboard');
beforeAll(async () => {
  board = await import('../../src/forge/leaderboard');
});

const rec = (r: Partial<FighterRecord>): FighterRecord => ({ wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0, recentResults: [], ...r });

describe('ratings on the leaderboard', () => {
  it('names the rank for a rating', () => {
    expect(board.tierOf(900)).toBe('Rookie');
    expect(board.tierOf(1000)).toBe('Brawler');
    expect(board.tierOf(1100)).toBe('Contender');
    expect(board.tierOf(1399)).toBe('Elite');
    expect(board.tierOf(1400)).toBe('Champion');
  });

  it('ranks placed players above ones still placing, then by rating', () => {
    const placing = rec({ rating: 1200, rated: 3, wins: 3 });
    const low = rec({ rating: 1010, rated: 8, wins: 4, losses: 4 });
    const high = rec({ rating: 1090, rated: 6, wins: 4, losses: 2 });
    const sorted = [placing, low, high].sort(board.compareBy('rating'));
    expect(sorted).toEqual([high, low, placing]);
  });

  it('puts a player with real rated fights above everyone still on the starting 1,000', () => {
    const placing = rec({ rating: 978, rated: 3, wins: 8, losses: 10 });
    const unrated = rec({ wins: 40, losses: 2 });
    expect([unrated, placing].sort(board.compareBy('rating'))).toEqual([placing, unrated]);
  });

  it("doesn't let one lucky win top the win-rate tab", () => {
    const lucky = rec({ wins: 1 });
    const steady = rec({ wins: 6, losses: 2 });
    expect([lucky, steady].sort(board.compareBy('winRate'))).toEqual([steady, lucky]);
  });

  it('switches the board to rating once five players are ranked', () => {
    const ranked = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, rec({ rating: 1000 + i, rated: board.PLACEMENT })]));
    expect(board.ratingBoardReady(ranked(4))).toBe(false);
    expect(board.ratingBoardReady({ ...ranked(5), extra: rec({ rating: 1000, rated: 2 }) })).toBe(true);
  });
});
