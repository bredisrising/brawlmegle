import { describe, expect, test } from 'vitest';
import { FightEngine } from '../../src/fight/FightEngine';
import { Cpu, type CpuLevel } from '../../src/fight/Cpu';
import { FIGHT, MOVES } from '../../src/fight/moves';
import type { AttackMove, Command, FightEvent, PlayerId, Stance } from '../../src/types';

type Driver = (engine: FightEngine, tick: number) => { commands: Command[]; stance: Stance };
type Logged = FightEvent & { tick: number; defenderEvading: boolean };

const stance = (player: PlayerId, over: Partial<Stance> = {}): Stance => ({ player, guard: false, advance: 0, lean: { x: 0, y: 0 }, tracked: true, ...over });
const cpu = (player: PlayerId, level: CpuLevel, seed: number): Driver => {
  const c = new Cpu(player, level, seed);
  return (e, tick) => c.think(e, tick);
};
/** Stands there: no attacks, no guard, no lean. */
const passive = (player: PlayerId): Driver => () => ({ commands: [], stance: stance(player) });
/** Walks in and throws `moves` in turn every `every` ticks, lunging like the resolver does. No defense. */
const attacker = (player: PlayerId, every: number, moves: AttackMove[]): Driver => {
  let n = 0;
  return (e, tick) => {
    const d = e.distance();
    const commands: Command[] = [];
    if (tick % every === 0 && e.state(player).phase === 'idle') {
      const move = moves[n++ % moves.length];
      const reach = MOVES[move].range * 0.9;
      commands.push({ kind: 'attack', player, t: tick, move, hand: 'L', height: 'head', speed: 1, windup: 1, lunge: d > reach ? Math.min(0.4, d - reach) : 0 });
    }
    return { commands, stance: stance(player, { advance: d > 0.75 ? 0.6 : 0 }) };
  };
};

/** p1 vs p2 at 60 Hz until a K.O. or `seconds` run out. */
function fight(p1: Driver, p2: Driver, seconds = 120) {
  const e = new FightEngine();
  const events: Logged[] = [];
  const commands: { tick: number; command: Command }[] = [];
  const minStamina: Record<PlayerId, number> = { p1: FIGHT.maxStamina, p2: FIGHT.maxStamina };
  let tick = 0;
  for (; tick < seconds * 60; tick++) {
    const a = p1(e, tick);
    const b = p2(e, tick);
    for (const command of [...a.commands, ...b.commands]) commands.push({ tick, command });
    for (const ev of e.step([...a.commands, ...b.commands], { p1: a.stance, p2: b.stance })) {
      events.push({ ...ev, tick, defenderEvading: e.evading(ev.attacker === 'p1' ? 'p2' : 'p1') !== null });
    }
    minStamina.p1 = Math.min(minStamina.p1, e.state('p1').stamina);
    minStamina.p2 = Math.min(minStamina.p2, e.state('p2').stamina);
    if (events.some((ev) => ev.type === 'ko')) break;
  }
  return { events, commands, seconds: tick / 60, winner: events.find((ev) => ev.type === 'ko')?.attacker ?? null, minStamina };
}

describe('cpu opponent', () => {
  test('deterministic: same seed, same fight; another seed, another fight', () => {
    const a = fight(attacker('p1', 45, ['jab', 'cross']), cpu('p2', 'normal', 7), 30);
    const b = fight(attacker('p1', 45, ['jab', 'cross']), cpu('p2', 'normal', 7), 30);
    expect(a.events).toEqual(b.events);
    expect(a.commands).toEqual(b.commands);
    const mirror1 = fight(cpu('p1', 'hard', 3), cpu('p2', 'easy', 4));
    const mirror2 = fight(cpu('p1', 'hard', 3), cpu('p2', 'easy', 4));
    expect(mirror1.events).toEqual(mirror2.events);
    const other = fight(attacker('p1', 45, ['jab', 'cross']), cpu('p2', 'normal', 8), 30);
    expect(other.events).not.toEqual(a.events);
  });

  test.each(['easy', 'normal', 'hard'] as CpuLevel[])('%s beats a passive player by K.O. without gassing out', (level) => {
    for (const seed of [1, 2, 3]) {
      const r = fight(passive('p1'), cpu('p2', level, seed));
      expect(r.winner).toBe('p2');
      expect(r.seconds).toBeLessThan(level === 'easy' ? 60 : 40);
      expect(r.minStamina.p2).toBeGreaterThanOrEqual(FIGHT.gassedBelow);
    }
  });

  test('telegraphs: every attack follows an anticipate, or continues a combo', () => {
    const r = fight(passive('p1'), cpu('p2', 'normal', 5));
    const tells = r.commands.filter((c) => c.command.kind === 'anticipate').map((c) => c.tick);
    const starts = r.events.filter((ev) => ev.type === 'startup' && ev.attacker === 'p2').map((ev) => ev.tick);
    expect(starts.length).toBeGreaterThan(5);
    starts.forEach((tick, i) => {
      const told = tells.some((t) => t < tick && tick - t <= 120 && (i === 0 || t > starts[i - 1]));
      const combo = i > 0 && tick - starts[i - 1] <= 40;
      expect(told || combo).toBe(true);
    });
    // Never spams: real breaks between attack sequences.
    const sequences = starts.filter((tick, i) => i === 0 || tick - starts[i - 1] > 40);
    sequences.slice(1).forEach((tick, i) => expect(tick - sequences[i]).toBeGreaterThanOrEqual(60));
  });

  test('blocks or evades some, but not all, of a jabber’s jabs', () => {
    for (const level of ['easy', 'normal', 'hard'] as CpuLevel[]) {
      let defended = 0;
      let landed = 0;
      for (const seed of [1, 2, 3]) {
        const jabs = fight(attacker('p1', 45, ['jab']), cpu('p2', level, seed), 30).events.filter((ev) => ev.attacker === 'p1');
        defended += jabs.filter((ev) => ev.type === 'blocked' || (ev.type === 'whiff' && ev.defenderEvading)).length;
        landed += jabs.filter((ev) => ev.type === 'hit' || ev.type === 'counter').length;
      }
      expect(defended, level).toBeGreaterThan(0);
      expect(landed, level).toBeGreaterThan(0);
    }
  });

  test('easy loses to an aggressive player more than hard does', () => {
    const losses = (level: CpuLevel) =>
      [1, 2, 3, 4].filter((seed) => fight(attacker('p1', 40, ['jab', 'cross', 'jab', 'hook']), cpu('p2', level, seed)).winner !== 'p2').length;
    const easy = losses('easy');
    const hard = losses('hard');
    expect(easy).toBeGreaterThan(hard);
    expect(easy).toBeGreaterThanOrEqual(3);
    expect(hard).toBeLessThanOrEqual(1);
  });

  test('punishes whiffs: big misses get countered during recovery', () => {
    // p1 hovers at ~1 m throwing unlunged crosses that can't reach.
    const whiffer: Driver = (e, tick) => {
      const d = e.distance();
      const commands: Command[] = tick % 70 === 0 && e.state('p1').phase === 'idle'
        ? [{ kind: 'attack', player: 'p1', t: tick, move: 'cross', hand: 'R', height: 'head', speed: 1, windup: 1, lunge: 0 }]
        : [];
      return { commands, stance: stance('p1', { advance: d > 1.0 ? 0.5 : d < 0.95 ? -0.5 : 0 }) };
    };
    const counters = fight(whiffer, cpu('p2', 'normal', 1), 30).events.filter((ev) => ev.attacker === 'p2' && ev.type === 'counter');
    expect(counters.length).toBeGreaterThan(2);
  });

  test('cpu vs cpu always ends in a K.O.', () => {
    const pairs: [CpuLevel, CpuLevel][] = [['easy', 'easy'], ['normal', 'normal'], ['hard', 'hard'], ['easy', 'hard']];
    for (const [a, b] of pairs) {
      for (const seed of [1, 2]) {
        const r = fight(cpu('p1', a, seed), cpu('p2', b, seed + 50), 180);
        expect(r.winner, `${a} vs ${b} seed ${seed}`).not.toBeNull();
        expect(Math.min(r.minStamina.p1, r.minStamina.p2)).toBeGreaterThanOrEqual(FIGHT.gassedBelow);
      }
    }
  });
});
