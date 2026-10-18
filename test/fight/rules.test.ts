// Rule edge cases: simultaneous swings, bad command numbers, buffering through hit-stop.
import { describe, expect, test } from 'vitest';
import { FightEngine } from '../../src/fight/FightEngine';
import type { AttackMove, Command, FightEvent, PlayerId, Stance } from '../../src/types';

const stance = (player: PlayerId, over: Partial<Stance> = {}): Stance => ({ player, guard: false, advance: 0, lean: { x: 0, y: 0 }, tracked: true, ...over });
const attack = (player: PlayerId, move: AttackMove, extra: Partial<Extract<Command, { kind: 'attack' }>> = {}): Command =>
  ({ kind: 'attack', player, t: 0, move, hand: 'R', height: 'head', speed: 1, windup: 1, ...extra });

function run(engine: FightEngine, ticks: number, script: Record<number, Command[]> = {}) {
  const events: FightEvent[] = [];
  for (let i = 0; i < ticks; i++) events.push(...engine.step(script[i] ?? [], { p1: stance('p1'), p2: stance('p2') }));
  return events;
}

function engineAt(distance: number) {
  const e = new FightEngine();
  for (let i = 0; i < 600 && Math.abs(e.distance() - distance) > 0.02; i++) {
    const lean = e.distance() > distance ? 0.5 : -0.5;
    e.step([], { p1: stance('p1', { advance: lean }), p2: stance('p2', { advance: lean }) });
  }
  return e;
}

describe('fight rules', () => {
  test('a NaN or missing speed/windup/lunge never corrupts HP or positions', () => {
    const e = engineAt(0.7);
    run(e, 40, { 0: [attack('p1', 'jab', { speed: NaN, windup: Infinity, lunge: NaN })] });
    expect(Number.isFinite(e.state('p2').hp)).toBe(true);
    expect(e.state('p2').hp).toBeLessThan(100);
    expect(Number.isFinite(e.distance())).toBe(true);
  });

  test('identical swings on the same tick trade (no P1 priority)', () => {
    const e = engineAt(0.7);
    const events = run(e, 40, { 0: [attack('p1', 'jab'), attack('p2', 'jab')] });
    const landed = events.filter((ev) => ev.type === 'hit' || ev.type === 'counter').map((ev) => ev.attacker).sort();
    expect(landed).toEqual(['p1', 'p2']);
    expect(e.state('p1').hp).toBe(e.state('p2').hp);
  });
});
