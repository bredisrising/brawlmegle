import { describe, expect, it } from 'vitest';
import { NO_WINS, Rounds, isFinal, matchOver, matchWinner, restLine, roundWinner, scoreRound } from '../../src/game/rounds';
import type { PlayerId } from '../../src/types';

/** Play a match out round by round (each entry: who took it, null = even), the way Game does. */
function play(results: (PlayerId | null)[]) {
  const r = new Rounds();
  const seen: { round: number; over: boolean; final: boolean }[] = [];
  for (const w of results) {
    const final = r.final;
    const over = r.end(w);
    seen.push({ round: r.round, over, final });
    if (over) break;
    r.next();
  }
  return { r, seen };
}

describe('round winner', () => {
  it('a K.O. goes to whoever landed it', () => {
    expect(roundWinner({ p1: 40, p2: 0 }, 'p1')).toBe('p1');
    expect(roundWinner({ p1: 0, p2: 3 }, 'p2')).toBe('p2');
  });
  it('both down at once is an even round', () => {
    expect(roundWinner({ p1: 0, p2: 0 }, 'p1')).toBeNull();
  });
  it('on time, more HP left takes it; equal HP is even', () => {
    expect(roundWinner({ p1: 51, p2: 50 }, null)).toBe('p1');
    expect(roundWinner({ p1: 20, p2: 80 }, null)).toBe('p2');
    expect(roundWinner({ p1: 64, p2: 64 }, null)).toBeNull();
  });
});

describe('scoring', () => {
  it('an even round is a win for both', () => {
    expect(scoreRound(NO_WINS, null)).toEqual({ p1: 1, p2: 1 });
    expect(scoreRound({ p1: 1, p2: 0 }, 'p2')).toEqual({ p1: 1, p2: 1 });
  });
  it('first to two, three rounds at most', () => {
    expect(matchOver({ p1: 1, p2: 0 }, 1)).toBe(false);
    expect(matchOver({ p1: 2, p2: 0 }, 2)).toBe(true);
    expect(matchOver({ p1: 1, p2: 1 }, 2)).toBe(false);
    expect(matchOver({ p1: 1, p2: 1 }, 3)).toBe(true); // can't happen in play, but three is the cap
    expect(matchWinner({ p1: 2, p2: 1 })).toBe('p1');
    expect(matchWinner({ p1: 2, p2: 2 })).toBeNull();
  });
  it('the decider is the third round, or any round with both a win away', () => {
    expect(isFinal(1, NO_WINS)).toBe(false);
    expect(isFinal(2, { p1: 1, p2: 0 })).toBe(false);
    expect(isFinal(2, { p1: 1, p2: 1 })).toBe(true);
    expect(isFinal(3, { p1: 1, p2: 1 })).toBe(true);
  });
});

describe('a best-of-three match', () => {
  it('2-0 ends after round two', () => {
    const { r, seen } = play(['p1', 'p1', 'p2']);
    expect(seen.map((s) => s.over)).toEqual([false, true]);
    expect(r.wins).toEqual({ p1: 2, p2: 0 });
    expect(r.winner).toBe('p1');
  });
  it('1-1 goes to a final round, which decides it', () => {
    const { r, seen } = play(['p2', 'p1', 'p2']);
    expect(seen).toEqual([
      { round: 1, over: false, final: false },
      { round: 2, over: false, final: false },
      { round: 3, over: true, final: true },
    ]);
    expect(r.winner).toBe('p2');
    expect(r.wins).toEqual({ p1: 1, p2: 2 });
  });
  it('an even first round makes round two the final', () => {
    const { r, seen } = play([null, 'p1']);
    expect(seen).toEqual([
      { round: 1, over: false, final: false },
      { round: 2, over: true, final: true },
    ]);
    expect(r.winner).toBe('p1');
  });
  it('two even rounds is a drawn match', () => {
    const { r, seen } = play([null, null]);
    expect(seen.at(-1)).toEqual({ round: 2, over: true, final: true });
    expect(r.winner).toBeNull();
  });
  it('an even final round with both on one is a drawn match', () => {
    const { r } = play(['p1', 'p2', null]);
    expect(r.wins).toEqual({ p1: 2, p2: 2 });
    expect(r.winner).toBeNull();
  });
  it('a lead and an even round wins it', () => {
    const { r, seen } = play(['p2', null]);
    expect(seen.at(-1)?.over).toBe(true);
    expect(r.winner).toBe('p2');
  });
  it('reset is a fresh match (rematch)', () => {
    const { r } = play(['p1', 'p1']);
    r.reset();
    expect(r.round).toBe(1);
    expect(r.wins).toEqual(NO_WINS);
    expect(r.final).toBe(false);
    expect(r.end('p2')).toBe(false);
  });
  it('a single-round fight (Training) is over after one', () => {
    const r = new Rounds(1);
    expect(r.final).toBe(false);
    expect(r.end('p2')).toBe(true);
    expect(r.winner).toBe('p2');
    r.reset(1);
    expect(r.end(null)).toBe(true);
    expect(r.winner).toBeNull();
  });
});

describe('rest lines', () => {
  it('a line for every round, the same on both laptops', () => {
    expect(restLine(1)).toBe('Shake out your arms');
    expect(restLine(2)).not.toBe(restLine(1));
    expect(restLine(0)).toBe(restLine(1));
  });
});
