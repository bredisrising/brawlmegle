import { useEffect, useMemo, useRef } from 'react';
import { useGameStore } from '../game/store';
import { PLAYER_COLORS } from '../game/constants';
import type { PlayerId } from '../types';
import { easeOut, kf, linear, splitName } from '../director/walkoutTiming';
import { useGame } from './GameContext';

// The fire VS is painted in the graffiti font: load it now so it's ready by the end of the walkout.
if (typeof document !== 'undefined' && document.fonts) void document.fonts.load('400 1em "Rubik Wet Paint"');

/** Dev: `?walkoutClock=1` shows the walkout's clock (for checking the cuts against the music). */
const CLOCK = import.meta.env.DEV && new URLSearchParams(window.location.search).get('walkoutClock') === '1';
const INK = '#0b0a10';

/**
 * The walkout's few 2D touches over the 3D entrance (director/Walkout.ts): cinema bars, the white flash it opens out
 * of, an info plate for each fighter during their shot, the gold flash into the fire VS. Everything is posed every
 * frame from the director's clock (no CSS animations), so it stays locked to the music and the 3D.
 */
export function Walkout() {
  const on = useGameStore((s) => s.walkout);
  if (!on) return null;
  return <WalkoutTitles />;
}

type Frame = (t: number) => void;
type Use = <T extends HTMLElement>(pose: (t: number, el: T) => void) => (el: T | null) => (() => void) | undefined;

function WalkoutTitles() {
  const game = useGame();
  const root = useRef<HTMLDivElement>(null);
  const frames = useRef(new Set<Frame>());
  const host = useGameStore((s) => s.role !== 'client');

  useEffect(() => {
    let id = 0;
    const loop = () => {
      id = requestAnimationFrame(loop);
      const t = game.walkout.t;
      if (t < 0) return;
      root.current?.setAttribute('data-t', t.toFixed(2));
      for (const f of frames.current) f(t);
    };
    loop();
    return () => cancelAnimationFrame(id);
  }, [game]);

  /** Register an element to be posed every frame. */
  const use: Use = useMemo(
    () =>
      <T extends HTMLElement>(pose: (t: number, el: T) => void) =>
      (el: T | null) => {
        if (!el) return;
        const f: Frame = (t) => pose(t, el);
        frames.current.add(f);
        f(Math.max(0, game.walkout.t));
        return () => void frames.current.delete(f);
      },
    [game],
  );
  const B = () => game.walkout.beats;

  return (
    <div
      ref={root}
      data-walkout=""
      data-t="0"
      // --bar: the cinema bars' height (2.39:1 on a wide screen, capped; none on a tall phone screen).
      className="pointer-events-none absolute inset-0 overflow-hidden [--bar:min(13vh,max(0px,calc((100vh-100vw/2.39)/2)))] portrait:[--bar:0px]"
    >
      {/* Cinema bars (2.39:1) through the entrance; they open for the fire VS. */}
      {(['top', 'bottom'] as const).map((side) => (
        <div
          key={side}
          ref={use<HTMLDivElement>((t, el) => {
            const k = 1 - easeOut((t - B().vs) / 0.3);
            el.style.transform = `scaleY(${k})`;
          })}
          className={`absolute inset-x-0 ${side === 'top' ? 'top-0 origin-top' : 'bottom-0 origin-bottom'}`}
          style={{ height: 'var(--bar)', background: INK }}
        />
      ))}
      <Plate id="p1" use={use} beats={B} />
      <Plate id="p2" use={use} beats={B} />
      {/* The white it opens out of (the flash out of the menus), clearing as the beat drops; the gold flash into the VS. */}
      <div
        ref={use<HTMLDivElement>((t, el) => void (el.style.opacity = String(kf(t, [[B().open - 0.22, 1], [B().open + 0.08, 0]], linear))))}
        className="absolute inset-0 bg-paper"
      />
      <div
        ref={use<HTMLDivElement>((t, el) => {
          const u = t - B().vs;
          el.style.opacity = String(u < 0 ? 0 : kf(u, [[0, 0.95], [0.06, 0.95], [0.4, 0]], linear));
        })}
        className="absolute inset-0"
        style={{ opacity: 0, background: 'radial-gradient(circle at 50% 55%, #fffbe8 0%, #ffe39a 55%, #ffb547 100%)' }}
      />
      {CLOCK && <div ref={use<HTMLDivElement>((t, el) => void (el.textContent = t.toFixed(2)))} className="absolute left-2 top-2 bg-ink px-2 font-mono text-xl text-hp" />}
      {host && (
        <div
          ref={use<HTMLDivElement>((t, el) => void (el.style.opacity = String(kf(t, [[0.6, 0], [1.0, 0.6], [B().vs - 0.3, 0.6], [B().vs, 0]]))))}
          className="absolute bottom-[calc(var(--bar)+12px)] right-4 font-cond text-xs font-bold uppercase tracking-[0.3em] text-paper/80 sm:right-8"
          style={{ opacity: 0 }}
        >
          Any key · skip
        </div>
      )}
    </div>
  );
}

/** The fighter's info plate, low on their side of the frame, coming in partway through their shot. */
function Plate({ id, use, beats }: { id: PlayerId; use: Use; beats: () => { p1: number; p2: number; two: number } }) {
  const player = useGameStore((s) => s.players[id]);
  const { name, tag } = splitName(player.name);
  const p1 = id === 'p1';
  const color = PLAYER_COLORS[id];
  const ref = use<HTMLDivElement>((t, el) => {
    const B = beats();
    const from = (p1 ? B.p1 + 1.1 : B.p2 + 0.8) - 0.45;
    const to = (p1 ? B.p2 : B.two) - 0.05;
    const k = Math.min(easeOut((t - from) / 0.45), 1 - easeOut((t - to + 0.3) / 0.3));
    el.style.opacity = String(Math.max(0, k));
    el.style.transform = `translateX(${(1 - Math.max(0, k)) * (p1 ? -24 : 24)}px)`;
  });
  return (
    <div
      ref={ref}
      className={`absolute bottom-[calc(var(--bar)+5vh)] flex flex-col gap-1 ${p1 ? 'left-[5vw] items-start' : 'right-[5vw] items-end'}`}
      style={{ opacity: 0 }}
    >
      <div className={`flex items-center gap-2 font-cond text-xs font-bold uppercase tracking-[0.3em] text-paper/75 sm:text-sm ${p1 ? '' : 'flex-row-reverse'}`}>
        <span className="px-1.5 py-0.5 font-display tracking-normal text-ink" style={{ background: color }}>
          {p1 ? 'P1' : 'P2'}
        </span>
        <span>{tag ?? 'Information'}</span>
      </div>
      <div className="max-w-[40vw] truncate font-display text-3xl uppercase leading-none tracking-tight text-paper drop-shadow-[0_2px_8px_rgba(0,0,0,0.7)] sm:text-5xl">
        {name}
      </div>
      <div className="h-[3px] w-24 sm:w-32" style={{ background: `linear-gradient(${p1 ? 90 : 270}deg, ${color}, transparent)` }} />
    </div>
  );
}
