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

describe('heavies and parries', () => {
  // A heavy cross (big wind-up) at 0.6 m: startup + FIGHT.heavyStartup frames, then it lands.
  const heavyAt = MOVES.cross.startup + FIGHT.heavyStartup;
  const guardFrom = (from: number) => (i: number) => i >= from;
  function play(cmd: Command, guard: (tick: number) => boolean) {
    const e = engineAt(0.6);
    const events: FightEvent[] = [];
    for (let i = 0; i < 80; i++) events.push(...e.step(i === 0 ? [cmd] : [], { p1: stance('p1'), p2: stance('p2', { guard: guard(i) }) }));
    return { e, events };
  }

  test('a big wind-up is a heavy: slower, and it hits harder', () => {
    const normal = play(attack('p1', 'cross'), () => false).events.find((ev) => ev.type === 'hit')!;
    const heavy = play(attack('p1', 'cross', { windup: 1.3, heavy: true }), () => false).events.find((ev) => ev.type === 'hit')!;
    expect(heavy.damage!).toBeGreaterThan(normal.damage!);
    expect(heavy.t).toBeGreaterThan(normal.t);
  });

  test('a guard raised just before a heavy lands parries it: no damage, the attacker reels', () => {
    const { e, events } = play(attack('p1', 'cross', { windup: 1.3, heavy: true }), guardFrom(heavyAt - 4));
    expect(events.map((ev) => ev.type)).toContain('parry');
    expect(e.state('p2').hp).toBe(FIGHT.maxHp);
    expect(events.some((ev) => ev.type === 'hit' || ev.type === 'blocked')).toBe(false);
  });

  test('a guard held up long before only blocks a heavy, and a normal punch is never parried', () => {
    expect(play(attack('p1', 'cross', { windup: 1.3, heavy: true }), () => true).events.map((ev) => ev.type)).toContain('blocked');
    const normal = play(attack('p1', 'cross'), guardFrom(MOVES.cross.startup - 4)).events.map((ev) => ev.type);
    expect(normal).toContain('blocked');
    expect(normal).not.toContain('parry');
  });
});

describe('restyle: the reader saw another punch at the peak', () => {
  const restyle = (move: AttackMove, hand: 'L' | 'R' = 'R'): Command => ({ kind: 'restyle', player: 'p1', t: 0, hand, move });

  test('a cross still in startup becomes a hook, keeping the frames it used', () => {
    const e = engineAt(0.6);
    const events = run(e, 60, { 0: [attack('p1', 'cross')], 3: [restyle('hook')] });
    expect(events.find((ev) => ev.type === 'hit')?.move).toBe('hook');
    expect(events.filter((ev) => ev.type === 'startup')).toHaveLength(1);
  });

  test('too late once the punch is active, and the other hand does nothing', () => {
    const late = engineAt(0.6);
    const cross = MOVES.cross.startup;
    expect(run(late, 60, { 0: [attack('p1', 'cross')], [cross + 1]: [restyle('hook')] }).find((ev) => ev.type === 'hit')?.move).toBe('cross');
    const other = engineAt(0.6);
    expect(run(other, 60, { 0: [attack('p1', 'cross')], 3: [restyle('hook', 'L')] }).find((ev) => ev.type === 'hit')?.move).toBe('cross');
  });

  test('the resolver turns a restyle intent into the punch it now is', () => {
    const e = engineAt(0.6);
    const intent: Intent = { kind: 'restyle', limb: 'armR', t: 0, onsetT: 0, style: 'hook', height: 'high' };
    expect(new Resolver().resolve('p1', [intent], e)).toEqual([{ kind: 'restyle', player: 'p1', t: 0, hand: 'R', move: 'hook' }]);
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
      for (const ev of e.step(cmds, { p1: stance('p1'), p2: stance('p2') })) events.push({ tick: i, ev });
    }
    const hit = events.find((x) => x.ev.type === 'hit');
    const cross = events.find((x) => x.ev.type === 'startup' && x.ev.move === 'cross');
    // The cross starts as the jab's recovery begins (+ the hit's hit-stop), not after its recovery frames.
    expect(cross!.tick).toBeLessThan(MOVES.jab.startup + MOVES.jab.active + (hit!.ev.hitstopFrames ?? 0) + 4);
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
      // The kick breaks the guard (a hit, with the longer hit-stop), so the jab comes a little later to stay buffered.
      const cmds = i === 0 ? [attack('p1', 'kick')] : i === 40 ? [attack('p1', 'jab', { hand: 'L' })] : [];
      for (const ev of e.step(cmds, { p1: stance('p1'), p2: stance('p2', { guard: true }) })) events.push({ tick: i, ev });
    }
    const jab = events.find((x) => x.ev.type === 'startup' && x.ev.move === 'jab');
    expect(jab).toBeDefined();
    // The kick's whole recovery (plus hit-stop) before the jab can start.
    expect(jab!.tick).toBeGreaterThanOrEqual(MOVES.kick.startup + MOVES.kick.active + MOVES.kick.recovery);
  });
});

describe('read punches land at the confirm; the wind-up already on screen counts for the rest', () => {
  const activeAt = (cmd: Command) => {
    const e = engineAt(0.7);
    for (let i = 0; i < 40; i++) {
      e.step(i === 0 ? [cmd] : [], { p1: stance('p1'), p2: stance('p2') });
      if (e.state('p1').phase === 'active') return i;
    }
    return -1;
  };

  test('a punch the reader confirmed is active FIGHT.readStartup frames on, whatever the move; a heavy still waits', () => {
    for (const move of ['jab', 'cross', 'hook', 'uppercut'] as const) expect(activeAt(attack('p1', move, { headStart: 1 }))).toBe(FIGHT.readStartup - 1);
    expect(activeAt(attack('p1', 'cross', { headStart: 1, heavy: true, windup: 1.3 }))).toBe(FIGHT.readStartup - 1 + FIGHT.heavyStartup);
    // Without a head start (the CPU) it plays its whole startup.
    expect(activeAt(attack('p1', 'cross'))).toBe(MOVES.cross.startup - 1);
  });

  test('legs keep their startup less the head start, capped, and junk values are ignored', () => {
    expect(activeAt(attack('p1', 'kick', { headStart: 60 }))).toBe(activeAt(attack('p1', 'kick')) - FIGHT.maxHeadStart);
    expect(activeAt(attack('p1', 'cross', { headStart: Number.NaN }))).toBe(activeAt(attack('p1', 'cross')));
  });

  test('a restyle before a read punch is active keeps its startup; after, it is too late', () => {
    const restyle: Command = { kind: 'restyle', player: 'p1', t: 0, hand: 'L', move: 'hook' };
    const jab = attack('p1', 'jab', { hand: 'L', headStart: 1 });
    expect(activeAt(jab)).toBe(FIGHT.readStartup - 1);
    const early = run(engineAt(0.6), 40, { 0: [jab, restyle] });
    expect(early.find((ev) => ev.type === 'hit')?.move).toBe('hook');
    const late = run(engineAt(0.6), 40, { 0: [jab], [FIGHT.readStartup]: [restyle] });
    expect(late.find((ev) => ev.type === 'hit')?.move).toBe('jab');
  });
});

describe('wind-up tells', () => {
  test('a tell shows in the state while the fighter is free, and goes once the swing starts', () => {
    const e = engineAt(0.7);
    run(e, 1, { 0: [{ kind: 'anticipate', player: 'p1', t: 0, hand: 'R' }] });
    expect(e.state('p1').tell).toBe(0);
    run(e, 3);
    expect(e.state('p1').tell).toBe(3);
    run(e, 1, { 0: [attack('p1', 'cross', { headStart: 1 })] });
    expect(e.state('p1').tell).toBeUndefined();
    const idle = engineAt(0.7);
    run(idle, FIGHT.tellFrames + 2, { 0: [{ kind: 'anticipate', player: 'p1', t: 0, hand: 'R' }] });
    expect(idle.state('p1').tell).toBeUndefined();
  });

  test('a tell never changes the fight', () => {
    const a = engineAt(0.7), b = engineAt(0.7);
    const told = run(a, 60, { 0: [{ kind: 'anticipate', player: 'p1', t: 0, hand: 'R' }], 5: [attack('p1', 'cross', { headStart: 1 })] });
    const plain = run(b, 60, { 5: [attack('p1', 'cross', { headStart: 1 })] });
    expect(told).toEqual(plain);
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
    // Landing: the dummy takes the hits (healed between swings so it never goes down).
    const p2 = stance('p2');
    const startOf = () => {
      for (let i = 0; i < 60; i++) {
        e.step(i === 0 ? [attack('p1', 'jab', { hand: 'L', autoLunge: land })] : [], { p1: stance('p1'), p2 });
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

describe('blocking: hitting a guard costs the attacker', () => {
  test("a blocked punch doesn't chain: the next one waits out a longer recovery", () => {
    const e = engineAt(0.7);
    const events: { tick: number; ev: FightEvent }[] = [];
    for (let i = 0; i < 90; i++) {
      const cmds = i === 0 ? [attack('p1', 'jab', { hand: 'L' })] : i === 5 ? [attack('p1', 'cross')] : [];
      for (const ev of e.step(cmds, { p1: stance('p1'), p2: stance('p2', { guard: true }) })) events.push({ tick: i, ev });
    }
    const blocked = events.find((x) => x.ev.type === 'blocked')!;
    const cross = events.find((x) => x.ev.type === 'startup' && x.ev.move === 'cross')!;
    expect(cross.tick - blocked.tick).toBeGreaterThanOrEqual(MOVES.jab.recovery + FIGHT.blockRecovery);
  });

  test('after a blocked punch the blocker is free first: letting go to swing back beats the follow-up', () => {
    const e = engineAt(0.7);
    const events: { tick: number; ev: FightEvent }[] = [];
    let guard = true;
    let swung = false;
    for (let i = 0; i < 90; i++) {
      // P1 spams: a jab, then another queued right behind it. P2 blocks the first, then drops the guard and jabs
      // the moment blockstun ends.
      const cmds = i === 0 ? [attack('p1', 'jab', { hand: 'L' })] : i === 4 ? [attack('p1', 'jab', { hand: 'L' })] : [];
      if (!swung && !guard && e.state('p2').phase === 'idle') {
        cmds.push(attack('p2', 'jab', { hand: 'L' }));
        swung = true;
      }
      for (const ev of e.step(cmds, { p1: stance('p1'), p2: stance('p2', { guard }) })) {
        events.push({ tick: i, ev });
        if (ev.type === 'blocked') guard = false;
      }
    }
    const p2Hit = events.find((x) => (x.ev.type === 'hit' || x.ev.type === 'counter') && x.ev.attacker === 'p2');
    const p1Hit = events.find((x) => (x.ev.type === 'hit' || x.ev.type === 'counter') && x.ev.attacker === 'p1');
    expect(p2Hit).toBeDefined();
    // Caught in the attacker's longer recovery: a counter hit, and the spammer's follow-up never lands first.
    expect(p2Hit!.ev.type).toBe('counter');
    if (p1Hit) expect(p1Hit.tick).toBeGreaterThan(p2Hit!.tick);
  });

  test('swinging into a guard over and over builds the mash penalty and drains stamina', () => {
    const e = engineAt(0.7);
    const startups: number[] = [];
    const stamina0 = e.state('p1').stamina;
    for (let n = 0; n < 4; n++) {
      let started = -1;
      for (let i = 0; i < 80; i++) {
        e.step(i === 0 ? [attack('p1', 'jab', { hand: 'L', autoLunge: true })] : [], { p1: stance('p1'), p2: stance('p2', { guard: true }) });
        if (started < 0 && e.state('p1').phase === 'active') started = i;
        if (started >= 0 && e.state('p1').phase === 'idle') break;
      }
      startups.push(started);
    }
    expect(startups[3]).toBeGreaterThan(startups[0]);
    expect(e.state('p1').stamina).toBeLessThan(stamina0 - 4 * (MOVES.jab.stamina + FIGHT.blockCost) + 10);
  });
});

describe('kick breaks guard', () => {
  test('a kick into a guard hits for full damage (guard break); a punch into a guard is still blocked', () => {
    const kick = run(engineAt(0.9), 60, { 0: [attack('p1', 'kick', { autoLunge: true })] }, { p2: { guard: true } });
    const hit = kick.find((e) => e.type === 'hit' || e.type === 'counter');
    expect(hit?.guardBreak).toBe(true);
    expect(hit?.damage).toBeGreaterThanOrEqual(MOVES.kick.damage - 1);
    expect(kick.some((e) => e.type === 'blocked')).toBe(false);

    const knee = run(engineAt(0.45), 60, { 0: [attack('p1', 'knee', { autoLunge: true })] }, { p2: { guard: true } });
    expect(knee.find((e) => e.type === 'hit' || e.type === 'counter')?.guardBreak).toBe(true);

    const jab = run(engineAt(0.7), 40, { 0: [attack('p1', 'jab', { hand: 'L' })] }, { p2: { guard: true } });
    expect(jab.some((e) => e.type === 'blocked')).toBe(true);
    expect(jab.some((e) => e.guardBreak)).toBe(false);
  });

  test('the kick is slow enough to punch out of: a jab thrown after it starts lands first, as a counter', () => {
    const events = run(engineAt(0.8), 60, { 0: [attack('p1', 'kick', { autoLunge: true })], 3: [attack('p2', 'jab', { hand: 'L', autoLunge: true })] });
    const first = events.find((e) => e.type === 'hit' || e.type === 'counter');
    expect(first?.attacker).toBe('p2');
    expect(first?.type).toBe('counter');
  });
});

describe('the guard wears out', () => {
  test('holding a guard costs nothing, but enough blocked punches crush it: a stagger, then no blocking until it refills', () => {
    const e = engineAt(0.7);
    run(e, 600, {}, { p2: { guard: true } });
    expect(e.state('p2').guard).toBe(FIGHT.guardMax);
    const jabs: Record<number, Command[]> = {};
    for (let i = 0; i < Math.ceil(FIGHT.guardMax / FIGHT.guardPerBlock) + 2; i++) jabs[i * 40] = [attack('p1', 'jab', { hand: 'L', autoLunge: true })];
    const held = run(e, 40 * (Math.ceil(FIGHT.guardMax / FIGHT.guardPerBlock) + 2), jabs, { p2: { guard: true } });
    const crush = held.find((ev) => ev.type === 'guardCrush');
    expect(crush?.attacker).toBe('p1');
    expect(e.state('p2').guardLock).toBeGreaterThan(0);
    // Guard still held up, but it's crushed: the jab lands.
    const jab = run(e, 40, { 0: [attack('p1', 'jab', { hand: 'L', autoLunge: true })] }, { p2: { guard: true } });
    expect(jab.some((ev) => ev.type === 'hit' || ev.type === 'counter')).toBe(true);
    expect(jab.some((ev) => ev.type === 'blocked')).toBe(false);
    // Once the lockout runs out it's back, full.
    run(e, Math.round(FIGHT.guardLockout * 60), {}, {});
    expect(e.state('p2').guardLock).toBe(0);
    expect(e.state('p2').guard).toBeGreaterThan(90);
    const later = run(e, 40, { 0: [attack('p1', 'jab', { hand: 'L', autoLunge: true })] }, { p2: { guard: true } });
    expect(later.some((ev) => ev.type === 'blocked')).toBe(true);
  });

  test('a guard raised just after a punch starts calls the punch off (it was the hands going up), one already up does not', () => {
    const raised = engineAt(0.7);
    const events: FightEvent[] = [];
    for (let i = 0; i < 40; i++) events.push(...raised.step(i === 0 ? [attack('p1', 'cross')] : [], { p1: stance('p1', { guard: i >= 4 }), p2: stance('p2') }));
    expect(events.some((ev) => ev.type === 'hit')).toBe(false);
    expect(raised.state('p1').stamina).toBe(FIGHT.maxStamina);
    const fromGuard = engineAt(0.7);
    const out: FightEvent[] = [];
    for (let i = 0; i < 40; i++) out.push(...fromGuard.step(i === 5 ? [attack('p1', 'cross')] : [], { p1: stance('p1', { guard: i < 8 }), p2: stance('p2') }));
    expect(out.some((ev) => ev.type === 'hit')).toBe(true);
  });

  test('a read punch that whiffed is called off by a guard raised just after it started; one that landed is not', () => {
    const far = engineAt(1.5);
    for (let i = 0; i < 6; i++) far.step(i === 0 ? [attack('p1', 'cross', { headStart: 1 })] : [], { p1: stance('p1', { guard: i >= 6 }), p2: stance('p2') });
    expect(far.state('p1').phase).toBe('recovery');
    far.step([], { p1: stance('p1', { guard: true }), p2: stance('p2') });
    expect(far.state('p1').phase).toBe('idle');
    const near = engineAt(0.7);
    const events: FightEvent[] = [];
    for (let i = 0; i < 40; i++) events.push(...near.step(i === 0 ? [attack('p1', 'cross', { headStart: 1 })] : [], { p1: stance('p1', { guard: i >= 4 }), p2: stance('p2') }));
    expect(events.some((ev) => ev.type === 'hit')).toBe(true);
  });

  test('blocked punches chip the guard; dropping it lets it refill', () => {
    const e = engineAt(0.7);
    run(e, 40, { 0: [attack('p1', 'jab', { hand: 'L', autoLunge: true })] }, { p2: { guard: true } });
    const afterOne = e.state('p2').guard!;
    expect(afterOne).toBeLessThan(FIGHT.guardMax - FIGHT.guardPerBlock + 1);
    run(e, 120, {}, {});
    expect(e.state('p2').guard).toBe(FIGHT.guardMax);
  });
});
