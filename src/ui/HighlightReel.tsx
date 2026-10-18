import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchHighlights, headline, moveLabel, type Highlight } from '../forge/highlights';
import { Arrow, TextButton } from './ArcadeButton';
import { ACCENT } from './accent';

/** The reel plays the newest few. */
const MAX_CLIPS = 8;
/** New K.O.s join the reel while the title sits there (a booth between matches). */
const REFRESH_MS = 45_000;
/** The cut between clips: a diagonal wipe in the next winner's color. */
const CUT_MS = 420;
const COLOR = { p1: 'var(--color-p1)', p2: 'var(--color-p2)' } as const;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Title screen: recent K.O. replays (game/HighlightRecorder.ts) cycling in a slanted frame, with who K.O.'d whom, the
 * finishing move and the combo slammed in on each cut. Two <video>s take turns so the next clip is always loaded
 * before the cut. Shows nothing until a clip can play (no highlights yet, or the server is down: no reel).
 * Sizes itself to the free space it's given (.reel-area) and hides when that's too small (see index.css).
 */
export function HighlightReel({ paused = false }: { paused?: boolean }) {
  const [all, setAll] = useState<Highlight[]>([]);
  const [bad, setBad] = useState<ReadonlySet<string>>(() => new Set());
  const [pos, setPos] = useState({ index: 0, slot: 0, cut: 0 });
  /** The last cut whose wipe has finished: until then the outgoing <video> keeps its clip (the wipe sweeps over it). */
  const [settled, setSettled] = useState(0);
  /** 'hidden' until a clip plays, then the entrance runs once ('in'), then it's just there. */
  const [shown, setShown] = useState<'hidden' | 'in' | 'done'>('hidden');
  const [viewing, setViewing] = useState<number | null>(null);
  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLButtonElement>(null);
  const wipe = useRef<HTMLDivElement>(null);
  const edge = useRef<HTMLDivElement>(null);
  const clips = all.filter((c) => !bad.has(c.id));
  const n = clips.length;
  const index = n ? pos.index % n : 0;
  const current = clips[index];
  const next = clips[(index + 1) % Math.max(1, n)];
  const prev = clips[(index - 1 + n) % Math.max(1, n)];
  const stopped = paused || viewing !== null;

  // The list, now and every so often. The clip on screen keeps playing: the reel carries on from wherever it lands.
  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      void fetchHighlights(ctrl.signal).then((list) => {
        const fresh = list.slice(0, MAX_CLIPS);
        setAll((prev) => (prev.map((c) => c.id).join() === fresh.map((c) => c.id).join() ? prev : fresh));
      });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, []);

  const advance = useCallback(() => setPos((p) => ({ index: p.index + 1, slot: 1 - p.slot, cut: p.cut + 1 })), []);

  // A cut: the clip that was loading in the other <video> plays from the start, revealed by the wipe.
  useEffect(() => {
    const videos = [videoA.current, videoB.current];
    const active = videos[pos.slot];
    const idle = videos[1 - pos.slot];
    if (!active) return;
    if (active.currentTime > 0) active.currentTime = 0;
    if (pos.cut === 0 || reducedMotion()) {
      idle?.pause();
      setSettled(pos.cut);
      return;
    }
    const timing = { duration: CUT_MS, easing: 'cubic-bezier(0.7, 0, 0.25, 1)' };
    // The new clip sweeps in behind a band in the winner's color with a white leading edge (one slanted edge, so
    // all three move as one); the frame takes the hit.
    active.animate({ clipPath: ['polygon(-30% 0, -30% 0, -50% 100%, -50% 100%)', 'polygon(-30% 0, 150% 0, 130% 100%, -50% 100%)'] }, timing);
    wipe.current?.animate({ clipPath: ['polygon(-30% 0, -16% 0, -36% 100%, -50% 100%)', 'polygon(150% 0, 164% 0, 144% 100%, 130% 100%)'] }, timing);
    edge.current?.animate({ clipPath: ['polygon(-16% 0, -13% 0, -33% 100%, -36% 100%)', 'polygon(164% 0, 167% 0, 147% 100%, 144% 100%)'] }, timing);
    frame.current?.animate({ transform: ['scale(1)', 'scale(1.035)', 'scale(1)'], filter: ['none', 'brightness(1.35)', 'none'] }, { duration: CUT_MS + 160, easing: 'ease-out' });
    const t = setTimeout(() => {
      idle?.pause();
      setSettled(pos.cut);
    }, CUT_MS);
    return () => clearTimeout(t);
  }, [pos]);

  // Play or hold (the viewer is open, or the menu says so). A clip that never ends (stalled) gets cut anyway.
  useEffect(() => {
    const active = [videoA.current, videoB.current][pos.slot];
    if (!active || !current) return;
    if (stopped) {
      active.pause();
      return;
    }
    active.play().catch(() => {});
    const left = Math.max(1, current.duration - active.currentTime) + 2;
    const timer = setTimeout(advance, left * 1000);
    return () => clearTimeout(timer);
  }, [pos, stopped, current, advance]);

  if (!n || !current) return null;
  const src = (slot: number) => (slot === pos.slot ? current : settled === pos.cut ? next : prev).url;
  const onEnded = (slot: number) => () => slot === pos.slot && advance();
  const onError = (slot: number) => () => {
    const failed = slot === pos.slot ? current : settled === pos.cut ? next : prev;
    setBad((b) => new Set(b).add(failed.id));
  };

  return (
    <>
      <div
        className={`reel pointer-events-auto relative ${shown === 'hidden' ? 'invisible' : shown === 'in' ? 'animate-in-l' : ''}`}
        style={{ animationDelay: '380ms' }}
        onAnimationEnd={(e) => e.target === e.currentTarget && setShown('done')}
      >
        <ReelHeader clip={current} count={n} index={index} cut={pos.cut} stopped={stopped} />
        <div className="relative mr-3 mb-3">
          {/* A slab in the winner's color behind the frame, like the ring corners behind the menu. */}
          <div aria-hidden className="slant absolute inset-0 translate-x-3 translate-y-3 transition-colors duration-300 [--slant:clamp(14px,4cqw,34px)]" style={{ background: COLOR[current.winner] }} />
          <div aria-hidden className="slant tex-dots absolute inset-0 translate-x-3 translate-y-3 [--slant:clamp(14px,4cqw,34px)]" />
          <button
            ref={frame}
            type="button"
            onClick={() => setViewing(index)}
            aria-label={`Watch the highlight: ${caption(current)}`}
            className="group slant relative block aspect-video w-full overflow-hidden bg-ink-2 [--slant:clamp(14px,4cqw,34px)]"
          >
            {[videoA, videoB].map((ref, slot) => (
              <video
                key={slot}
                ref={ref}
                src={src(slot)}
                muted
                playsInline
                preload="auto"
                onPlaying={() => setShown((v) => (v === 'hidden' ? 'in' : v))}
                onEnded={onEnded(slot)}
                onError={onError(slot)}
                style={{ zIndex: slot === pos.slot ? 1 : 0 }}
                className="absolute inset-0 size-full object-cover"
              />
            ))}
            {/* Bottom shade so the captions read over a bright sky; the hollow clip number, like the menu's. */}
            <div className="pointer-events-none absolute inset-0 z-[2] bg-[linear-gradient(to_top,rgb(11_11_13/0.75),transparent_42%)]" />
            <span className="pointer-events-none absolute top-[0.25em] right-[0.45em] z-[2] font-display text-[clamp(1.75rem,7.5cqw,4.5rem)] leading-none text-hollow [--hollow:rgb(243_240_232/0.55)]">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="pointer-events-none absolute top-1/2 left-1/2 z-[3] flex -translate-x-1/2 -translate-y-1/2 scale-90 items-center gap-2 bg-paper px-4 py-2 font-display text-lg uppercase text-ink opacity-0 transition-[opacity,transform] duration-150 slant [--slant:8px] group-hover:scale-100 group-hover:opacity-100 group-focus-visible:opacity-100">
              Watch <Arrow />
            </span>
            <div ref={wipe} aria-hidden className="pointer-events-none absolute inset-0 z-[4] [clip-path:polygon(0_0,0_0,0_0)]" style={{ background: COLOR[current.winner] }} />
            <div ref={edge} aria-hidden className="pointer-events-none absolute inset-0 z-[4] bg-paper [clip-path:polygon(0_0,0_0,0_0)]" />
          </button>
          <Captions key={pos.cut} clip={current} delay={pos.cut ? CUT_MS * 0.55 : 380} className="absolute bottom-[0.7em] left-[clamp(0.6rem,3cqw,1.6rem)] z-10 text-[clamp(0.85rem,2.6cqw,1.6rem)]" />
        </div>
      </div>
      {viewing !== null && <HighlightViewer clips={clips} start={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

/** HIGHLIGHTS, when it happened, and a slanted segment per clip filling as it plays. */
function ReelHeader({ clip, count, index, cut, stopped }: { clip: Highlight; count: number; index: number; cut: number; stopped: boolean }) {
  return (
    <div className="mb-[clamp(0.4rem,1.4cqw,0.75rem)] flex items-center gap-3 pr-3">
      <span className="slant bg-hp px-3 py-0.5 font-cond text-[clamp(0.7rem,1.7cqw,0.95rem)] font-extrabold uppercase tracking-[0.3em] text-ink [--slant:7px]">
        Highlights
      </span>
      <span className="flex min-w-0 items-center gap-1.5 truncate font-cond text-[clamp(0.65rem,1.5cqw,0.85rem)] font-bold uppercase tracking-[0.22em] text-paper/55">
        <i className="animate-blink inline-block size-1.5 shrink-0 rounded-full bg-dmg" />
        K.O. replay <span className="text-paper/30">·</span> {ago(clip.createdAt)}
      </span>
      <div className="ml-auto flex shrink-0 gap-1" aria-hidden>
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className="slant relative h-[0.4rem] w-[clamp(0.9rem,3cqw,2rem)] overflow-hidden bg-paper/15 [--slant:3px]">
            {i < index && <span className="absolute inset-0 bg-paper/55" />}
            {i === index && (
              <span
                key={cut}
                className="absolute inset-0 origin-left bg-hp"
                style={{ animation: `reel-fill ${clip.duration}s linear both`, animationPlayState: stopped ? 'paused' : 'running' }}
              />
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

/** RICO K.O.s DYLAN, then UPPERCUT and 5-HIT COMBO, slammed in. Sized in em: the parent sets the scale. */
function Captions({ clip, delay = 0, className = '' }: { clip: Highlight; delay?: number; className?: string }) {
  const { winner, loser } = headline(clip);
  const w = ACCENT[clip.winner];
  const l = ACCENT[clip.winner === 'p1' ? 'p2' : 'p1'];
  return (
    <div className={`pointer-events-none flex flex-col items-start gap-[0.3em] ${className}`}>
      <div className="animate-slam flex origin-left items-center drop-shadow-[0_0.18em_0_#0b0b0d]" style={{ animationDelay: `${delay}ms` }}>
        <span className={`slant ${w.bg} max-w-[9em] truncate px-[0.5em] py-[0.12em] font-display text-[1.25em] uppercase leading-[1.1] tracking-tight text-ink [--slant:0.35em]`}>{winner}</span>
        <span className="-mx-[0.1em] bg-ink px-[0.55em] py-[0.32em] font-cond text-[0.72em] font-extrabold tracking-[0.2em] text-hp">K.O.s</span>
        <span className={`slant max-w-[9em] truncate border-b-[0.16em] ${l.border} bg-paper px-[0.5em] py-[0.12em] font-display text-[1.25em] uppercase leading-[1.1] tracking-tight text-ink [--slant:0.35em]`}>{loser}</span>
      </div>
      <div className="flex items-center gap-[0.3em]">
        <span className="animate-in-l slant bg-ink px-[0.6em] py-[0.15em] font-display text-[0.8em] uppercase tracking-tight text-paper [--slant:0.3em]" style={{ animationDelay: `${delay + 140}ms` }}>
          {moveLabel(clip.move)}
        </span>
        {clip.combo >= 2 && (
          <span className="animate-in-l slant bg-hp px-[0.6em] py-[0.15em] font-display text-[0.8em] uppercase tracking-tight text-ink [--slant:0.3em]" style={{ animationDelay: `${delay + 220}ms` }}>
            {clip.combo}-hit combo
          </span>
        )}
        <span className="animate-in-l bg-ink/80 px-[0.5em] py-[0.25em] font-cond text-[0.62em] font-bold uppercase tracking-[0.2em] text-paper/70" style={{ animationDelay: `${delay + 300}ms` }}>
          {clock(clip.roundTime)}
        </span>
      </div>
    </div>
  );
}

/** One clip big, looping, with the others a click away. Esc or a click outside closes it. */
function HighlightViewer({ clips, start, onClose }: { clips: Highlight[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const clip = clips[i % clips.length];
  const step = useCallback((d: number) => setI((v) => (v + d + clips.length) % clips.length), [clips.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, step]);
  if (!clip) return null;
  return (
    <div className="pointer-events-auto fixed inset-0 z-30 grid place-items-center bg-ink/85 p-3 backdrop-blur-sm sm:p-8" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Highlight"
        onClick={(e) => e.stopPropagation()}
        className="animate-rise @container relative w-[min(100%,calc((100svh-9rem)*16/9),76rem)]"
      >
        <div className="mb-3 flex items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="font-cond text-xs font-bold uppercase tracking-[0.3em] text-hp sm:text-sm">Highlight {String((i % clips.length) + 1).padStart(2, '0')} / {String(clips.length).padStart(2, '0')} · {ago(clip.createdAt)}</p>
          </div>
          <TextButton className="shrink-0" onClick={onClose}>Close ✕</TextButton>
        </div>
        <div className="relative mr-3 mb-3">
          <div aria-hidden className="slant absolute inset-0 translate-x-3 translate-y-3 [--slant:clamp(16px,3cqw,40px)]" style={{ background: COLOR[clip.winner] }} />
          <div className="slant relative aspect-video overflow-hidden bg-ink-2 [--slant:clamp(16px,3cqw,40px)]">
            <video key={clip.id} src={clip.url} muted playsInline autoPlay loop className="absolute inset-0 size-full object-cover" />
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_top,rgb(11_11_13/0.7),transparent_35%)]" />
          </div>
          <Captions key={clip.id} clip={clip} className="absolute bottom-[0.8em] left-[clamp(0.75rem,3cqw,2rem)] z-10 text-[clamp(0.9rem,2.2cqw,1.9rem)]" />
        </div>
        {clips.length > 1 && (
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" aria-label="Previous highlight" onClick={() => step(-1)} className="slant bg-ink-3 px-5 py-2 font-display text-xl text-paper transition-colors hover:bg-paper hover:text-ink [--slant:8px]">
              <Arrow className="rotate-180" />
            </button>
            <button type="button" aria-label="Next highlight" onClick={() => step(1)} className="slant bg-ink-3 px-5 py-2 font-display text-xl text-paper transition-colors hover:bg-hp hover:text-ink [--slant:8px]">
              <Arrow />
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function caption(h: Highlight) {
  const { winner, loser } = headline(h);
  return `${winner} K.O.s ${loser} with ${h.move}${h.combo >= 2 ? `, ${h.combo}-hit combo` : ''}`;
}

/** Round clock at the K.O., as the HUD would have shown it: 0:23 in. */
function clock(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `K.O. at ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function ago(at: number) {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}
