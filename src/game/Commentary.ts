import { config } from '../config';
import { useGameStore } from './store';

/**
 * The commentators (SPEC "Commentators"): A calls the play, B roasts. Big moments get an instant line from a
 * template (no waiting on a network), the round intro and the K.O. get lines a fast LLM writes on the forge
 * server from both fighters' names and forge briefs. Every line is captioned; voices come from the server's TTS
 * (cached by text, so template lines are instant after the first time), falling back to the browser's voice.
 * One line at a time: a queue keeps them from talking over each other, and stale lines are dropped.
 */
export type Voice = 'A' | 'B';
export type Line = { voice: Voice; text: string };

const MAX_QUEUE = 2;
/** A queued line older than this is old news: dropped. */
const STALE_MS = 3500;

export class Commentary {
  private queue: (Line & { at: number })[] = [];
  private speaking = false;
  private audio: HTMLAudioElement | null = null;
  muted = false;

  /** Say a line (or two) soon. `urgent` jumps the queue (a K.O. beats a combo call). */
  say(lines: Line[], urgent = false) {
    const now = performance.now();
    const items = lines.map((l) => ({ ...l, at: now }));
    this.queue = urgent ? [...items, ...this.queue] : [...this.queue, ...items];
    this.queue = this.queue.slice(0, MAX_QUEUE + (urgent ? items.length : 0));
    void this.next();
  }

  /** Lines written by the LLM on the forge server; nothing (and no fuss) if it's slow or down. */
  async write(moment: string, fighters: Record<string, { id?: string; name: string }>): Promise<Line[]> {
    if (!config.forgeApi) return [];
    try {
      const res = await fetch(`${config.forgeApi.replace(/\/+$/, '')}/api/commentary`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forge-key': config.forgeKey },
        body: JSON.stringify({ moment, fighters }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { lines?: Line[] };
      return (body.lines ?? []).filter((l) => (l.voice === 'A' || l.voice === 'B') && typeof l.text === 'string');
    } catch {
      return [];
    }
  }

  /** Stop talking now (a new round, leaving the match). */
  hush() {
    this.queue = [];
    this.audio?.pause();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    useGameStore.setState({ caption: null });
  }

  private async next() {
    if (this.speaking) return;
    const now = performance.now();
    this.queue = this.queue.filter((l) => now - l.at < STALE_MS);
    const line = this.queue.shift();
    if (!line) return;
    this.speaking = true;
    useGameStore.setState({ caption: { voice: line.voice, text: line.text, key: now } });
    try {
      if (!this.muted) await this.voice(line);
      else await wait(1200 + line.text.length * 35);
    } finally {
      this.speaking = false;
      // Leave the caption up a beat, then clear it unless another line took over.
      setTimeout(() => {
        if (useGameStore.getState().caption?.key === now) useGameStore.setState({ caption: null });
      }, 600);
      void this.next();
    }
  }

  /** Server voice (OpenAI TTS), else the browser's own, else just the caption's reading time. */
  private async voice(line: Line) {
    try {
      const res = await fetch(`${config.forgeApi.replace(/\/+$/, '')}/api/tts?voice=${line.voice}&text=${encodeURIComponent(line.text)}`, {
        headers: { 'x-forge-key': config.forgeKey },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.volume = 0.9;
      this.audio = audio;
      await new Promise<void>((resolve) => {
        audio.onended = audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
        setTimeout(resolve, 8000);
      });
      URL.revokeObjectURL(url);
    } catch {
      await this.browserVoice(line);
    }
  }

  private browserVoice(line: Line) {
    if (typeof speechSynthesis === 'undefined') return wait(1200 + line.text.length * 35);
    return new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(line.text);
      u.rate = line.voice === 'A' ? 1.15 : 1.0;
      u.pitch = line.voice === 'A' ? 0.9 : 1.1;
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
      setTimeout(resolve, 8000);
    });
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Instant lines for the big moments. {a} = attacker, {d} = defender, {w} = winner, {n} = hits. */
export const TEMPLATES = {
  first: [
    { voice: 'A', text: '{a} draws first blood!' },
    { voice: 'A', text: 'First hit goes to {a}!' },
    { voice: 'B', text: '{d} was still stretching, apparently.' },
  ],
  counter: [
    { voice: 'A', text: 'COUNTER! {a} saw that coming a mile away!' },
    { voice: 'A', text: 'What a counter from {a}!' },
    { voice: 'B', text: '{d} walked right into that one.' },
  ],
  combo: [
    { voice: 'A', text: '{n}-hit combo from {a}!' },
    { voice: 'A', text: '{a} is putting it together! {n} hits!' },
    { voice: 'B', text: '{d} is just collecting those now.' },
  ],
  fireball: [
    { voice: 'A', text: '{a} charges up... FIREBALL!' },
    { voice: 'A', text: 'Here comes the super from {a}!' },
  ],
  fireballHit: [
    { voice: 'A', text: 'Fireball connects! {d} is cooked!' },
    { voice: 'B', text: '{d} has never seen a fireball before, clearly.' },
  ],
  fireballBlocked: [{ voice: 'B', text: '{d} ate that fireball on the guard. Respect.' }],
  danger: [
    { voice: 'B', text: '{d} is running on fumes!' },
    { voice: 'A', text: 'One more clean shot and {d} is done!' },
  ],
  ko: [
    { voice: 'A', text: 'K.O.! {w} takes it!' },
    { voice: 'A', text: 'DOWN GOES {d}! {w} wins!' },
  ],
  time: [{ voice: 'A', text: "Time! {w} takes it on points!" }],
  draw: [{ voice: 'A', text: "Time! It's a draw!" }],
  intro: [
    { voice: 'A', text: '{a} versus {d}! Let’s get it on!' },
    { voice: 'A', text: 'Ladies and gentlemen... {a} and {d}!' },
  ],
} as const satisfies Record<string, readonly Line[]>;

export function fill(lines: readonly Line[], vars: Record<string, string | number>, pick = Math.random): Line {
  const line = lines[Math.floor(pick() * lines.length)];
  return { voice: line.voice, text: line.text.replace(/\{(\w)\}/g, (_, k: string) => String(vars[k] ?? '')) };
}
