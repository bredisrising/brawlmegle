import { useEffect, useRef, useState } from 'react';
import type { InputSource } from '../input/InputSource';
import type { Landmark, PoseFrame } from '../types';
import { localPlayerId, useGameStore } from '../game/store';
import { useGame } from './GameContext';

const LANDMARK_NAMES = [
  'nose', 'left eye (inner)', 'left eye', 'left eye (outer)', 'right eye (inner)', 'right eye', 'right eye (outer)',
  'left ear', 'right ear', 'mouth (left)', 'mouth (right)', 'left shoulder', 'right shoulder', 'left elbow',
  'right elbow', 'left wrist', 'right wrist', 'left pinky', 'right pinky', 'left index', 'right index', 'left thumb',
  'right thumb', 'left hip', 'right hip', 'left knee', 'right knee', 'left ankle', 'right ankle', 'left heel',
  'right heel', 'left foot index', 'right foot index',
];
const BONES: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12]];
const KEY_POINTS = new Set([0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]);
type Position = { x: number; y: number } | null;

/** Development-only, movable camera monitor. Press D, then drag its title bar. */
export function PoseDebugOverlay() {
  const game = useGame();
  const role = useGameStore((s) => s.role);
  const [open, setOpen] = useState(new URLSearchParams(window.location.search).get('debugPose') === '1');
  const [source, setSource] = useState<InputSource | null>(null);
  const [frame, setFrame] = useState<PoseFrame | null>(null);
  const [tracking, setTracking] = useState(false);
  const [position, setPosition] = useState<Position>(null);
  const drag = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'KeyD' && !(event.target instanceof HTMLInputElement)) setOpen((value) => !value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let raf = 0;
    let lastUiUpdate = 0;
    const poll = (now: number) => {
      const current = game.localInputSource();
      setSource((old) => old === current ? old : current);
      if (now - lastUiUpdate > 100) {
        setFrame(current?.latestFrame ?? null);
        setTracking(current?.tracking ?? false);
        lastUiUpdate = now;
      }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [game, role]);

  if (!import.meta.env.DEV) return null;
  const player = localPlayerId(role);
  const video = source?.video;
  const dragStart = (event: React.PointerEvent<HTMLElement>) => {
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    drag.current = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPosition({ x: rect.left, y: rect.top });
  };
  const dragMove = (event: React.PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const panel = event.currentTarget.parentElement;
    const width = panel?.clientWidth ?? 480;
    const height = panel?.clientHeight ?? 500;
    setPosition({
      x: clamp(event.clientX - current.dx, 0, Math.max(0, window.innerWidth - width)),
      y: clamp(event.clientY - current.dy, 0, Math.max(0, window.innerHeight - height)),
    });
  };
  const dragEnd = (event: React.PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  return (
    <>
      <button type="button" onClick={() => setOpen((value) => !value)} className="pointer-events-auto absolute right-3 top-3 z-50 border border-cyan-300/50 bg-black/80 px-3 py-2 font-mono text-xs font-bold uppercase tracking-wider text-cyan-200 shadow-lg">
        {open ? 'Close pose debug [D]' : 'Pose debug [D]'}
      </button>
      {open && (
        <section
          style={position ? { left: position.x, top: position.y } : undefined}
          className={`pointer-events-auto fixed z-50 flex w-[min(96vw,480px)] max-h-[min(82dvh,720px)] flex-col overflow-hidden border border-cyan-300/60 bg-slate-950/95 font-mono text-xs text-white shadow-2xl ${position ? '' : 'bottom-3 right-3'}`}
        >
          <header
            onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd}
            className="flex touch-none cursor-grab items-center justify-between border-b border-white/15 px-3 py-2 active:cursor-grabbing"
          >
            <div>
              <h2 className="font-bold uppercase tracking-widest text-cyan-200">Live Pose Monitor · {player.toUpperCase()}</h2>
              <p className={tracking ? 'mt-1 text-emerald-300' : 'mt-1 text-amber-300'}>{source?.kind === 'camera' ? tracking ? 'BODY TRACKED' : 'CAMERA READY · NO BODY DETECTED' : source ? `SOURCE: ${source.kind.toUpperCase()}` : 'WAITING FOR CAMERA'}</p>
            </div>
            <div className="flex items-center gap-2"><span className="text-[10px] text-white/35">DRAG</span><button onPointerDown={(event) => event.stopPropagation()} onClick={() => setOpen(false)} className="px-2 py-1 text-lg leading-none text-white/50 hover:text-white" aria-label="Close pose monitor">×</button></div>
          </header>
          <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden bg-black">
            <PoseCanvas frame={frame} video={video} />
            {!video && <div className="absolute inset-0 grid place-items-center px-8 text-center text-white/45">Start the local camera input to see the feed and detected points.</div>}
            {video && !tracking && <div className="absolute left-2 top-2 bg-black/70 px-2 py-1 text-amber-200">Waiting for a full body in frame</div>}
          </div>
          <div className="grid grid-cols-3 gap-2 border-b border-white/10 px-3 py-2 text-[10px] text-white/60 sm:text-xs"><span>FRAME <b className="text-white">{frame ? `${frame.image.length} points` : '—'}</b></span><span>MODEL <b className="text-white">Pose Lite</b></span><span>INPUT <b className="text-white">{source?.kind ?? 'none'}</b></span></div>
          <div className="min-h-0 overflow-auto"><table className="min-w-[610px] w-full border-collapse text-left"><thead className="sticky top-0 bg-slate-900 text-[10px] uppercase tracking-wide text-white/50"><tr><th className="px-3 py-2">Landmark</th><th className="px-2 py-2">Image x,y</th><th className="px-2 py-2">World x,y,z · m</th><th className="px-2 py-2">Vis</th></tr></thead><tbody>{LANDMARK_NAMES.map((name, index) => { const image = frame?.image[index]; const world = frame?.world[index]; return <tr key={name} className={`border-t border-white/5 ${KEY_POINTS.has(index) ? 'text-cyan-100' : 'text-white/55'}`}><td className="px-3 py-1">{index.toString().padStart(2, '0')} {name}</td><td className="px-2 py-1 tabular-nums">{image ? `${fmt(image.x)}, ${fmt(image.y)}` : '—'}</td><td className="px-2 py-1 tabular-nums">{world ? `${fmt(world.x)}, ${fmt(world.y)}, ${fmt(world.z)}` : '—'}</td><td className="px-2 py-1 tabular-nums">{image ? `${Math.round(image.visibility * 100)}%` : '—'}</td></tr>; })}</tbody></table></div>
          <footer className="border-t border-white/10 px-3 py-2 text-[10px] text-white/45">Image coordinates are normalized 0–1 from the top-left. World coordinates are hip-centered meters.</footer>
        </section>
      )}
    </>
  );
}

function PoseCanvas({ frame, video }: { frame: PoseFrame | null; video?: HTMLVideoElement }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let raf = 0;
    const draw = () => {
      const width = canvas.clientWidth; const height = canvas.clientHeight; const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
      if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) { context.save(); context.translate(width, 0); context.scale(-1, 1); context.drawImage(video, 0, 0, width, height); context.restore(); }
      const points = frame?.image;
      if (points?.length) {
        context.lineWidth = 2; context.strokeStyle = 'rgba(34, 211, 238, 0.8)';
        for (const [a, b] of BONES) { const first = points[a]; const second = points[b]; if (!visible(first) || !visible(second)) continue; context.beginPath(); context.moveTo((1 - first.x) * width, first.y * height); context.lineTo((1 - second.x) * width, second.y * height); context.stroke(); }
        points.forEach((point, index) => { if (!visible(point)) return; const x = (1 - point.x) * width; const y = point.y * height; const key = KEY_POINTS.has(index); context.beginPath(); context.arc(x, y, key ? 4 : 2.2, 0, Math.PI * 2); context.fillStyle = key ? '#facc15' : '#22d3ee'; context.fill(); if (key) { context.font = '10px monospace'; context.lineWidth = 3; context.strokeStyle = 'rgba(0,0,0,0.9)'; context.strokeText(String(index), x + 5, y - 4); context.fillStyle = 'white'; context.fillText(String(index), x + 5, y - 4); } });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw); return () => cancelAnimationFrame(raf);
  }, [frame, video]);
  return <canvas ref={canvasRef} className="absolute inset-0 size-full" />;
}

function visible(point: Landmark | undefined): point is Landmark { return !!point && point.visibility >= 0.35 && Number.isFinite(point.x) && Number.isFinite(point.y); }
function fmt(value: number) { return value.toFixed(2); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
