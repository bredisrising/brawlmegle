// Re-reads recorded matches (MATCHES=dir of brawlegle match .jsonl files): what the reader makes of each
// player's real fighting now vs what it read live (the intents stored in the file), and how the fight went.
// Turns real play into a regression check as the reader changes.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { IntentReader } from '../../src/intent/IntentReader';
import type { Intent } from '../../src/intent/intents';
import type { PoseFrame } from '../../src/types';

const dir = process.env.MATCHES;
const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)) : [];

const describe = (i: Intent) =>
  i.kind === 'strike' ? `${i.limb === 'armL' ? 'L' : i.limb === 'armR' ? 'R' : i.limb} ${i.style}` : i.kind === 'dodge' ? `dodge ${i.dir}` : i.kind;

test.skipIf(files.length === 0)('recorded matches, re-read', () => {
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const header = lines[0];
    if (header.clip !== 'match') continue;
    const frames = lines.filter((l) => l.image) as PoseFrame[];
    const live = lines.filter((l) => l.intent).map((l) => l.intent as Intent).filter((i) => i.kind !== 'anticipate' && i.kind !== 'cancel');
    const reader = new IntentReader('p1');
    const now = frames.flatMap((f) => reader.update(f, f.t).intents).filter((i) => i.kind !== 'anticipate' && i.kind !== 'cancel');
    const t0 = frames[0]?.t ?? 0;
    const count = (list: Intent[]) => {
      const m = new Map<string, number>();
      for (const i of list) m.set(describe(i), (m.get(describe(i)) ?? 0) + 1);
      return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ');
    };
    const events = lines.filter((l) => l.event).map((l) => l.event);
    const mine = events.filter((e) => e.attacker === header.player);
    console.log(`\n${path.basename(file)}: ${header.name} vs ${header.opponent}, ${(((frames.at(-1)?.t ?? t0) - t0) / 1000).toFixed(0)} s, ${frames.length} frames, result ${JSON.stringify(header.result)}`);
    console.log(`  live read: ${count(live)}`);
    console.log(`  read now:  ${count(now)}`);
    console.log(`  thrown ${mine.filter((e) => e.type === 'startup').length}, landed ${mine.filter((e) => e.type === 'hit' || e.type === 'counter').length}, blocked ${mine.filter((e) => e.type === 'blocked').length}, whiffed ${mine.filter((e) => e.type === 'whiff').length}`);
  }
});
