// Runs the reader over every pose clip in CLIPS_DIR (default test/pose/fixtures) and prints what it saw.
// TRACE_DIR=... also writes per-frame debug signals as JSON for plotting.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { loadClip, runClip } from './clip';

const dir = process.env.CLIPS_DIR ?? 'test/pose/fixtures';
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];

test.skipIf(files.length === 0)('reader runs on recorded clips', () => {
  for (const file of files) {
    const clip = loadClip(path.join(dir, file));
    const { intents, trace } = runClip(clip);
    const summary = intents
      .filter((i) => i.kind !== 'anticipate' && i.kind !== 'cancel')
      .map((i) => `${(i.t / 1000).toFixed(2)}s ${i.kind}${'limb' in i ? ` ${i.limb}` : ''}${i.kind === 'strike' ? ` ${i.style}/${i.height} reach ${i.reach.toFixed(2)} speed ${i.speed.toFixed(2)}` : ''}${i.kind === 'dodge' ? ` ${i.dir}` : ''}`);
    console.log(`\n${file}: ${summary.length} intents, ${intents.filter((i) => i.kind === 'cancel').length} cancelled wind-ups\n  ${summary.join('\n  ')}`);
    if (process.env.TRACE_DIR) {
      fs.writeFileSync(path.join(process.env.TRACE_DIR, file.replace('.jsonl', '.trace.json')), JSON.stringify({ trace, intents }));
    }
  }
});
