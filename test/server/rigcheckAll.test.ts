// forge/rigcheck-all.js: the owner's one-shot rig audit over every fighter folder on the server.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const hasRigCheck = fs.existsSync(path.join(ROOT, 'forge/node_modules/@gltf-transform/core'));

function fighter(data: string, f: Record<string, unknown>, rig?: string) {
  const dir = path.join(data, String(f.id));
  fs.mkdirSync(dir, { recursive: true });
  const glbUrl = rig ? `/api/forge/${f.id}/rigged.glb` : undefined;
  fs.writeFileSync(path.join(dir, 'fighter.json'), JSON.stringify({ status: 'ready', timings: {}, glbUrl, ...f }));
  if (rig) fs.copyFileSync(path.join(__dirname, `fixtures/rig-${rig}.glb`), path.join(dir, 'rigged.glb'));
}

function audit(data: string, ...args: string[]) {
  try {
    return { code: 0, out: execFileSync(process.execPath, ['forge/rigcheck-all.js', data, ...args], { cwd: ROOT, encoding: 'utf8' }) };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, out: e.stdout };
  }
}

describe.skipIf(!hasRigCheck)('rigcheck-all', () => {
  it('lists every fighter folder, and --hide sets aside the broken ones without deleting anything', () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rigcheck-all-'));
    fighter(data, { id: 'good-1', name: 'phoenix', username: 'phoenix', createdAt: 1, engine3d: 'local' }, 'good');
    fighter(data, { id: 'bad-1', name: 'dylan', username: 'dylan', createdAt: 2, engine3d: 'local', quality: 'hq' }, 'collapsed');
    fighter(data, { id: 'bad-old', name: 'dylan', username: 'dylan', createdAt: 0, hidden: true }, 'collapsed');
    fighter(data, { id: 'plain', name: 'nobody', createdAt: 3 });

    const first = audit(data);
    expect(first.code).toBe(1);
    expect(first.out).toMatch(/good-1 .* ok /);
    expect(first.out).toMatch(/bad-1 .* FAIL .*Spine1 owns 100%/);
    expect(first.out).toMatch(/plain .* no model/);
    expect(first.out).toMatch(/4 fighters, 2 failing the rig check, 1 of them on the memory card/);

    const json = audit(data, '--json').out.trim().split('\n').map((l) => JSON.parse(l));
    expect(json.find((r) => r.id === 'bad-1')).toMatchObject({ verdict: 'FAIL', engine: 'local', quality: 'hq', score: 0 });

    expect(audit(data, '--hide').code).toBe(0);
    const hidden = JSON.parse(fs.readFileSync(path.join(data, 'bad-1/fighter.json'), 'utf8'));
    expect(hidden.hidden).toBe(true);
    expect(hidden.hiddenReason).toMatch(/rig check failed/);
    expect(JSON.parse(fs.readFileSync(path.join(data, 'bad-1/fighter.json.pre-hide'), 'utf8')).hidden).toBeUndefined();
    expect(fs.existsSync(path.join(data, 'bad-1/rigged.glb'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(data, 'good-1/fighter.json'), 'utf8')).hidden).toBeUndefined();
    // Nothing visible fails any more.
    expect(audit(data).code).toBe(0);
  }, 30_000); // runs the CLI three times; slow when the whole suite runs in parallel
});
