import type { PlayerId } from '../types';

/**
 * Best of three: a match is first to two round wins, three rounds at most. A K.O. or the clock ends a round; on time
 * more HP wins it, and an even round (equal HP, or both down at once) gives both players a win, so both on two is a
 * drawn match. Pure, so the host's Game and the tests share it; the client laptop just shows the host's count.
 */
export const ROUNDS_TO_WIN = 2;
export const MAX_ROUNDS = 3;

export type Wins = Record<PlayerId, number>;
export const NO_WINS: Wins = { p1: 0, p2: 0 };

/**
 * Between rounds (phase 'break'), in real ms from the round's end: the K.O. / TIME slam with who took it, then a
 * breather (the round count and a rest line), then the next round's ROUND N call and FIGHT (the countdown phase).
 */
export const BREAK = { resultMs: 2800, totalMs: 7000 };

/** Who took the round: the K.O.'s winner, or on time (`ko` null) more HP left; null is an even round. */
export function roundWinner(hp: Record<PlayerId, number>, ko: PlayerId | null): PlayerId | null {
  if (ko) return hp[ko] > 0 ? ko : null; // the finisher went down too: a double K.O.
  return hp.p1 === hp.p2 ? null : hp.p1 > hp.p2 ? 'p1' : 'p2';
}

/** The count after a round (an even round is a win for both). */
export function scoreRound(wins: Wins, winner: PlayerId | null): Wins {
  if (!winner) return { p1: wins.p1 + 1, p2: wins.p2 + 1 };
  return { ...wins, [winner]: wins[winner] + 1 };
}

/** The match is decided: someone has two, or the third round has been played. */
export function matchOver(wins: Wins, round: number): boolean {
  return wins.p1 >= ROUNDS_TO_WIN || wins.p2 >= ROUNDS_TO_WIN || round >= MAX_ROUNDS;
}

/** Who won the match once it's over (null: a draw). */
export function matchWinner(wins: Wins): PlayerId | null {
  return wins.p1 === wins.p2 ? null : wins.p1 > wins.p2 ? 'p1' : 'p2';
}

/** The round about to be fought decides it either way: the last one, or both a win away. */
export function isFinal(round: number, wins: Wins): boolean {
  return round >= MAX_ROUNDS || (round > 1 && wins.p1 === ROUNDS_TO_WIN - 1 && wins.p2 === ROUNDS_TO_WIN - 1);
}

/** What to tell the players between rounds: it's a physical game, so a breather. By the round just played. */
const REST_LINES = ['Shake out your arms', 'Breathe. Drop your shoulders', 'Roll your neck, loosen up', 'Hands up, here it comes'];
export function restLine(round: number): string {
  return REST_LINES[(Math.max(1, round) - 1) % REST_LINES.length];
}

/**
 * One match's rounds, on the laptop running the fight. `best` is 1 for a single-round fight (Training), else best of
 * three.
 */
export class Rounds {
  round = 1;
  wins: Wins = NO_WINS;
  constructor(private best: 1 | 3 = 3) {}

  /** A fresh match. */
  reset(best: 1 | 3 = this.best) {
    this.best = best;
    this.round = 1;
    this.wins = NO_WINS;
  }

  /** The round just ended with `winner` (null: even): counts it, and says whether that decided the match. */
  end(winner: PlayerId | null): boolean {
    this.wins = scoreRound(this.wins, winner);
    return this.over;
  }

  get over() {
    return this.best === 1 ? this.wins.p1 + this.wins.p2 > 0 : matchOver(this.wins, this.round);
  }

  /** Who won the match, once it's over (null: a draw). */
  get winner() {
    return matchWinner(this.wins);
  }

  /** On to the next round. */
  next() {
    this.round++;
  }

  /** The round being fought (or about to be) is the deciding one. */
  get final() {
    return this.best === 3 && isFinal(this.round, this.wins);
  }
}
