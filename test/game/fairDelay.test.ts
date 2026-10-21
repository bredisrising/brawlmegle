import { describe, expect, test } from 'vitest';
import { FairDelay } from '../../src/game/fairDelay';
import type { Command, PlayerId, Stance } from '../../src/types';

const stance = (player: PlayerId, guard = false): Stance => ({ player, guard, advance: 0, lean: { x: 0, y: 0 }, tracked: true });
const jab = (player: PlayerId): Command => ({ kind: 'attack', player, t: 0, move: 'jab', hand: 'L', height: 'head', speed: 1, windup: 1 });

describe('fair delay', () => {
  test("holds the host player's attacks and stance back by the given ticks, not the other player's or the tells", () => {
    const fair = new FairDelay('p1');
    const out: Command[][] = [];
    const guards: boolean[] = [];
    for (let tick = 0; tick < 6; tick++) {
      const commands: Command[] = tick === 0 ? [jab('p1'), jab('p2'), { kind: 'anticipate', player: 'p1', t: 0, hand: 'L' }] : [];
      const stances = { p1: stance('p1', tick === 0), p2: stance('p2') };
      fair.apply(commands, stances, 3);
      out.push(commands);
      guards.push(stances.p1.guard);
    }
    expect(out[0].map((c) => `${c.kind}:${c.player}`)).toEqual(['attack:p2', 'anticipate:p1']);
    expect(out[3].map((c) => `${c.kind}:${c.player}`)).toEqual(['attack:p1']);
    expect(guards).toEqual([true, true, true, true, false, false]);
  });

  test('turning it off lets everything still held through at once, then passes input straight on', () => {
    const fair = new FairDelay('p1');
    fair.apply([jab('p1')], { p1: stance('p1'), p2: stance('p2') }, 4);
    const released: Command[] = [jab('p1')];
    fair.apply(released, { p1: stance('p1'), p2: stance('p2') }, 0);
    expect(released).toHaveLength(2);
    const now: Command[] = [jab('p1')];
    fair.apply(now, { p1: stance('p1'), p2: stance('p2') }, 0);
    expect(now).toHaveLength(1);
  });
});
