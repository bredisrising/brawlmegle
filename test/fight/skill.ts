// Does skill beat volume? Scripted players fight through the real FightEngine with the camera's real flaws: each
// decides from what its screen shows (engine state delayed by its own perception), and what it throws reaches the
// engine after the camera -> reader pipeline, sometimes not at all, sometimes as the wrong punch, and raising a guard
// sometimes fires a phantom punch first. The rates are measured on real hackathon play (research/tracking-overhaul.md).
import { FightEngine } from '../../src/fight/FightEngine';
import type { AttackMove, Command, FighterState, PlayerId, Stance } from '../../src/types';

export type Act = { attack?: AttackMove; guard: boolean };
export type Ctx = { tick: number; me: PlayerId; seen: (id: PlayerId) => FighterState; rng: () => number };
export type Policy = {
  name: string;
  /** How often the reader catches this player's punches (clean punchers get read more). */
  readRate: number;
  act(ctx: Ctx): Act;
};

/** What the camera and reader do to a player's input (defaults: real play, 30 fps laptops). */
export type ReadModel = {
  /** Human reaction (visual) plus the display: how stale the screen a player decides from is. */
  perceiveMs: number;
  /** Real motion -> the engine gets the strike (camera, pose, reader confirm). */
  pipelineMs: number;
  /**
   * Frames of wind-up already shown when the strike arrives (onset -> confirm, ~80 ms). Any value marks a camera-read
   * punch, which lands FIGHT.readStartup frames after it arrives.
   */
  headStart: number;
  /** A read punch comes out as another punch this often (style errors). */
  wrongStyle: number;
  /** Raising the guard fires a phantom punch this often (real block moments: 64 of 101). */
  phantomOnGuard: number;
  /** The guard counts this long after the hands get there (the reader's hold). */
  guardMs: number;
  /** Override every policy's read rate (where the tracking is heading: nearly every punch read). */
  readAll?: number;
};

export const REAL: ReadModel = { perceiveMs: 295, pipelineMs: 160, headStart: 4.8, wrongStyle: 0.5, phantomOnGuard: 0.64, guardMs: 120 };
/** The target: tracking good enough that nearly everything gets read, flails included. Skill has to win here too. */
export const GOOD: ReadModel = { ...REAL, readAll: 0.9, wrongStyle: 0.25, phantomOnGuard: 0.15, pipelineMs: 140 };

export function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PUNCHES: AttackMove[] = ['jab', 'cross', 'hook', 'uppercut'];
/** A punch out and back: no guard from that hand meanwhile. */
const HAND_OUT_MS = 350;
const ms = (tick: number) => (tick * 1000) / 60;
const other = (id: PlayerId): PlayerId => (id === 'p1' ? 'p2' : 'p1');

/** Swings at `perSecond` (±30%), any punch, never guards: most of the hackathon. */
export const masher = (perSecond: number): Policy => {
  let next = 0;
  return {
    name: `masher ${perSecond}/s`,
    readRate: 0.5,
    act({ tick, rng }) {
      if (ms(tick) < next) return { guard: false };
      next = ms(tick) + (1000 / perSecond) * (0.7 + 0.6 * rng());
      return { guard: false, attack: PUNCHES[Math.floor(rng() * 4)] };
    },
  };
};

/** Holds a face guard; punches back once it sees itself block. */
export const turtle = (): Policy => {
  let lastPhase = 'idle';
  let counter = false;
  return {
    name: 'turtle',
    readRate: 0.7,
    act({ me, seen }) {
      const mine = seen(me);
      if (mine.phase === 'blockstun' && lastPhase !== 'blockstun') counter = true;
      lastPhase = mine.phase;
      if (counter && mine.phase === 'idle') return (counter = false), { guard: false, attack: 'cross' };
      return { guard: (mine.guard ?? 100) > 25 };
    },
  };
};

/** Guards, jabs about once a second, and punishes what it can see: a recovering, reeling or gassed opponent. */
export const patient = (): Policy => {
  let next = 0;
  return {
    name: 'patient',
    readRate: 0.7,
    act({ tick, me, seen, rng }) {
      const opp = seen(other(me));
      const mine = seen(me);
      const free = mine.phase === 'idle';
      if (free && (opp.phase === 'recovery' || opp.phase === 'hitstun')) return { guard: false, attack: 'cross' };
      if (free && ms(tick) >= next) {
        next = ms(tick) + 900 * (0.7 + 0.6 * rng());
        return { guard: false, attack: 'jab' };
      }
      return { guard: free && (mine.guard ?? 100) > 25 };
    },
  };
};

/** Clean one-two combos about every 1.3 s from a guard, and a cross into anything it sees open. */
export const boxer = (): Policy => {
  let next = 0;
  let second = -1;
  return {
    name: 'boxer',
    readRate: 0.75,
    act({ tick, me, seen, rng }) {
      const opp = seen(other(me));
      const mine = seen(me);
      const t = ms(tick);
      if (second >= 0 && t >= second) return (second = -1), { guard: false, attack: 'cross' };
      if (mine.phase !== 'idle') return { guard: false };
      if (opp.phase === 'recovery' || opp.phase === 'hitstun') return { guard: false, attack: 'hook' };
      if (t >= next) {
        next = t + 1300 * (0.7 + 0.6 * rng());
        second = t + 180;
        return { guard: false, attack: 'jab' };
      }
      return { guard: (mine.guard ?? 100) > 25 };
    },
  };
};

export type FightResult = { winner: PlayerId | null; seconds: number; thrown: Record<PlayerId, number>; events: Record<string, Record<PlayerId, number>> };

/** One round, up to 60 s, between two policies under a read model. */
export function fight(a: Policy, b: Policy, seed: number, model: ReadModel = REAL): FightResult {
  const engine = new FightEngine();
  const rng = mulberry(seed);
  const tick = (x: number) => Math.round(x / (1000 / 60));
  const history: Record<PlayerId, FighterState>[] = [];
  const inflight: { at: number; c: Command }[] = [];
  const guards: { at: number; id: PlayerId; guard: boolean }[] = [];
  const stance: Record<PlayerId, Stance> = {
    p1: { player: 'p1', guard: false, advance: 0, lean: { x: 0, y: 0 }, tracked: true },
    p2: { player: 'p2', guard: false, advance: 0, lean: { x: 0, y: 0 }, tracked: true },
  };
  const wanted: Record<PlayerId, boolean> = { p1: false, p2: false };
  const thrown: Record<PlayerId, number> = { p1: 0, p2: 0 };
  const handOutUntil: Record<PlayerId, number> = { p1: 0, p2: 0 };
  const events: Record<string, Record<PlayerId, number>> = {};
  const strike = (id: PlayerId, move: AttackMove, at: number) => inflight.push({
    at, c: { kind: 'attack', player: id, t: 0, move, hand: move === 'jab' ? 'L' : 'R', height: 'head', speed: 1, windup: 1, autoLunge: true, headStart: model.headStart },
  });
  for (let now = 0; now < 60 * 60; now++) {
    history.push({ p1: { ...engine.state('p1') }, p2: { ...engine.state('p2') } });
    const seen = history[Math.max(0, history.length - 1 - tick(model.perceiveMs))];
    for (const [id, pol] of [['p1', a], ['p2', b]] as const) {
      const out = pol.act({ tick: now, me: id, seen: (x) => seen[x], rng });
      // A hand that just punched isn't back in guard for a while (the arm goes out and comes back).
      if (out.attack) handOutUntil[id] = now + tick(HAND_OUT_MS);
      if (now < handOutUntil[id]) out.guard = false;
      if (out.guard !== wanted[id]) {
        wanted[id] = out.guard;
        guards.push({ at: now + tick(model.pipelineMs + (out.guard ? model.guardMs : 0)), id, guard: out.guard });
        // Hands rising into a guard look like a punch to the reader for a moment.
        if (out.guard && rng() < model.phantomOnGuard) strike(id, rng() < 0.5 ? 'uppercut' : 'cross', now + tick(model.pipelineMs));
      }
      if (out.attack) {
        thrown[id]++;
        if (rng() < (model.readAll ?? pol.readRate)) strike(id, rng() < model.wrongStyle ? PUNCHES[Math.floor(rng() * 4)] : out.attack, now + tick(model.pipelineMs));
      }
    }
    for (const g of guards.filter((x) => x.at <= now)) stance[g.id] = { ...stance[g.id], guard: g.guard };
    const due = inflight.filter((x) => x.at <= now).map((x) => x.c);
    for (let i = guards.length - 1; i >= 0; i--) if (guards[i].at <= now) guards.splice(i, 1);
    for (let i = inflight.length - 1; i >= 0; i--) if (inflight[i].at <= now) inflight.splice(i, 1);
    for (const e of engine.step(due, stance)) (events[e.type] ??= { p1: 0, p2: 0 })[e.attacker]++;
    if (engine.state('p1').phase === 'ko' || engine.state('p2').phase === 'ko') {
      return { winner: engine.state('p1').phase === 'ko' ? 'p2' : 'p1', seconds: now / 60, thrown, events };
    }
  }
  const h1 = engine.state('p1').hp, h2 = engine.state('p2').hp;
  return { winner: h1 === h2 ? null : h1 > h2 ? 'p1' : 'p2', seconds: 60, thrown, events };
}

export type Matchup = { a: string; b: string; winsA: number; winsB: number; draws: number; seconds: number; landedA: number; landedB: number; blockedA: number; blockedB: number };

/** `rounds` seeded rounds of A vs B (A as p1 and p2 alternately, so the host seat doesn't decide it). */
export function matchup(a: () => Policy, b: () => Policy, rounds = 40, model: ReadModel = REAL): Matchup {
  const r: Matchup = { a: a().name, b: b().name, winsA: 0, winsB: 0, draws: 0, seconds: 0, landedA: 0, landedB: 0, blockedA: 0, blockedB: 0 };
  for (let s = 1; s <= rounds; s++) {
    const swap = s % 2 === 0;
    const res = swap ? fight(b(), a(), s * 7919, model) : fight(a(), b(), s * 7919, model);
    const A: PlayerId = swap ? 'p2' : 'p1', B: PlayerId = swap ? 'p1' : 'p2';
    if (res.winner === A) r.winsA++;
    else if (res.winner === B) r.winsB++;
    else r.draws++;
    r.seconds += res.seconds / rounds;
    const n = (type: string, id: PlayerId) => (res.events[type]?.[id] ?? 0) / rounds;
    r.landedA += n('hit', A) + n('counter', A);
    r.landedB += n('hit', B) + n('counter', B);
    r.blockedA += n('blocked', A);
    r.blockedB += n('blocked', B);
  }
  return r;
}

export const formatMatchup = (m: Matchup, rounds = 40) =>
  `${m.a.padEnd(12)} vs ${m.b.padEnd(12)} ${String(m.winsA).padStart(2)}-${String(m.winsB).padStart(2)}${m.draws ? ` (${m.draws} draws)` : ''}`.padEnd(40) +
  ` ${m.seconds.toFixed(1)} s   landed ${m.landedA.toFixed(0)}/${m.landedB.toFixed(0)}   blocked ${m.blockedA.toFixed(0)}/${m.blockedB.toFixed(0)}   (of ${rounds})`;
