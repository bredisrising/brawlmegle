import { useEffect, useRef, useState } from 'react';
import type { InputSource } from '../input/InputSource';
import type { Landmark, PoseFrame } from '../types';
import { localPlayerId, useGameStore } from '../game/store';
import { useGame } from './GameContext';

const BONES: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12]];

/**
 * The player's own camera with their tracked skeleton and the last move it read. Big while scanning (so you
 * can see yourself turn), a corner picture-in-picture while fighting. C toggles it.
 */
export function CameraPip() {
  const game = useGame();
  const role = useGameStore((s) => s.role);
  const status = useGameStore((s) => s.players[localPlayerId(s.role)].status);
  const detail = useGameStore((s) => s.players[localPlayerId(s.role)].statusDetail);
  const lastMove = useGameStore((s) => s.lastMove);
  const lobby = useGameStore((s) => s.phase === 'lobby');
  const [source, setSource] = useState<InputSource | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let raf = 0;
    const poll = () => {
      const current = game.localInputSource();
      setSource((old) => (old === current ? old : current));
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [game, role]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyC' && !(e.target instanceof HTMLInputElement)) setOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!source?.video || !open) return null;
  const scanning = status === 'scanning';
  const fresh = lastMove && performance.now() - lastMove.at < 1500;
  return (
    <div
      className={`pointer-events-none fixed z-40 overflow-hidden border-2 border-paper/30 bg-black shadow-2xl ${
        scanning
          ? 'left-1/2 top-1/2 w-[min(92vw,720px)] -translate-x-1/2 -translate-y-1/2'
          : lobby
            ? 'bottom-4 left-1/2 w-[min(32vw,240px)] -translate-x-1/2' // between the two "Ready" banners
            : 'bottom-4 left-4 w-[min(32vw,300px)]'
      }`}
    >
      <div className="relative aspect-[4/3]">
        <SkeletonVideo source={source} />
        {scanning && detail && (
          <p className="absolute inset-x-0 top-3 text-center font-display text-3xl uppercase tracking-tight text-paper drop-shadow-[0_2px_6px_#000]">{detail}</p>
        )}
        {!scanning && fresh && (
          <p key={lastMove!.at} className="absolute inset-x-0 bottom-2 text-center font-display text-2xl uppercase tracking-tight text-hp drop-shadow-[0_2px_6px_#000]">
            {lastMove!.text}
          </p>
        )}
        <span className="absolute left-2 top-2 bg-black/70 px-2 py-0.5 font-cond text-[10px] font-bold uppercase tracking-[0.2em] text-paper/70">
          {source.tracking ? 'tracking' : 'step into view'} · C hides
        </span>
      </div>
    </div>
  );
}

/** Mirrored webcam with the pose skeleton drawn on top. */
function SkeletonVideo({ source }: { source: InputSource }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w || canvas.height !== h) [canvas.width, canvas.height] = [w, h];
      ctx.clearRect(0, 0, w, h);
      const video = source.video;
      if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, w, h);
        ctx.restore();
      }
      const frame: PoseFrame | null | undefined = source.latestFrame;
      if (frame?.image.length) {
        const pts = frame.image;
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#ffd34d';
        for (const [a, b] of BONES) {
          if (!seen(pts[a]) || !seen(pts[b])) continue;
          ctx.beginPath();
          ctx.moveTo((1 - pts[a].x) * w, pts[a].y * h);
          ctx.lineTo((1 - pts[b].x) * w, pts[b].y * h);
          ctx.stroke();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [source]);
  return <canvas ref={ref} className="absolute inset-0 size-full" />;
}

const seen = (p: Landmark | undefined): p is Landmark => !!p && p.visibility >= 0.35;
