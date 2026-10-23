import { useCallback, useEffect, useRef, useState } from 'react';
import type { InputSource } from '../input/InputSource';
import { FramingCoach } from '../input/framing';
import { poseWarningOf, type PoseWarning } from '../input/poseHealth';
import type { Landmark, PoseFrame } from '../types';
import { localPlayerId, useGameStore } from '../game/store';
import { useGame } from './GameContext';
import { ScanOverlay } from './ScanOverlay';

const BONES: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12]];

/**
 * The player's own camera with their tracked skeleton and the last move it read: the guided body scan while scanning
 * (ScanOverlay), a corner picture-in-picture while fighting. C toggles it (not during the scan).
 */
export function CameraPip() {
  const game = useGame();
  const role = useGameStore((s) => s.role);
  const status = useGameStore((s) => s.players[localPlayerId(s.role)].status);
  const detail = useGameStore((s) => s.players[localPlayerId(s.role)].statusDetail);
  const lastMove = useGameStore((s) => s.lastMove);
  const lobby = useGameStore((s) => s.phase === 'lobby');
  const scan = useGameStore((s) => s.scan);
  const localId = useGameStore((s) => localPlayerId(s.role));
  const [source, setSource] = useState<InputSource | null>(null);
  const [open, setOpen] = useState(true);
  const skipScan = useCallback(() => game.skipScan(), [game]);

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

  // Only a real scan: a saved or masked fighter is 'scanning' too while the camera starts, and gets the corner picture.
  if (source?.video && status === 'scanning' && scan) {
    return <ScanOverlay source={source} id={localId} view={scan.view} thumbs={scan.thumbs} detail={detail} onSkip={skipScan} />;
  }
  if (!source?.video) return null;
  const place = lobby
    ? 'bottom-4 left-1/2 w-[min(32vw,240px)] -translate-x-1/2' // between the two "Ready" banners
    : 'bottom-4 left-4 w-[min(32vw,300px)]';
  const note = <PoseWarningNote source={source} />;
  // Hidden with C: the tracking warning (if any) still shows where the picture was.
  if (!open) return <div className={`pointer-events-none fixed z-40 ${place}`}>{note}</div>;
  // Each read pops in and fades out on its own within 0.6 s (the animation, not a re-render, hides it), so a second
  // jab shows as a second pop instead of the same word left up.
  const fresh = lastMove && performance.now() - lastMove.at < 600;
  return (
    <div className={`pointer-events-none fixed z-40 overflow-hidden border-2 border-paper/30 bg-black shadow-2xl ${place}`}>
      {note}
      <div className="relative aspect-[4/3]">
        <SkeletonVideo source={source} />
        {fresh && (
          <p key={lastMove!.at} className="animate-move-read absolute inset-x-0 bottom-2 text-center font-display text-2xl uppercase tracking-tight text-hp drop-shadow-[0_2px_6px_#000]">
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

/**
 * A strip over the camera picture when tracking is too slow to read moves well (few poses a second, a dim camera, no
 * GPU), saying what helps. Otherwise, when the player is framed badly (head cut off, too close, hands out of the shot),
 * what to fix (FramingCoach). The camera re-rates every 2 s; this looks four times a second.
 */
function PoseWarningNote({ source }: { source: InputSource }) {
  const [warning, setWarning] = useState<PoseWarning | null>(() => poseWarningOf(source));
  useEffect(() => {
    const coach = new FramingCoach();
    const look = () => setWarning((old) => {
      const framing = coach.update(source.latestFrame);
      const now = poseWarningOf(source) ?? (framing && { kind: 'camera' as const, text: framing.text });
      return now?.text === old?.text ? old : now;
    });
    look();
    const t = setInterval(look, 250);
    return () => clearInterval(t);
  }, [source]);
  if (!warning) return null;
  return (
    <p role="status" data-testid="pose-warning" className="bg-low px-2 py-1 font-cond text-[11px] font-bold uppercase leading-tight tracking-[0.12em] text-ink">
      {warning.text}
    </p>
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
