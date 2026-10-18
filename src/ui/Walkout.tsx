import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useGameStore } from '../game/store';
import { PLAYER_COLORS } from '../game/constants';
import type { PlayerId } from '../types';
import { WALKOUT, backOut, easeOut, kf, linear, smoothstep, splitName } from '../director/walkoutTiming';
import { useGame } from './GameContext';

// Load the graffiti fonts now, so the first slam isn't blank while they download.
if (typeof document !== 'undefined' && document.fonts) {
  void document.fonts.load('1em "Permanent Marker"');
  void document.fonts.load('1em "Rubik Wet Paint"');
}

/** Dev: `?walkoutClock=1` shows the walkout's clock (for checking the cuts against the music). */
const CLOCK = import.meta.env.DEV && new URLSearchParams(window.location.search).get('walkoutClock') === '1';
const INK = '#0b0a10';
const PAPER = '#f3f0e8';
const YELLOW = '#ffd400';
const W = WALKOUT;

/**
 * The walkout's titles over the 3D shots (director/Walkout.ts): letterbox, each fighter's graffiti name slam (paint
 * splat, torn-paper tag, their card art as a cut-out photo), then the VS split with READY?. Everything is posed every
 * frame from the director's clock (no CSS animations), so it stays locked to the music and to the 3D.
 */
export function Walkout() {
  const on = useGameStore((s) => s.walkout);
  if (!on) return null;
  return <WalkoutTitles />;
}

type Frame = (t: number) => void;

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
  const use = useMemo(
    () =>
      <T extends HTMLElement | SVGElement>(pose: (t: number, el: T) => void) =>
      (el: T | null) => {
        if (!el) return;
        const f: Frame = (t) => pose(t, el);
        frames.current.add(f);
        f(Math.max(0, game.walkout.t));
        return () => void frames.current.delete(f);
      },
    [game],
  );

  return (
    <div ref={root} data-walkout="" data-t="0" className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Vignette: the shots are lit by the fire, the edges fall off to ink. */}
      <div
        ref={use((t, el) => {
          el.style.opacity = String(t < W.vs ? 1 : kf(t, [[W.vs, 1], [W.vs + 0.3, 0.55]]));
        })}
        className="absolute inset-0"
        style={{ background: `radial-gradient(ellipse 75% 70% at 50% 45%, transparent 40%, ${INK}cc 100%)` }}
      />
      <Letterbox use={use} />
      <NameCard id="p1" use={use} />
      <NameCard id="p2" use={use} />
      <VsSplit use={use} />
      {/* A white hit on each slam, and the flash out into ROUND 1. */}
      <div
        ref={use((t, el) => {
          const hit = Math.max(pulse(t, W.p1Slam, 0.11), pulse(t, W.p2Slam, 0.11), pulse(t, W.vs, 0.12));
          el.style.opacity = String(Math.max(hit * 0.55, kf(t, [[W.flash, 0], [W.end, 0.9]], linear)));
        })}
        className="absolute inset-0 bg-paper"
        style={{ opacity: 0 }}
      />
      {CLOCK && (
        <div
          ref={use((t, el) => void (el.textContent = t.toFixed(2)))}
          className="absolute left-2 top-[11vh] bg-ink px-2 font-mono text-2xl text-hp"
        />
      )}
      {host && (
        <div
          ref={use((t, el) => void (el.style.opacity = String(kf(t, [[0.4, 0], [0.7, 0.75], [W.flash - 0.2, 0.75], [W.flash, 0]]))))}
          className="absolute bottom-[3vh] right-4 font-cond text-xs font-bold uppercase tracking-[0.3em] text-paper/80 sm:right-8 sm:text-sm"
          style={{ opacity: 0 }}
        >
          Any key · skip
        </div>
      )}
    </div>
  );
}

type Use = <T extends HTMLElement | SVGElement>(pose: (t: number, el: T) => void) => (el: T | null) => (() => void) | undefined;

/** 1 at `at`, falling off over `len` seconds. */
function pulse(t: number, at: number, len: number) {
  return t >= at && t < at + len ? 1 - (t - at) / len : 0;
}

/** Cinema bars for the solo shots; they open up for the VS. */
function Letterbox({ use }: { use: Use }) {
  const bar = () =>
    use<HTMLDivElement>((t, el) => {
      const k = t < W.vs ? easeOut(t / 0.18) : 1 - easeOut((t - W.vs) / 0.2);
      el.style.transform = `scaleY(${k})`;
    });
  return (
    <>
      <div ref={bar()} className="absolute inset-x-0 top-0 h-[10vh] origin-top" style={{ background: INK }} />
      <div ref={bar()} className="absolute inset-x-0 bottom-0 h-[10vh] origin-bottom" style={{ background: INK }} />
    </>
  );
}

/**
 * One fighter's name slam, on the side of the frame they're not standing on: a paint splat in their color, their card
 * art as a torn cut-out, a torn-paper tag, the name in brush graffiti with a spray swoosh under it.
 */
function NameCard({ id, use }: { id: PlayerId; use: Use }) {
  const player = useGameStore((s) => s.players[id]);
  const { name, tag } = splitName(player.name);
  const color = PLAYER_COLORS[id];
  const p1 = id === 'p1';
  const slam = p1 ? W.p1Slam : W.p2Slam;
  const hit = p1 ? W.p1Hit : W.p2Hit;
  const out = p1 ? W.wipe1 : W.wipe2;
  const label = p1 ? 'P1' : 'P2';
  const sub = tag ?? (p1 ? 'Player 1' : 'Player 2');
  const size = nameSize(name);

  const card = use<HTMLDivElement>((t, el) => {
    const u = t - slam;
    const shown = u >= 0 && t < out + 0.3;
    el.style.visibility = shown ? 'visible' : 'hidden';
    if (!shown) return;
    // Burns away as the wipe reaches it: sinks back and fades.
    const gone = smoothstep((t - out - 0.02) / 0.14);
    el.style.opacity = String(1 - gone);
    const drift = 1 + 0.045 * smoothstep(u / 1.2);
    el.style.transform = `translate(${p1 ? 0 : 0}px, ${gone * 20}px) scale(${drift * (1 - 0.06 * gone)})`;
  });
  const splat = use<SVGSVGElement>((t, el) => {
    const u = t - slam;
    el.style.transform = `rotate(${p1 ? -10 : 8}deg) scale(${0.15 + 0.85 * backOut(u / 0.13)})`;
  });
  const splat2 = use<SVGSVGElement>((t, el) => {
    const u = t - hit;
    el.style.opacity = u >= 0 ? '1' : '0';
    el.style.transform = `rotate(${p1 ? 24 : -30}deg) scale(${u >= 0 ? 0.2 + 0.8 * backOut(u / 0.12) : 0})`;
  });
  const nameRef = use<HTMLDivElement>((t, el) => {
    const u = t - slam;
    const s = kf(u, [[0, 2.6], [0.07, 0.93], [0.13, 1.03], [0.2, 1]], linear);
    const shake = Math.sin(u * 95) * 7 * Math.exp(-u * 11);
    el.style.transform = `translateX(${shake}px) rotate(${p1 ? -6 : 5}deg) skewX(-8deg) scale(${s})`;
    el.style.opacity = String(kf(u, [[0, 0], [0.03, 1]], linear));
  });
  const swoosh = use<SVGPathElement>((t, el) => {
    el.style.strokeDashoffset = String(1 - easeOut((t - slam - 0.06) / 0.2));
  });
  const tagRef = use<HTMLDivElement>((t, el) => {
    const k = easeOut((t - slam - 0.07) / 0.16);
    el.style.transform = `translateX(${(1 - k) * (p1 ? -140 : 140)}%) rotate(${p1 ? -4 : 3}deg)`;
  });
  const photo = use<HTMLDivElement>((t, el) => {
    const u = t - slam - 0.03;
    const k = backOut(u / 0.16);
    el.style.opacity = u >= 0 ? '1' : '0';
    el.style.transform = `translateY(${(1 - k) * -60}px) rotate(${(p1 ? 7 : -7) + (1 - k) * (p1 ? 20 : -20)}deg) scale(${0.6 + 0.4 * k})`;
  });

  return (
    <div
      ref={card}
      className={`absolute top-[25vh] bottom-[11vh] flex w-[58vw] flex-col justify-center ${p1 ? 'right-[3vw] items-end' : 'left-[3vw] items-start'}`}
      style={{ visibility: 'hidden', transformOrigin: p1 ? '70% 55%' : '30% 55%' }}
    >
      <div className="relative">
        {/* Paint: a big splat in their color, halftoned, and a yellow one that pops on the next hit. */}
        <svg ref={splat} viewBox="-100 -100 200 200" className="absolute left-1/2 top-1/2 -ml-[min(26vw,46vh)] -mt-[min(26vw,46vh)] h-[min(52vw,92vh)] w-[min(52vw,92vh)]">
          <defs>
            <pattern id={`dots-${id}`} width="7" height="7" patternUnits="userSpaceOnUse">
              <circle cx="3.5" cy="3.5" r="1.6" fill={INK} opacity="0.35" />
            </pattern>
          </defs>
          <path d={splatPath(p1 ? 11 : 23, 0.62)} fill={color} />
          <path d={splatPath(p1 ? 11 : 23, 0.62)} fill={`url(#dots-${id})`} />
        </svg>
        <svg ref={splat2} viewBox="-100 -100 200 200" className={`absolute top-[-30%] h-[min(22vw,40vh)] w-[min(22vw,40vh)] ${p1 ? 'right-[-6%]' : 'left-[-6%]'}`} style={{ opacity: 0 }}>
          <path d={splatPath(p1 ? 5 : 41, 0.5)} fill={YELLOW} />
        </svg>
        {player.portraitUrl && (
          <div
            ref={photo}
            className={`absolute bottom-[78%] h-[min(24vw,34vh)] w-[min(18vw,26vh)] ${p1 ? 'right-[-3%]' : 'left-[-3%]'}`}
            style={{ opacity: 0, filter: 'drop-shadow(6px 8px 0 rgba(11,10,16,0.7))' }}
          >
            <div className="h-full w-full bg-paper p-[6px]" style={{ clipPath: tornRect(p1 ? 3 : 9) }}>
              <img
                src={player.portraitUrl}
                alt=""
                className="h-full w-full object-cover object-top"
                style={{ filter: 'grayscale(1) contrast(1.35) brightness(1.05)' }}
              />
            </div>
          </div>
        )}
        <div ref={nameRef} className="relative" style={{ opacity: 0, transformOrigin: p1 ? '80% 60%' : '20% 60%' }}>
          <Brush size={size} color={color}>
            {name}
          </Brush>
          <svg viewBox="0 0 400 40" preserveAspectRatio="none" className={`absolute -bottom-[0.18em] h-[0.42em] w-[92%] ${p1 ? 'right-0' : 'left-0'}`} style={{ fontSize: size }}>
            <path
              ref={swoosh}
              d="M6 28 C 90 6, 210 34, 394 12"
              pathLength={1}
              fill="none"
              stroke={YELLOW}
              strokeWidth="11"
              strokeLinecap="round"
              strokeDasharray="1"
              strokeDashoffset="1"
            />
          </svg>
        </div>
        <div ref={tagRef} className={`absolute -top-[2.6rem] sm:-top-[3.2rem] ${p1 ? 'left-[2%]' : 'right-[2%]'}`}>
          <div className="flex items-stretch bg-paper py-1 pl-2 pr-3 text-ink shadow-[5px_5px_0_rgba(11,10,16,0.8)]" style={{ clipPath: tornStrip(p1 ? 2 : 6) }}>
            <span className="grid place-items-center px-2 font-display text-lg leading-none text-paper sm:text-2xl" style={{ background: color }}>
              {label}
            </span>
            <span className="grid place-items-center pl-2 font-display text-base uppercase leading-none tracking-tight sm:text-xl">{sub}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Brush graffiti type: paper fill, a thick ink keyline, a hard drop in the player's color. */
function Brush({ size, color, children, style }: { size: string; color: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      className="whitespace-nowrap font-brush uppercase leading-[0.95]"
      style={{
        fontSize: size,
        color: PAPER,
        WebkitTextStroke: `0.045em ${INK}`,
        paintOrder: 'stroke fill',
        textShadow: `0.05em 0.06em 0 ${color}, 0.09em 0.11em 0 ${INK}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Big, but the whole name always fits the half of the screen it has. */
function nameSize(name: string) {
  const n = Math.max(3, name.length);
  return `min(12vw, 21vh, ${(52 / (n * 0.66)).toFixed(2)}vw)`;
}

/** VS: the screen splits on a diagonal (each side washed in its fighter's color), VS slams in dripping paint, names, READY?. */
function VsSplit({ use }: { use: Use }) {
  const players = useGameStore((s) => s.players);
  const p1 = splitName(players.p1.name);
  const p2 = splitName(players.p2.name);

  const layer = use<HTMLDivElement>((t, el) => {
    el.style.visibility = t >= W.vs ? 'visible' : 'hidden';
  });
  const wash = (left: boolean) =>
    use<HTMLDivElement>((t, el) => {
      const k = easeOut((t - W.vs) / 0.22);
      el.style.transform = `translateX(${(1 - k) * (left ? -100 : 100)}%)`;
    });
  const slash = use<HTMLDivElement>((t, el) => {
    const k = easeOut((t - W.vs) / 0.14);
    el.style.transform = `rotate(14deg) scaleY(${k})`;
  });
  const vs = use<HTMLDivElement>((t, el) => {
    const u = t - W.vs;
    const s = kf(u, [[0, 3.2], [0.08, 0.9], [0.14, 1.06], [0.22, 1]], linear);
    // Throbs on the next stabs.
    const throb = 1 + 0.07 * (pulse(t, 4.07, 0.14) + pulse(t, W.ready, 0.16));
    const shake = Math.sin(u * 90) * 9 * Math.exp(-u * 10);
    el.style.transform = `translate(${shake}px, ${-shake * 0.4}px) rotate(-7deg) scale(${s * throb})`;
    el.style.opacity = String(kf(u, [[0, 0], [0.03, 1]], linear));
  });
  const vsSplat = use<SVGSVGElement>((t, el) => {
    el.style.transform = `rotate(-20deg) scale(${0.1 + 0.9 * backOut((t - W.vs - 0.02) / 0.14)})`;
  });
  const name = (left: boolean) =>
    use<HTMLDivElement>((t, el) => {
      const k = easeOut((t - W.vs - 0.06) / 0.22);
      el.style.transform = `translateX(${(1 - k) * (left ? -120 : 120)}%)`;
    });
  const ready = use<HTMLDivElement>((t, el) => {
    const u = t - W.ready;
    el.style.opacity = u >= 0 ? '1' : '0';
    el.style.transform = `rotate(-4deg) scale(${u >= 0 ? 0.3 + 0.7 * backOut(u / 0.12) : 0})`;
  });

  return (
    <div ref={layer} className="absolute inset-0" style={{ visibility: 'hidden' }}>
      <div ref={wash(true)} className="absolute inset-y-0 left-0 w-1/2" style={{ background: `linear-gradient(90deg, ${PLAYER_COLORS.p1}66, transparent 85%)` }} />
      <div ref={wash(false)} className="absolute inset-y-0 right-0 w-1/2" style={{ background: `linear-gradient(270deg, ${PLAYER_COLORS.p2}66, transparent 85%)` }} />
      {/* The split: two slashes of color meeting in the middle. */}
      <div ref={slash} className="absolute left-1/2 top-[-20%] h-[140%] w-[14px] -translate-x-1/2" style={{ transformOrigin: '50% 50%' }}>
        <div className="absolute inset-y-0 left-0 w-1/2" style={{ background: PLAYER_COLORS.p1, boxShadow: `0 0 24px ${PLAYER_COLORS.p1}` }} />
        <div className="absolute inset-y-0 right-0 w-1/2" style={{ background: PLAYER_COLORS.p2, boxShadow: `0 0 24px ${PLAYER_COLORS.p2}` }} />
      </div>
      <div className="absolute inset-0 grid place-items-center">
        <div className="relative grid place-items-center">
          <svg ref={vsSplat} viewBox="-100 -100 200 200" className="absolute h-[min(40vw,62vh)] w-[min(40vw,62vh)]">
            <path d={splatPath(77, 0.6)} fill={INK} opacity="0.88" />
          </svg>
          <div
            ref={vs}
            className="relative font-drip leading-none"
            style={{
              fontSize: 'min(22vw, 36vh)',
              color: YELLOW,
              WebkitTextStroke: `0.03em ${INK}`,
              paintOrder: 'stroke fill',
              textShadow: `0.04em 0.05em 0 ${PLAYER_COLORS.p1}, -0.04em 0.05em 0 ${PLAYER_COLORS.p2}`,
              opacity: 0,
            }}
          >
            VS
          </div>
          <div ref={ready} className="absolute top-[88%]" style={{ opacity: 0 }}>
            <div className="bg-paper px-5 py-1.5 font-display text-2xl uppercase leading-none tracking-tight text-ink shadow-[6px_6px_0_rgba(11,10,16,0.85)] sm:text-4xl" style={{ clipPath: tornStrip(4) }}>
              Ready?
            </div>
          </div>
        </div>
      </div>
      <div className="absolute inset-x-[3vw] bottom-[6vh] flex items-end justify-between gap-4">
        <div ref={name(true)} className="flex min-w-0 flex-col items-start">
          <Tag color={PLAYER_COLORS.p1} label="P1" sub={p1.tag} />
          <Brush size={vsNameSize(p1.name)} color={PLAYER_COLORS.p1}>
            {p1.name}
          </Brush>
        </div>
        <div ref={name(false)} className="flex min-w-0 flex-col items-end">
          <Tag color={PLAYER_COLORS.p2} label="P2" sub={p2.tag} />
          <Brush size={vsNameSize(p2.name)} color={PLAYER_COLORS.p2}>
            {p2.name}
          </Brush>
        </div>
      </div>
    </div>
  );
}

function vsNameSize(name: string) {
  const n = Math.max(3, name.length);
  return `min(6.5vw, 11vh, ${(40 / (n * 0.66)).toFixed(2)}vw)`;
}

function Tag({ color, label, sub }: { color: string; label: string; sub: string | null }) {
  return (
    <div className="mb-1 flex items-stretch gap-1">
      <span className="slant px-2.5 py-0.5 font-display text-sm text-ink [--slant:6px] sm:text-base" style={{ background: color }}>
        {label}
      </span>
      {sub && <span className="slant bg-paper px-2.5 py-0.5 font-display text-sm uppercase text-ink [--slant:6px] sm:text-base">{sub}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paint and paper shapes (seeded, so both laptops draw the same ones).
// ---------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** A paint splat in a 200x200 box around 0,0: a lumpy blob with spiky throws and a few droplets around it. */
function splatPath(seed: number, size: number) {
  const r = rng(seed);
  const R = 70 * size + 18;
  const n = 26;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const spike = r() < 0.3 ? 1.25 + r() * 0.35 : 0.82 + r() * 0.22;
    pts.push([Math.cos(a) * R * spike, Math.sin(a) * R * spike]);
  }
  // Smooth closed curve through the points (midpoint quadratic).
  const mid = (p: [number, number], q: [number, number]) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  let d = `M${mid(pts[n - 1], pts[0]).map((v) => v.toFixed(1)).join(' ')}`;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const m = mid(p, pts[(i + 1) % n]);
    d += ` Q${p[0].toFixed(1)} ${p[1].toFixed(1)} ${m[0].toFixed(1)} ${m[1].toFixed(1)}`;
  }
  d += 'Z';
  for (let i = 0; i < 7; i++) {
    const a = r() * Math.PI * 2;
    const dist = R * (1.25 + r() * 0.45);
    const rad = 2 + r() * 6;
    const x = Math.cos(a) * dist;
    const y = Math.sin(a) * dist;
    d += ` M${(x - rad).toFixed(1)} ${y.toFixed(1)} a${rad.toFixed(1)} ${rad.toFixed(1)} 0 1 0 ${(2 * rad).toFixed(1)} 0 a${rad.toFixed(1)} ${rad.toFixed(1)} 0 1 0 ${(-2 * rad).toFixed(1)} 0Z`;
  }
  return d;
}

/** A torn-paper rectangle (all four edges ragged), as a clip-path. */
function tornRect(seed: number) {
  const r = rng(seed);
  const pts: string[] = [];
  const edge = (from: [number, number], to: [number, number], steps: number, inward: [number, number]) => {
    for (let i = 0; i < steps; i++) {
      const k = i / steps;
      const j = r() * 3.2;
      pts.push(`${(from[0] + (to[0] - from[0]) * k + inward[0] * j).toFixed(1)}% ${(from[1] + (to[1] - from[1]) * k + inward[1] * j).toFixed(1)}%`);
    }
  };
  edge([0, 0], [100, 0], 14, [0, 1]);
  edge([100, 0], [100, 100], 18, [-1, 0]);
  edge([100, 100], [0, 100], 14, [0, -1]);
  edge([0, 100], [0, 0], 18, [1, 0]);
  return `polygon(${pts.join(',')})`;
}

/** A torn strip of paper: straight top and bottom, ragged ends. */
function tornStrip(seed: number) {
  const r = rng(seed);
  const pts: string[] = [];
  // Down the left end, then back up the right end.
  for (let i = 0; i <= 6; i++) pts.push(`${(r() * 4).toFixed(1)}% ${((i / 6) * 100).toFixed(1)}%`);
  for (let i = 6; i >= 0; i--) pts.push(`${(100 - r() * 4).toFixed(1)}% ${((i / 6) * 100).toFixed(1)}%`);
  return `polygon(${pts.join(',')})`;
}
