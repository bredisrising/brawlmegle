import { describe, expect, it } from 'vitest';
import { BOTS, pickBot } from '../../src/game/bots';

const names = (rating: number | null, last: string | null = null) =>
  new Set(Array.from({ length: 200 }, () => pickBot(rating, last).fighter.name));

describe('matchmaking bots', () => {
  it('gets easier to harder with its rating', () => {
    expect(BOTS.map((b) => b.level)).toEqual(['easy', 'normal', 'hard']);
    expect(BOTS.map((b) => b.rating)).toEqual([...BOTS.map((b) => b.rating)].sort((a, b) => a - b));
  });

  it('gives a player still placing one of the gentler bots', () => {
    expect(names(null)).toEqual(new Set(['Tin Can Tony', 'Gym Rat Gary']));
  });

  it('picks bots near the player rating, the closest when none is near', () => {
    expect(names(1000)).toEqual(new Set(['Tin Can Tony', 'Gym Rat Gary']));
    expect(names(1150)).toEqual(new Set(['Gym Rat Gary', 'Nana Knuckles']));
    expect(names(1600)).toEqual(new Set(['Nana Knuckles']));
    expect(names(600)).toEqual(new Set(['Tin Can Tony']));
  });

  it("doesn't repeat the last bot when there's another fair one", () => {
    expect(names(1000, 'bot-tony')).toEqual(new Set(['Gym Rat Gary']));
    expect(names(1600, 'bot-nana')).toEqual(new Set(['Nana Knuckles']));
  });
});
