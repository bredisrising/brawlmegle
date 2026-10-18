// The whole orchestrator on real recordings: camera frames -> reader -> resolver -> engine, against a dummy.
// For each prompted move in a guided test: did the reader see it, did the engine throw it, and how long from the
// reader's first sign of it (the wind-up) to the strike landing (active frames). GUIDED=path1,path2 (tuner guided
// tests); defaults to the ones in the Downloads folder when present.
import fs from 'node:fs';
import { expect, test } from 'vitest';
import { FightEngine } from '../../src/fight/FightEngine';
import { Resolver } from '../../src/fight/Resolver';
import { IntentReader } from '../../src/intent/IntentReader';
import type { Intent } from '../../src/intent/intents';
import type { Command, FightEvent, PoseFrame, Stance } from '../../src/types';

const defaults = ['/mnt/c/Users/ankit/Downloads/guided-233104.jsonl', '/mnt/c/Users/ankit/Downloads/guided-233624.jsonl'];
const files = (process.env.GUIDED?.split(',') ?? defaults).filter((f) => fs.existsSync(f));

type Label = { say: string; expect: { kind: string; limb?: string; style?: string }; start: number; end: number };
const MOVE_OF: Record<string, string[]> = { straight: ['jab', 'cross'], hook: ['hook'], upper: ['uppercut'] };

test.skipIf(files.length === 0)('orchestrator on guided tests', () => {
  let strikes = 0;
  let thrown = 0;
  let right = 0;
  const delays: number[] = [];
  for (const file of files) {
    const [header, ...rest] = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const frames = (rest as PoseFrame[]).filter((f) => f.image);
    const labels = header.labels as Label[];
    const reader = new IntentReader('p1');
    const resolver = new Resolver();
    const engine = new FightEngine();
    const dummy: Stance = { player: 'p2', guard: false, advance: 0, lean: { x: 0, y: 0 }, tracked: true };
    const t0 = frames[0].t;
    const end = frames[frames.length - 1].t;
    const intents: Intent[] = [];
    const starts: { t: number; move: string }[] = [];
    const actives: number[] = [];
    let fi = 0;
    let last: PoseFrame | null = null;
    let stance: Stance = { ...dummy, player: 'p1', tracked: false };
    let wasActive = false;
    for (let tick = 0; t0 + (tick * 1000) / 60 <= end; tick++) {
      const now = t0 + (tick * 1000) / 60;
      const commands: Command[] = [];
      // Feed each camera frame once, when it would have arrived.
      while (fi < frames.length && frames[fi].t <= now) {
        last = frames[fi++];
        const out = reader.update(last, last.t);
        intents.push(...out.intents);
        commands.push(...resolver.resolve('p1', out.intents, engine));
        stance = out.stance;
      }
      // The dummy stands at a fighting distance and takes it (heals, so the test never ends on a K.O.).
      const events: FightEvent[] = engine.step(commands, { p1: stance, p2: dummy });
      for (const ev of events) if (ev.type === 'startup' && ev.attacker === 'p1') starts.push({ t: now, move: ev.move });
      const active = engine.state('p1').phase === 'active';
      if (active && !wasActive) actives.push(now);
      wasActive = active;
      if (engine.state('p2').hp < 40) engine.reset();
    }
    const lines: string[] = [];
    for (const l of labels) {
      const want = l.expect;
      if (want.kind !== 'strike') continue;
      strikes++;
      const seen = intents.filter((i) => i.kind === 'strike' && i.t >= l.start && i.t <= l.end + 300);
      const threw = starts.filter((s) => s.t >= l.start && s.t <= l.end + 500);
      const ok = threw.some((s) => MOVE_OF[want.style ?? 'straight']?.includes(s.move));
      if (threw.length) thrown++;
      if (ok) right++;
      // Delay: the first wind-up (or the strike itself) in the window -> the first active frame after it.
      const first = intents.find((i) => (i.kind === 'anticipate' || i.kind === 'strike') && i.t >= l.start && i.t <= l.end);
      const hit = first ? actives.find((a) => a >= first.t) : undefined;
      if (first && hit !== undefined && hit - first.t < 1000) delays.push(hit - first.t);
      lines.push(`${((l.start - t0) / 1000).toFixed(1).padStart(5)}s ${l.say.padEnd(13)} read: ${seen.map((i) => (i.kind === 'strike' ? `${i.limb}:${i.style}` : '')).join(' ') || '—'}  threw: ${threw.map((s) => s.move).join(' ') || '—'} ${ok ? '✓' : '✗'}`);
    }
    console.log(`\n${file.split('/').pop()}\n${lines.join('\n')}`);
  }
  delays.sort((a, b) => a - b);
  const pct = (p: number) => delays[Math.min(delays.length - 1, Math.floor(p * delays.length))]?.toFixed(0);
  console.log(`\nstrikes prompted ${strikes}, engine threw something ${thrown}, threw the right kind ${right}`);
  console.log(`wind-up seen -> strike lands: median ${pct(0.5)} ms, p90 ${pct(0.9)} ms (n=${delays.length})`);
  expect(thrown / strikes).toBeGreaterThan(0.6);
});
