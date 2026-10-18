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
  /** Voices are off unless `?voices=1` (the TTS voices weren't hype enough): captions only. */
  muted = new URLSearchParams(window.location.search).get('voices') !== '1';

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
    // [tags] are delivery directions for the voice, not words to show.
    useGameStore.setState({ caption: { voice: line.voice, text: line.text.replace(/\[[^\]]*\]\s*/g, ''), key: now } });
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

/** Instant lines for the big moments. {a} = attacker, {d} = defender, {w} = winner, {n} = hits. Short and loud. */
export const TEMPLATES = {
  first: [
    { voice: 'A', text: 'FIRST BLOOD! {a}!' },
    { voice: 'A', text: '{a} STRIKES FIRST!' },
    { voice: 'B', text: '{d} came here to watch, apparently.' },
  ],
  counter: [
    { voice: 'A', text: 'COUNTER HIT! {a} READ THAT!' },
    { voice: 'A', text: 'OH! {d} WALKED RIGHT INTO IT!' },
    { voice: 'B', text: '{d} is fighting on airplane mode.' },
  ],
  combo: [
    { voice: 'A', text: '{n} HITS! {a} IS COOKING!' },
    { voice: 'A', text: '{n}-HIT COMBO! UNREAL!' },
    { voice: 'B', text: '{d} is just a punching bag with a username.' },
  ],
  fireball: [
    { voice: 'A', text: '{a} LETS IT RIP! FIREBALL!' },
    { voice: 'A', text: 'FIREBALL INCOMING!' },
  ],
  fireballHit: [
    { voice: 'A', text: 'IT CONNECTS! {d} IS TOAST!' },
    { voice: 'B', text: '{d} forgot fireballs exist.' },
  ],
  fireballBlocked: [{ voice: 'B', text: '{d} blocks it. Boring, but smart.' }],
  danger: [
    { voice: 'A', text: '{d} IS ON THE ROPES!' },
    { voice: 'B', text: "{d}, it's not too late to forfeit." },
  ],
  ko: [
    { voice: 'A', text: 'K.O.!!! {w} TAKES IT!' },
    { voice: 'A', text: 'LIGHTS OUT! {w} WINS!' },
    { voice: 'B', text: '{d} has left the chat.' },
  ],
  time: [{ voice: 'A', text: 'TIME! {w} WINS ON POINTS!' }],
  draw: [{ voice: 'A', text: "TIME! IT'S A DRAW!" }],
  intro: [
    { voice: 'A', text: '{a} VERSUS {d}! LET\u2019S GO!' },
    { voice: 'A', text: 'IT\u2019S {a} AND {d}! FIGHT!' },
  ],
} as const satisfies Record<string, readonly Line[]>;

/** How the commentators say a fighter's name: "bred (CPU hard)" is just "Bred". */
export function spoken(name: string) {
  const bare = name.replace(/\s*\(cpu[^)]*\)\s*$/i, '').trim();
  return bare ? bare[0].toUpperCase() + bare.slice(1) : name;
}

export function fill(lines: readonly Line[], vars: Record<string, string | number>, pick = Math.random): Line {
  const line = lines[Math.floor(pick() * lines.length)];
  return { voice: line.voice, text: line.text.replace(/\{(\w)\}/g, (_, k: string) => String(vars[k] ?? '')) };
}
