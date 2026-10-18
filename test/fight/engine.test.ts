import { describe, expect, test } from 'vitest';
import { FightEngine } from '../../src/fight/FightEngine';
import { Resolver } from '../../src/fight/Resolver';
import { FIGHT, MOVES } from '../../src/fight/moves';
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
    ({ kind: 'strike', limb, t: 0, onsetT: 0, style, height: 'high', dir: { out: 0, up: 0, fwd: 1 }, speed: 1, windup: 1, reach: 0.5, rawSpeed: 4 });
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

describe('combos: fast punches all come out', () => {
  const starts = (events: FightEvent[], player: PlayerId = 'p1') =>
    events.filter((ev) => ev.type === 'startup' && ev.attacker === player).map((ev) => ev.move);

  test('jab-cross-hook thrown 150 ms apart all happen, in order', () => {
    const e = engineAt(0.7);
    const events = run(e, 120, {
      0: [attack('p1', 'jab', { hand: 'L', autoLunge: true })],
      9: [attack('p1', 'cross', { autoLunge: true })],
      18: [attack('p1', 'hook', { hand: 'L', autoLunge: true })],
    });
    expect(starts(events)).toEqual(['jab', 'cross', 'hook']);
    expect(events.filter((ev) => ev.attacker === 'p1' && (ev.type === 'hit' || ev.type === 'counter')).length).toBe(3);
  });

  test('a punch that connects chains into the next one without waiting out its recovery', () => {
    const e = engineAt(0.7);
    const events: { tick: number; ev: FightEvent }[] = [];
    for (let i = 0; i < 80; i++) {
      const cmds = i === 0 ? [attack('p1', 'jab', { hand: 'L' })] : i === 5 ? [attack('p1', 'cross')] : [];
      for (const ev of e.step(cmds, { p1: stance('p1'), p2: stance('p2', { guard: true }) })) events.push({ tick: i, ev });
    }
    const cross = events.find((x) => x.ev.type === 'startup' && x.ev.move === 'cross');
    // The cross starts as the jab's recovery begins (+ block hit-stop), not after its recovery frames.
    expect(cross!.tick).toBeLessThan(MOVES.jab.startup + MOVES.jab.active + 3 + 4);
  });

  test('a whiffed punch can only chain from halfway through its recovery', () => {
    const e = engineAt(1.3); // far out of range: everything whiffs
    const events: { tick: number; ev: FightEvent }[] = [];
    for (let i = 0; i < 80; i++) {
      const cmds = i === 0 ? [attack('p1', 'cross')] : i === 5 ? [attack('p1', 'jab', { hand: 'L' })] : [];
      for (const ev of e.step(cmds, { p1: stance('p1'), p2: stance('p2') })) events.push({ tick: i, ev });
    }
    const jab = events.find((x) => x.ev.type === 'startup' && x.ev.move === 'jab');
    // No chain before halfway through the cross's recovery.
    expect(jab!.tick).toBeGreaterThanOrEqual(MOVES.cross.startup + MOVES.cross.active + MOVES.cross.recovery / 2);
  });

  test('a stale input expires instead of firing long after the player threw it', () => {
    // A whiffed uppercut only chains from halfway through its long recovery: a jab thrown on its first frame has
    // waited past its buffer by then, so it's dropped rather than coming out half a second late.
    const e = engineAt(1.3);
    const events = run(e, 90, { 0: [attack('p1', 'uppercut')], 1: [attack('p1', 'jab', { hand: 'L' })] });
    expect(starts(events)).toEqual(['uppercut']);
  });

  test('kicks do not chain', () => {
    const e = engineAt(0.9);
    const events: { tick: number; ev: FightEvent }[] = [];
    for (let i = 0; i < 90; i++) {
      const cmds = i === 0 ? [attack('p1', 'kick')] : i === 30 ? [attack('p1', 'jab', { hand: 'L' })] : [];
      for (const ev of e.step(cmds, { p1: stance('p1'), p2: stance('p2', { guard: true }) })) events.push({ tick: i, ev });
    }
    const jab = events.find((x) => x.ev.type === 'startup' && x.ev.move === 'jab');
    expect(jab).toBeDefined();
    // The kick's whole recovery (plus block hit-stop) before the jab can start.
    expect(jab!.tick).toBeGreaterThanOrEqual(MOVES.kick.startup + MOVES.kick.active + MOVES.kick.recovery);
  });
});

describe('head start: the wind-up already on screen counts toward startup', () => {
  const activeAt = (cmd: Command) => {
    const e = engineAt(0.7);
    for (let i = 0; i < 40; i++) {
      e.step(i === 0 ? [cmd] : [], { p1: stance('p1'), p2: stance('p2') });
      if (e.state('p1').phase === 'active') return i;
    }
    return -1;
  };

  test('a cross the reader saw start 100 ms ago lands 6 frames sooner, a jab no sooner than the floor', () => {
    expect(activeAt(attack('p1', 'cross', { headStart: 6 }))).toBe(activeAt(attack('p1', 'cross')) - 6);
    expect(activeAt(attack('p1', 'jab', { hand: 'L', headStart: 6 }))).toBe(FIGHT.minStartup - 1);
  });

  test('the head start is capped, and junk values are ignored', () => {
    expect(activeAt(attack('p1', 'kick', { headStart: 60 }))).toBe(activeAt(attack('p1', 'kick')) - FIGHT.maxHeadStart);
    expect(activeAt(attack('p1', 'cross', { headStart: Number.NaN }))).toBe(activeAt(attack('p1', 'cross')));
  });
});

describe('super meter and fireball', () => {
  /** Lands jabs until p1's meter is full. */
  function charged() {
    const e = engineAt(0.7);
    for (let n = 0; n < 20 && (e.state('p1').meter ?? 0) < FIGHT.maxMeter; n++) run(e, 40, { 0: [attack('p1', 'jab', { hand: 'L' })] });
    return e;
  }
  const fireball = attack('p1', 'fireball');

  test('landing hits fills the meter; a fireball without a full meter does nothing', () => {
    const e = engineAt(0.7);
    expect(run(e, 60, { 0: [fireball] }).filter((ev) => ev.type === 'startup')).toHaveLength(0);
    const full = charged();
    expect(full.state('p1').meter).toBe(FIGHT.maxMeter);
  });

  test('a full meter throws a fireball that flies across and hits; the meter is spent', () => {
    const e = charged();
    const events = run(e, 120, { 0: [fireball] });
    expect(events.find((ev) => ev.type === 'startup')?.move).toBe('fireball');
    expect(e.state('p1').meter).toBeLessThan(FIGHT.maxMeter);
    const hit = events.find((ev) => ev.type === 'hit' && ev.move === 'fireball');
    expect(hit?.damage).toBeGreaterThan(10);
  });

  test('it flies: there is a projectile in the air between the throw and the hit', () => {
    const e = charged();
    run(e, MOVES.fireball.startup + 2, { 0: [fireball] });
    const shots = e.projectiles();
    expect(shots).toHaveLength(1);
    expect(shots[0].owner).toBe('p1');
  });

  test('a guard blocks it for chip; a duck lets it pass over', () => {
    const blocked = charged();
    const evB = run(blocked, 120, { 0: [fireball] }, { p2: { guard: true } });
    expect(evB.find((ev) => ev.move === 'fireball' && ev.type === 'blocked')).toBeDefined();
    // Duck as it gets close.
    const ducked = charged();
    const duck: Command = { kind: 'defend', player: 'p2', t: 0, move: 'duck' };
    const evD: FightEvent[] = [];
    let ducking = false;
    for (let i = 0; i < 120; i++) {
      const shot = ducked.projectiles()[0];
      const close = !ducking && shot && Math.abs(ducked.state('p2').x - shot.x) < 0.3;
      if (close) ducking = true;
      evD.push(...ducked.step(i === 0 ? [fireball] : close ? [duck] : [], { p1: stance('p1'), p2: stance('p2') }));
    }
    expect(ducking).toBe(true);
    expect(evD.find((ev) => ev.move === 'fireball' && (ev.type === 'hit' || ev.type === 'blocked'))).toBeUndefined();
  });
});

describe('mashing: flailing gets slower and weaker; a clean hit resets it', () => {
  /** Ticks from a jab's command to its active frame, after `whiffs` jabs thrown into the air in a row. */
  function jabAfterWhiffs(whiffs: number, land = false) {
    const e = engineAt(land ? 0.7 : 1.4);
    // Landing: the dummy blocks (it connects, and the small blockstun push keeps it in range).
    const p2 = stance('p2', { guard: land });
    const startOf = () => {
      for (let i = 0; i < 60; i++) {
        e.step(i === 0 ? [attack('p1', 'jab', { hand: 'L' })] : [], { p1: stance('p1'), p2 });
        if (e.state('p1').phase === 'active') return i;
      }
      return -1;
    };
    const untilIdle = () => {
      for (let i = 0; i < 90 && e.state('p1').phase !== 'idle'; i++) e.step([], { p1: stance('p1'), p2 });
    };
    for (let n = 0; n < whiffs; n++) {
      startOf();
      untilIdle(); // free again, still well inside the mash window
    }
    untilIdle();
    return startOf();
  }

  test('each whiffed swing in quick succession adds startup, up to a cap', () => {
    const fresh = jabAfterWhiffs(0);
    expect(jabAfterWhiffs(2)).toBe(fresh + 2 * FIGHT.mashStartup);
    // Capped (five in a row, not more: by then stamina would run out and tiredness adds its own startup).
    expect(jabAfterWhiffs(5)).toBe(fresh + FIGHT.mashMax * FIGHT.mashStartup);
  });

  test('punches that connect never build it up', () => {
    expect(jabAfterWhiffs(4, true)).toBe(jabAfterWhiffs(0, true));
  });
});
