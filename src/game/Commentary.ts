import { config } from '../config';
import { useGameStore } from './store';

/**
 * The commentator (SPEC "Commentators"), voiced like a fight broadcast: one hyped play-by-play voice (A; B, a second
 * voice, is kept in the types and the server but not used). Big moments get a template line whose voice was fetched before the round (so it plays the instant the
 * hit lands); the round intro, the finish and a few live moments get lines a fast LLM writes on the forge server
 * from both fighters' names and forge briefs, voiced before they're queued. Every line is captioned; voices come from
 * the server's TTS (cached there by text), falling back to the browser's voice. One line at a time: a queue keeps
 * them from talking over each other, and stale lines are dropped.
 */
export type Voice = 'A' | 'B';
export type Line = { voice: Voice; text: string };

const MAX_QUEUE = 2;
/** A queued line older than this is old news: dropped. */
const STALE_MS = 3500;
/** How much faster than recorded the commentator's clips play (ElevenLabs' own speed tops out at 1.2). */
const PACE = 1.2;
/** Voices on unless turned off in the menu (remembered here) or `?voices=0`. */
const VOICES_KEY = 'brawlmegle.voices';

const api = () => config.forgeApi.replace(/\/+$/, '');
const keyOf = (line: Line) => `${line.voice}|${line.text}`;

export class Commentary {
  private queue: (Line & { at: number })[] = [];
  private speaking = false;
  private audio: HTMLAudioElement | null = null;
  /** Fetched voice clips by voice + text (object URLs), or the fetch in flight. */
  private clips = new Map<string, Promise<string | null>>();
  /** Captions only: the player turned voices off (the menu's Commentary switch, remembered). */
  muted = voicesOff();
  /** The M key's mute-everything (not remembered). */
  silenced = false;

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) this.audio?.pause();
    try {
      localStorage.setItem(VOICES_KEY, muted ? '0' : '1');
    } catch {}
  }

  /** Say a line (or two) soon. `urgent` jumps the queue (a K.O. beats a combo call). */
  say(lines: Line[], urgent = false) {
    const now = performance.now();
    const items = lines.map((l) => ({ ...l, at: now }));
    this.queue = urgent ? [...items, ...this.queue] : [...this.queue, ...items];
    this.queue = this.queue.slice(0, MAX_QUEUE + (urgent ? items.length : 0));
    void this.next();
  }

  /** Fetch these lines' voices now, so saying them later is instant. Resolves when they're in (or failed). */
  prefetch(lines: Line[]): Promise<unknown> {
    if (this.muted || !config.forgeApi) return Promise.resolve();
    return Promise.all(lines.map((l) => this.clip(l, true)));
  }

  /** Lines written by the LLM on the forge server; nothing (and no fuss) if it's slow or down. */
  async write(moment: string, fighters: Record<string, { id?: string; name: string }>): Promise<Line[]> {
    if (!config.forgeApi) return [];
    try {
      const res = await fetch(`${api()}/api/commentary`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forge-key': config.forgeKey },
        body: JSON.stringify({ moment, fighters }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { lines?: Line[] };
      // One commentator: whatever the server wrote, it's his line.
      return (body.lines ?? []).filter((l) => typeof l?.text === 'string').map((l) => ({ voice: 'A' as const, text: l.text }));
    } catch {
      return [];
    }
  }

  /** Stop talking now (a new round, leaving the match). */
  hush() {
    this.queue = [];
    this.audio?.pause();
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
      if (!this.muted && !this.silenced) await this.voice(line);
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

  /** The line's voice clip (an object URL), fetched once. `ahead`: fetched before it's needed (it waits its turn). */
  private clip(line: Line, ahead = false): Promise<string | null> {
    const key = keyOf(line);
    let clip = this.clips.get(key);
    if (!clip) {
      // v=2: clips cached before the server stopped filling in with another voice aren't reused.
      clip = fetch(`${api()}/api/tts?voice=${line.voice}&v=2${ahead ? '&prefetch=1' : ''}&text=${encodeURIComponent(line.text)}`, {
        headers: { 'x-forge-key': config.forgeKey },
        signal: AbortSignal.timeout(8000),
      })
        .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
        .catch(() => null);
      this.clips.set(key, clip);
      // A failed fetch can be tried again next time.
      void clip.then((url) => url || this.clips.delete(key));
      if (this.clips.size > 120) this.clips.delete(this.clips.keys().next().value!);
    }
    return clip;
  }

  /**
   * The commentator's voice (ElevenLabs, from the server). A clip that isn't in within 3.5 s isn't worth the wait: the
   * line shows as a caption only (never another voice: that sounds like someone else took the mic).
   */
  private async voice(line: Line) {
    const url = await Promise.race([this.clip(line), wait(3500).then(() => null)]);
    if (!url) return wait(1200 + line.text.length * 35);
    const audio = new Audio(url);
    audio.volume = 0.95;
    // A hype caster talks fast: the clip a fifth faster than ElevenLabs says it, at the same pitch.
    audio.preservesPitch = true;
    audio.playbackRate = PACE;
    this.audio = audio;
    await new Promise<void>((resolve) => {
      audio.onended = audio.onerror = () => resolve();
      audio.play().catch(() => resolve());
      setTimeout(resolve, 9000);
    });
  }
}

function voicesOff() {
  const param = new URLSearchParams(window.location.search).get('voices');
  if (param) return param === '0';
  try {
    return localStorage.getItem(VOICES_KEY) === '0';
  } catch {
    return false;
  }
}

const wait = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));

/**
 * Instant lines for the big moments, called like a fight broadcast. {a} = attacker, {d} = defender, {w} = winner.
 * The [tag] opening each one is how the voice delivers it (captions drop it). No slang, no memes.
 */
export const TEMPLATES = {
  first: [
    { voice: 'A', text: '[shouting] {a} draws first blood!' },
    { voice: 'A', text: '[excited] And {a} lands the opening shot!' },
    { voice: 'A', text: '[excited] Big first hit from {a}! That sets the tone!' },
  ],
  counter: [
    { voice: 'A', text: '[shouting] Counter hit! {a} saw it coming!' },
    { voice: 'A', text: '[shouting] Oh! {a} punishes that clean!' },
    { voice: 'A', text: '[impressed] What a read by {a}! Caught {d} mid-swing!' },
  ],
  combo: [
    { voice: 'A', text: '[shouting] {a} is putting it together!' },
    { voice: 'A', text: '[shouting] {a} will not let up!' },
    { voice: 'A', text: '[shouting] {d} has to break that rhythm, right now!' },
  ],
  guardBreak: [
    { voice: 'A', text: '[shouting] Guard break! {a} goes right through it!' },
    { voice: 'A', text: '[shouting] {a} smashes through the guard!' },
    { voice: 'A', text: "[excited] You can't just block against {a}! The leg goes right through!" },
  ],
  parry: [
    { voice: 'A', text: '[shouting] Parried! {d} saw that haymaker coming!' },
    { voice: 'A', text: '[shouting] {d} turns it away! {a} is wide open!' },
  ],
  guardCrush: [
    { voice: 'A', text: "[shouting] The guard is gone! {d} can't block!" },
    { voice: 'A', text: '[shouting] Guard crushed! Go get {d}, {a}!' },
  ],
  danger: [
    { voice: 'A', text: '[excited] {d} is in serious trouble!' },
    { voice: 'A', text: '[shouting] One more clean hit and {d} is done!' },
  ],
  ko: [
    { voice: 'A', text: '[shouting] K.O.! {w} wins it!' },
    { voice: 'A', text: '[shouting] Down goes {d}! {w} takes it!' },
    { voice: 'A', text: "[impressed] That's how you close it out! {w} with the finish!" },
  ],
  time: [{ voice: 'A', text: '[shouting] Time! {w} takes it on points!' }],
  // A round of the three, not the match: short, the breather after it is.
  round: [
    { voice: 'A', text: '[shouting] {w} takes the round!' },
    { voice: 'A', text: '[excited] That round goes to {w}!' },
  ],
  roundDraw: [{ voice: 'A', text: '[shouting] An even round! They both take it!' }],
  draw: [{ voice: 'A', text: "[shouting] Time! We've got a draw!" }],
  intro: [
    { voice: 'A', text: '[shouting] {a} versus {d}! Here we go!' },
    { voice: 'A', text: "[excited] It's {a} and {d}! Let's fight!" },
  ],
} as const satisfies Record<string, readonly Line[]>;

/** How the commentators say a fighter's name: "bred (CPU hard)" is just "Bred", "Nana Knuckles (BOT)" "Nana Knuckles". */
export function spoken(name: string) {
  const bare = name.replace(/\s*\((?:cpu|bot)[^)]*\)\s*$/i, '').trim();
  return bare ? bare[0].toUpperCase() + bare.slice(1) : name;
}

export function fill(lines: readonly Line[], vars: Record<string, string | number>, pick = Math.random): Line {
  const line = lines[Math.floor(pick() * lines.length)];
  return { voice: line.voice, text: line.text.replace(/\{(\w)\}/g, (_, k: string) => String(vars[k] ?? '')) };
}
