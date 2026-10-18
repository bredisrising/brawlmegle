import { useEffect, useRef } from 'react';
import type { InputSource } from '../input/InputSource';
import type { Bucket } from '../forge/scanBuckets';
import type { ScanView, Tick } from '../forge/scanGuide';
import type { Landmark, PlayerId } from '../types';
import { PLAYER_COLORS } from '../game/constants';
import { ACCENT } from './accent';
import { Arrow } from './ArcadeButton';

/**
 * The body scan, fighting-game "scan in" style: a round camera view with a progress ring, the front photo after a
 * 3-2-1 (shutter flash, the snapshot drops into its slot), then a slow 360 with a scan line sweeping over the player,
 * ticks lighting up as the sides snap and a little turntable figure showing which way to turn. Everything heavy is
 * CSS over one canvas; the 3D scene behind keeps its own (low) rate. CameraPip shows this while scanning.
 */

type Props = {
  source: InputSource;
  id: PlayerId;
  /** The guide's latest state (null until the first update, e.g. while the camera starts). */
  view: ScanView | null;
  thumbs: Partial<Record<Bucket, string>>;
  /** Text to show before the guide has said anything ("Starting camera"). */
  detail: string;
  onSkip: () => void;
};

const LABEL: Record<Tick, string> = { front: 'Front', left: 'Left', back: 'Back', right: 'Right' };

export function ScanOverlay({ source, id, view, thumbs, detail, onSkip }: Props) {
  const color = PLAYER_COLORS[id];
  const accent = ACCENT[id];
  const stage = view?.stage ?? 'find';
  const turning = stage === 'snap' || stage === 'turn';
  const finished = stage === 'outro' || stage === 'done';
  const order = view?.ticks.map((t) => t.tick) ?? ['front', 'right', 'back', 'left'];
  const sides = order.filter((t): t is 'left' | 'right' => t === 'left' || t === 'right');
  const canSkip = !!view?.canSkip;

  useEffect(() => {
    if (!canSkip) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.code === 'Enter' || e.code === 'KeyS') && !(e.target instanceof HTMLInputElement)) onSkip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canSkip, onSkip]);

  const hint = view?.hint ?? detail;
  const step = stage === 'find' || stage === 'countdown' ? 1 : 2;
  const correcting = !!view?.coachKind && view.coachKind !== 'arms' && (stage === 'find' || stage === 'countdown');

  return (
    <div
      className="scan-stage pointer-events-none fixed inset-0 z-40 flex flex-col items-center justify-center gap-[1.6vh] overflow-hidden bg-ink/95 px-4 py-3"
      style={{ backgroundImage: `radial-gradient(circle at 50% 50%, ${color}2e 0, transparent calc(var(--s) * 0.75)), repeating-linear-gradient(-45deg, rgb(255 255 255 / 0.035) 0 1px, transparent 1px 7px)` }}
    >
      {/* Header: who, which step, and the one thing to do now. */}
      <div className="flex flex-col items-center gap-[0.8vh] text-center">
        <div className="animate-in-l flex items-stretch font-cond text-[clamp(10px,1.7vh,14px)] font-extrabold uppercase tracking-[0.25em]">
          <span className={`slant ${accent.bg} grid place-items-center px-3 font-display tracking-normal text-ink [--slant:8px]`}>{accent.tag}</span>
          <span className="slant -ml-1 bg-paper px-4 py-1 text-ink [--slant:8px]">
            Body scan · {step}/2 {step === 1 ? 'Front photo' : '360 spin'}
          </span>
        </div>
        <h2
          key={hint}
          className="animate-slam max-w-[92vw] font-display portrait:flex portrait:min-h-[1.9em] portrait:items-center portrait:justify-center text-[clamp(1.35rem,5.4vh,3rem)] portrait:text-[min(7vw,2.6rem)] uppercase leading-[0.95] tracking-tight text-paper drop-shadow-[0_3px_0_#0b0b0d]"
        >
          {hint}
        </h2>
      </div>

      <div className="flex items-center gap-[max(4vw,72px)] portrait:flex-col portrait:gap-[2vh]">
        {/* Landscape: the photos on the left. */}
        <Photos className="flex-col portrait:hidden" view={view} thumbs={thumbs} sides={sides} color={color} />

        <div className="relative size-[var(--s)] shrink-0">
          <div className="absolute inset-[7%] overflow-hidden rounded-full bg-ink-2 shadow-[0_0_0_3px_#0b0b0d,0_0_60px_rgb(0_0_0/0.7)]">
            <ScanCamera source={source} color={color} />
            <div className="forge-scanlines pointer-events-none absolute inset-0 rounded-full" />
            {turning && (
              <div className="animate-scan-sweep absolute inset-x-0 top-0 h-full">
                <div className="h-[22%]" style={{ background: `linear-gradient(180deg, transparent, ${color}55)` }} />
                <div className="h-[3px] bg-white" style={{ boxShadow: `0 0 14px 4px ${color}, 0 0 3px 1px #fff` }} />
              </div>
            )}
            {(stage === 'find' || stage === 'countdown') && <Brackets warn={correcting} color={color} />}
            {view?.count != null && (
              <span
                key={view.count}
                className="animate-countdown absolute inset-0 grid place-items-center font-display text-[calc(var(--s)*0.42)] leading-none text-hp"
                style={{ WebkitTextStroke: '0.03em #0b0a10', paintOrder: 'stroke fill', textShadow: `0.04em 0.05em 0 ${color}, 0.07em 0.08em 0 #0b0a10` }}
              >
                {view.count}
              </span>
            )}
            {view && view.flash > 0 && (
              <div
                key={view.flash}
                className="animate-shutter absolute inset-0 rounded-full"
                style={{ background: view.flashOn === 'front' ? '#fff' : `radial-gradient(circle, transparent 45%, ${color} 100%)` }}
              />
            )}
            {finished && <div className="absolute inset-0 bg-ink/40" />}
          </div>
          <Ring view={view} color={color} />
          {finished && (
            <div className="absolute inset-0 grid place-items-center">
              <span className="animate-slam -rotate-6 whitespace-nowrap bg-hp px-[0.4em] py-[0.15em] font-display text-[calc(var(--s)*0.075)] uppercase leading-none tracking-tight text-ink shadow-[0.12em_0.12em_0_#0b0b0d]">
                {view?.skipped ? 'Front locked' : view?.shots.front ? 'Scan complete' : 'No scan'}
              </span>
            </div>
          )}
        </div>

        {/* Landscape: the turn hint and skip on the right. Portrait: everything in a row underneath. */}
        <div className="flex w-[min(20vw,220px)] flex-col items-center gap-[2vh] portrait:w-auto portrait:flex-row portrait:items-end">
          <Photos className="hidden portrait:flex" view={view} thumbs={thumbs} sides={sides} color={color} />
          <Turntable view={view} color={color} />
        </div>
      </div>

      <div className="flex min-h-[calc(clamp(1rem,3vh,1.6rem)*1.3)] flex-col items-center gap-[1vh]">
        <p
          key={view?.coach}
          className={`animate-rise text-center font-cond text-[clamp(1rem,3vh,1.6rem)] font-bold uppercase tracking-[0.12em] ${correcting ? 'text-hp' : 'text-paper/75'}`}
        >
          {view?.coach}
        </p>
        {/* Always laid out (invisible until the front photo is in), so nothing jumps when it appears. */}
        <button
          type="button"
          onClick={onSkip}
          disabled={!canSkip}
          className={`group cut pointer-events-auto inline-flex items-center gap-3 bg-paper px-5 py-2 font-display text-[clamp(0.85rem,2.2vh,1.15rem)] uppercase leading-none tracking-tight text-ink transition-colors hover:bg-hp [--cut:10px] ${canSkip ? 'animate-rise' : 'invisible'}`}
        >
          <span>Done: forge with the front photo</span>
          <kbd className="pointer-coarse:hidden bg-ink px-1.5 py-0.5 font-cond text-[0.75em] tracking-[0.15em] text-paper">Enter</kbd>
          <Arrow />
        </button>
      </div>
    </div>
  );
}

/** Corner brackets framing where the body should be; yellow while there's something to fix. */
function Brackets({ warn, color }: { warn: boolean; color: string }) {
  const stroke = warn ? '#ffd400' : color;
  return (
    <svg viewBox="0 0 100 100" className={`absolute inset-[12%] size-[76%] ${warn ? 'animate-blink' : ''}`} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="square">
      <path d="M22 4 H8 V18 M78 4 H92 V18 M22 96 H8 V82 M78 96 H92 V82" />
    </svg>
  );
}

/**
 * The ring around the camera: graduations, the progress arc (counterclockwise when they turn to their left, which is
 * how it looks in the mirror), a glowing head, and the four marks, which pop when that side's photo snaps.
 */
function Ring({ view, color }: { view: ScanView | null; color: string }) {
  const ring = view?.ring ?? 0;
  const ccw = (view?.dir ?? 1) === 1;
  const r = 46;
  const c = 2 * Math.PI * r;
  const flip = ccw ? 'translate(100 0) scale(-1 1)' : undefined;
  const ticks = view?.ticks ?? (['front', 'right', 'back', 'left'] as Tick[]).map((tick, i) => ({ tick, at: i / 4, hit: false }));
  return (
    <>
      <svg viewBox="0 0 100 100" className="absolute inset-0 size-full overflow-visible">
        <g transform={flip}>
          <circle cx="50" cy="50" r="49.3" fill="none" stroke="rgb(243 240 232 / 0.25)" strokeWidth="0.9" strokeDasharray="0.5 2.08" />
          <circle cx="50" cy="50" r={r} fill="none" stroke="#0b0b0d" strokeWidth="4.2" />
          <circle cx="50" cy="50" r={r} fill="none" stroke="rgb(243 240 232 / 0.14)" strokeWidth="2.6" />
          <circle
            cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - ring)} transform="rotate(-90 50 50)"
            style={{ transition: 'stroke-dashoffset 140ms linear', filter: `drop-shadow(0 0 1.6px ${color})` }}
          />
          {ring > 0 && ring < 1 && (
            <g style={{ transform: `rotate(${ring * 360}deg)`, transformOrigin: '50px 50px', transition: 'transform 140ms linear' }}>
              <circle cx="50" cy={50 - r} r="2.1" fill="#fff" style={{ filter: `drop-shadow(0 0 2px ${color}) drop-shadow(0 0 4px ${color})` }} />
            </g>
          )}
        </g>
      </svg>
      {ticks.map(({ tick, at, hit }) => {
        const a = at * 2 * Math.PI;
        const x = 50 + (ccw ? -1 : 1) * r * Math.sin(a);
        const y = 50 - r * Math.cos(a);
        return (
          <span
            key={`${tick}-${hit}`}
            className={`absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap px-[0.5em] py-[0.2em] font-cond text-[clamp(9px,calc(var(--s)*0.03),14px)] font-extrabold uppercase leading-none tracking-[0.18em] ${
              hit ? 'animate-tick-pop bg-hp text-ink' : 'bg-ink text-paper/60 outline outline-1 outline-paper/25'
            }`}
            style={{ left: `${x}%`, top: `${y}%` }}
          >
            {LABEL[tick]}
            {hit && <span aria-hidden>✓</span>}
          </span>
        );
      })}
    </>
  );
}

/** The photos so far: front, then the sides in the order the turn reaches them. */
function Photos({ view, thumbs, sides, color, className }: { view: ScanView | null; thumbs: Partial<Record<Bucket, string>>; sides: ('left' | 'right')[]; color: string; className: string }) {
  const slots: Bucket[] = ['front', ...sides];
  return (
    <div className={`flex gap-[1.2vh] ${className}`}>
      {slots.map((b) => {
        const src = thumbs[b];
        const optional = b !== 'front';
        return (
          <div
            key={b}
            className="relative aspect-[3/5] h-[calc(var(--s)*0.3)] overflow-hidden bg-ink-2 portrait:h-[calc(var(--s)*0.34)]"
            style={{ outline: src ? `2px solid ${color}` : '2px dashed rgb(243 240 232 / 0.25)', outlineOffset: -2 }}
          >
            {src ? (
              <img key={src.length} src={src} alt="" className={`size-full object-cover ${b === 'front' ? 'animate-slam' : 'animate-rise'}`} style={{ transform: 'scaleX(-1)' }} />
            ) : (
              <Silhouette className="absolute inset-[18%] size-[64%] text-paper/12" side={b} />
            )}
            <span className={`absolute inset-x-0 bottom-0 px-1 py-0.5 text-center font-cond text-[clamp(8px,calc(var(--s)*0.024),12px)] font-extrabold uppercase tracking-[0.16em] ${src ? 'bg-hp text-ink' : 'bg-ink/80 text-paper/50'}`}>
              {b}
              {src ? ' ✓' : optional ? ' · opt' : ''}
            </span>
            {view?.flash && view.flashOn === b && src ? <div key={view.flash} className="animate-shutter absolute inset-0 bg-white" /> : null}
          </div>
        );
      })}
    </div>
  );
}

function Silhouette({ className, side }: { className: string; side: Bucket }) {
  // A plain body outline: front-on, or narrower for a side.
  const w = side === 'front' ? 1 : 0.55;
  return (
    <svg viewBox="0 0 60 100" className={className} fill="currentColor">
      <circle cx="30" cy="14" r="10" />
      <rect x={30 - 16 * w} y="27" width={32 * w} height="40" rx={8 * w} />
      <rect x={30 - 12 * w} y="62" width={10 * w} height="36" rx={4} />
      <rect x={30 + 2 * w} y="62" width={10 * w} height="36" rx={4} />
    </svg>
  );
}

/**
 * Which way to turn: a little figure on a turntable, rotated to where the ring says they should be (so it leads a
 * slow turner), with an arrow the way to go. Its face (the visor) slides across and disappears round the back.
 */
function Turntable({ view, color }: { view: ScanView | null; color: string }) {
  const stage = view?.stage ?? 'find';
  const ring = view?.ring ?? 0;
  const dir = view?.dir ?? 1;
  const th = ring * 2 * Math.PI;
  // In the mirror, turning to your left moves your face toward the screen's left.
  const s = -dir * Math.sin(th);
  const front = Math.cos(th);
  // Shoulders narrow as they turn side-on; legs and hips a little less.
  const sh = 5 + 13 * Math.abs(front);
  const hip = 6 + 6 * Math.abs(front);
  const showArrow = stage === 'snap' || stage === 'turn';
  const flip = dir === 1 ? 'translate(100 0) scale(-1 1)' : undefined;
  const ink = '#24242a';
  return (
    <div className="flex flex-col items-center gap-1">
      <svg viewBox="0 0 100 112" className="h-[calc(var(--s)*0.4)] w-auto overflow-visible">
        {/* Platform, with how far round they are */}
        <ellipse cx="50" cy="94" rx="42" ry="12" fill="rgb(243 240 232 / 0.06)" stroke="rgb(243 240 232 / 0.3)" strokeWidth="1.2" />
        <ellipse cx="50" cy="94" rx="42" ry="12" fill="none" stroke={color} strokeWidth="2.6" strokeDasharray={`${ring * 172} 400`} transform={flip} />
        {/* Figure: legs, torso, head, and a visor for the face */}
        <g stroke={color} strokeWidth="2" strokeLinejoin="round">
          <path d={`M${50 - hip} 62 L${50 - hip * 0.7} 92 L${50 - 1} 92 L50 66 L${50 + 1} 92 L${50 + hip * 0.7} 92 L${50 + hip} 62 Z`} fill={ink} />
          <path d={`M${50 - sh} 38 Q50 34 ${50 + sh} 38 L${50 + hip} 64 L${50 - hip} 64 Z`} fill={ink} />
          <circle cx="50" cy="24" r="10" fill={ink} />
        </g>
        {front > -0.1 && <rect x={50 + s * 6 - 6 * Math.max(0.3, front)} y="21" width={12 * Math.max(0.3, front)} height="4.5" rx="2" fill="#ffd400" />}
        {/* The way to go: an arrow sweeping across the front of the platform */}
        {showArrow && (
          <g transform={flip}>
            <path d="M14 99 Q50 118 84 99" fill="none" stroke="#ffd400" strokeWidth="4" strokeLinecap="round" />
            <path d="M92 94 L86 106 L78 96 Z" fill="#ffd400" />
          </g>
        )}
      </svg>
      <span className="font-cond text-[clamp(10px,calc(var(--s)*0.032),15px)] font-extrabold uppercase tracking-[0.2em] text-paper/70">
        {showArrow ? `Turn to your ${dir === 1 ? 'left' : 'right'}` : stage === 'outro' || stage === 'done' ? 'Done' : 'Face front'}
      </span>
    </div>
  );
}

/** Mirrored webcam, cropped to the circle, with the tracked skeleton in the player's color. */
function ScanCamera({ source, color }: { source: InputSource; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    const draw = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.round(canvas.clientWidth * scale);
      const h = Math.round(canvas.clientHeight * scale);
      if (canvas.width !== w || canvas.height !== h) [canvas.width, canvas.height] = [w, h];
      ctx.clearRect(0, 0, w, h);
      const video = source.video;
      const vw = video?.videoWidth ?? 0, vh = video?.videoHeight ?? 0;
      if (video && vw && vh && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        const side = Math.min(vw, vh);
        const sx = (vw - side) / 2, sy = (vh - side) / 2;
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, sx, sy, side, side, 0, 0, w, h);
        ctx.restore();
        const pts = source.latestFrame?.image;
        if (pts?.length) {
          const px = (p: Landmark) => (1 - (p.x * vw - sx) / side) * w;
          const py = (p: Landmark) => ((p.y * vh - sy) / side) * h;
          ctx.lineWidth = Math.max(2, w / 160);
          ctx.lineCap = 'round';
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.85;
          for (const [a, b] of BONES) {
            if (!seen(pts[a]) || !seen(pts[b])) continue;
            ctx.beginPath();
            ctx.moveTo(px(pts[a]), py(pts[a]));
            ctx.lineTo(px(pts[b]), py(pts[b]));
            ctx.stroke();
          }
          ctx.fillStyle = '#fff';
          for (const i of JOINTS) {
            if (!seen(pts[i])) continue;
            ctx.beginPath();
            ctx.arc(px(pts[i]), py(pts[i]), ctx.lineWidth * 0.9, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [source, color]);
  return <canvas ref={ref} className="absolute inset-0 size-full" />;
}

const BONES: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12]];
const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const seen = (p: Landmark | undefined): p is Landmark => !!p && p.visibility >= 0.35;
