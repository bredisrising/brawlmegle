import { describe, expect, test } from 'vitest';
import { FightEngine } from '../../src/fight/FightEngine';
import { Resolver } from '../../src/fight/Resolver';
import { FIGHT } from '../../src/fight/moves';
import type { AttackMove, Command, FightEvent, PlayerId, Stance } from '../../src/types';
import type { Intent } from '../../src/intent/intents';

const stance = (player: PlayerId, over: Partial<Stance> = {}): Stance => ({ player, guard: false, advance: 0, lean: { x: 0, y: 0 }, tracked: true, ...over });
const attack = (player: PlayerId, move: AttackMove, extra: Partial<Extract<Command, { kind: 'attack' }>> = {}): Command =>
  ({ kind: 'attack', player, t: 0, move, hand: 'R', height: 'head', speed: 1, windup: 1, ...extra });

/** Runs ticks; commands are keyed by tick number. Returns every event. */
function run(engine: FightEngine, ticks: number, script: Record<number, Command[]> = {}, stances?: Partial<Record<PlayerId, Partial<Stance>>>) {
  const events: FightEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    events.push(...engine.step(script[i] ?? [], { p1: stance('p1', stances?.p1), p2: stance('p2', stances?.p2) }));
  }
  return events;
}

/** Puts the fighters at a given distance by letting them drift, then nudging with leans. */
function engineAt(distance: number) {
  const e = new FightEngine();
  // Fighters start 1 m apart and drift toward the preferred distance; walk them to the target.
  for (let i = 0; i < 600 && Math.abs(e.distance() - distance) > 0.02; i++) {
    const lean = e.distance() > distance ? 0.5 : -0.5;
    e.step([], { p1: stance('p1', { advance: lean }), p2: stance('p2', { advance: lean }) });
  }
  return e;
}

describe('fight engine', () => {
  test('a jab in range hits', () => {
    const e = engineAt(0.7);
    const events = run(e, 40, { 0: [attack('p1', 'jab')] });
    const hit = events.find((ev) => ev.type === 'hit');
    expect(hit?.damage).toBe(5);
    expect(e.state('p2').hp).toBe(95);
  });

  test('out of range: whiffs without a lunge, lands with one', () => {
    const e1 = engineAt(1.15);
    expect(run(e1, 40, { 0: [attack('p1', 'cross')] }).map((ev) => ev.type)).toContain('whiff');
    const e2 = engineAt(1.15);
    expect(run(e2, 40, { 0: [attack('p1', 'cross', { lunge: 0.4 })] }).map((ev) => ev.type)).toContain('hit');
  });

  test('guard blocks for chip damage only', () => {
    const e = engineAt(0.7);
    const events = run(e, 40, { 0: [attack('p1', 'cross')] }, { p2: { guard: true } });
    expect(events.find((ev) => ev.type === 'blocked')?.damage).toBe(2);
    expect(e.state('p2').hp).toBe(98);
  });

  test('ducking beats a jab to the head, but an uppercut punishes the duck', () => {
    const duck: Command = { kind: 'defend', player: 'p2', t: 0, move: 'duck' };
    const e1 = engineAt(0.5);
    expect(run(e1, 40, { 0: [attack('p1', 'jab')], 3: [duck] }).map((ev) => ev.type)).toContain('whiff');
    const e2 = engineAt(0.5);
    const up = run(e2, 40, { 0: [attack('p1', 'uppercut')], 10: [duck] }).find((ev) => ev.type === 'counter');
    expect(up?.damage).toBe(Math.round(13 * FIGHT.counterMultiplier));
  });

  test('slipping dodges straights but not hooks', () => {
    const slip: Command = { kind: 'defend', player: 'p2', t: 0, move: 'slip', dir: 'L' };
    expect(run(engineAt(0.6), 40, { 0: [attack('p1', 'jab')], 3: [slip] }).map((ev) => ev.type)).toContain('whiff');
    expect(run(engineAt(0.6), 40, { 0: [attack('p1', 'hook')], 5: [slip] }).map((ev) => ev.type)).toContain('hit');
  });

  test('hitting someone mid-startup is a counter', () => {
    const e = engineAt(0.6);
    // p2 starts a slow cross; p1's jab lands during it.
    const events = run(e, 40, { 0: [attack('p2', 'cross')], 2: [attack('p1', 'jab')] });
    expect(events.find((ev) => ev.attacker === 'p1' && ev.damage)?.type).toBe('counter');
  });

  test('enough hits knock out', () => {
    const e = engineAt(0.6);
    const script: Record<number, Command[]> = {};
    for (let i = 0; i < 40; i++) script[i * 50] = [attack('p1', 'cross', { lunge: 0.3 })];
    const events = run(e, 2000, script);
    expect(events.some((ev) => ev.type === 'ko')).toBe(true);
    expect(e.state('p2').phase).toBe('ko');
  });

  test('deterministic: same inputs, same fight', () => {
    const script = { 0: [attack('p1', 'jab')], 20: [attack('p2', 'hook')], 45: [attack('p1', 'uppercut')] };
    const a = run(engineAt(0.6), 200, script);
    const b = run(engineAt(0.6), 200, script);
    expect(a).toEqual(b);
  });

  test('idle fighters drift to a comfortable distance; leaning in closes it', () => {
    const e = new FightEngine();
    run(e, 400);
    expect(Math.abs(e.distance() - FIGHT.preferredDistance)).toBeLessThan(0.05);
    run(e, 60, {}, { p1: { advance: 1 } });
    expect(e.distance()).toBeLessThan(FIGHT.preferredDistance - 0.2);
  });
});

describe('resolver', () => {
  const strike = (limb: Intent & { kind: 'strike' } extends infer S ? S extends { limb: infer L } ? L : never : never, style: 'straight' | 'hook' | 'upper' | 'knee' | 'kick'): Intent =>
    ({ kind: 'strike', limb, t: 0, onsetT: 0, style, height: 'high', dir: { out: 0, up: 0, fwd: 1 }, speed: 1, windup: 1, reach: 0.5 });
  const r = new Resolver();

  test('legs: knee up close, kick from range', () => {
    expect((r.resolve('p1', [strike('legR', 'kick')], engineAt(0.45))[0] as { move: string }).move).toBe('knee');
    expect((r.resolve('p1', [strike('legR', 'knee')], engineAt(0.9))[0] as { move: string }).move).toBe('kick');
  });

  test('a punch from too far lunges in', () => {
    const c = r.resolve('p1', [strike('armR', 'straight')], engineAt(1.1))[0] as { move: string; lunge: number };
    expect(c.move).toBe('cross');
    expect(c.lunge).toBeGreaterThan(0.2);
  });

  test('an uppercut from far away becomes a straight', () => {
    expect((r.resolve('p1', [strike('armL', 'upper')], engineAt(1.2))[0] as { move: string }).move).toBe('jab');
  });
});
