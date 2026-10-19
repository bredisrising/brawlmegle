// The commentator's voice on the forge server (forge/pipeline.js speak), with ElevenLabs mocked: it keeps under the
// plan's limit of calls at once, waits out a busy answer, and never comes back in another voice.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Speak = (text: string, voice: string, opts?: { urgent?: boolean }) => Promise<Buffer>;
const PIPELINE = pathToFileURL(path.resolve(__dirname, '../../forge/pipeline.js')).href;
const load = async () => ((await import(/* @vite-ignore */ PIPELINE)) as { speak: Speak }).speak;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ELEVENLABS_API_KEY;
});

describe('commentator voice', () => {
  it('never more than 4 ElevenLabs calls at once, waits out a 429, all in the one voice', async () => {
    process.env.ELEVENLABS_API_KEY = 'el-test';
    const speak = await load();
    let busy = 0;
    let most = 0;
    let calls = 0;
    const hosts: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      hosts.push(new URL(url).host);
      const call = ++calls;
      busy++;
      most = Math.max(most, busy);
      await new Promise((r) => setTimeout(r, 15));
      busy--;
      if (call === 1) return new Response('{"detail":{"code":"concurrent_limit_exceeded"}}', { status: 429 });
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const clips = await Promise.all(Array.from({ length: 12 }, (_, i) => speak(`line ${i}`, 'A', { urgent: i % 3 === 0 })));
    expect(clips.every((c) => c.length === 3)).toBe(true);
    expect(most).toBeLessThanOrEqual(4);
    expect(calls).toBe(13);
    expect(hosts.every((h) => h === 'api.elevenlabs.io')).toBe(true);
  });

  it("a line ElevenLabs can't voice fails, rather than coming back in OpenAI's voice", async () => {
    process.env.ELEVENLABS_API_KEY = 'el-test';
    const speak = await load();
    const hosts: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      hosts.push(new URL(url).host);
      return new Response('quota', { status: 401 });
    });
    await expect(speak('nope', 'A')).rejects.toThrow(/ElevenLabs TTS 401/);
    expect(hosts).toEqual(['api.elevenlabs.io']);
  });
});
