import { useEffect, useRef } from 'react';
import { camView } from '../game/CameraShare';
import { setCamHidden, useGameStore } from '../game/store';
import { ACCENT } from './accent';

/**
 * The opponent's camera, Omegle style: a framed picture on their side of the screen, under their health bar, in their
 * color. "Hide my camera" (here in the lobby and on the K.O. screen, and in the Esc menu) stops it both ways, and the
 * frame says who hid. While this laptop's camera goes out, a LIVE line says so.
 */
export function OpponentCam() {
  const role = useGameStore((s) => s.role);
  const screen = useGameStore((s) => s.screen);
  const connection = useGameStore((s) => s.connection);
  const phase = useGameStore((s) => s.phase);
  const cutscene = useGameStore((s) => s.walkout || s.replay);
  const camHidden = useGameStore((s) => s.camHidden);
  const opponentCamHidden = useGameStore((s) => s.opponentCamHidden);
  const opponentVideo = useGameStore((s) => s.opponentVideo);
  const camSending = useGameStore((s) => s.camSending);
  const opponent = role === 'client' ? 'p1' : 'p2';
  const name = useGameStore((s) => s.players[opponent].name);
  const ready = useGameStore((s) => s.players[opponent].status === 'ready');

  if ((role !== 'host' && role !== 'client') || connection !== 'open' || cutscene) return null;
  if (screen !== 'game' && screen !== 'client') return null;
  const view = camView({ camHidden, opponentCamHidden, opponentVideo, camSending });
  const accent = ACCENT[opponent];
  const right = opponent === 'p2' || screen === 'client';
  // The toggle sits on the frame outside the round; mid-round it's in the Esc menu (no stray clicks mid-punch).
  const toggle = phase === 'lobby' || phase === 'ko';
  const place = screen === 'client' ? 'right-6 top-6 sm:right-10' : `top-[5.75rem] sm:top-[8.25rem] ${right ? 'right-3 sm:right-8' : 'left-3 sm:left-8'}`;

  return (
    <div
      data-testid="opponent-cam"
      className={`pointer-events-none fixed z-30 flex w-[clamp(9rem,15vw,14rem)] flex-col gap-1 ${right ? 'items-end' : 'items-start'} ${place} animate-rise`}
    >
      <div className={`cut w-full ${accent.bg} p-[3px] [--cut:10px]`}>
        <div className="cut relative aspect-[4/3] overflow-hidden bg-ink [--cut:8px]">
          {view.show && opponentVideo ? (
            <Video stream={opponentVideo} />
          ) : (
            <div className="tex-dots absolute inset-0 grid place-items-center px-3 text-center">
              <span className={`font-cond text-xs font-bold uppercase leading-snug tracking-[0.15em] ${view.label === 'Connecting camera…' ? 'text-paper/45' : 'text-paper'}`}>
                {(camHidden || opponentCamHidden) && <EyeOff />}
                {view.label}
              </span>
            </div>
          )}
          <span className={`absolute top-0 ${right ? 'right-0' : 'left-0'} ${accent.bg} px-2 py-0.5 font-display text-xs text-ink`}>{accent.tag}</span>
          {ready && (
            <span className={`absolute bottom-0 inset-x-0 truncate bg-gradient-to-t from-ink/90 to-transparent px-2 pt-4 pb-1 font-display text-sm uppercase tracking-tight ${right ? 'text-right' : ''}`}>
              {name}
            </span>
          )}
        </div>
      </div>
      <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${right ? 'justify-end' : ''}`}>
        {view.sending && (
          <span className="flex items-center gap-1.5 bg-ink/85 px-2 py-1 font-cond text-[10px] font-bold uppercase tracking-[0.15em] text-paper/80" title="Your opponent sees a small copy of your camera">
            <span className="animate-blink size-1.5 rounded-full bg-dmg" />
            Your camera is visible to your opponent
          </span>
        )}
        {toggle && (
          <button
            type="button"
            onClick={() => setCamHidden(!camHidden)}
            className="pointer-events-auto bg-ink/85 px-2 py-1 font-cond text-[10px] font-bold uppercase tracking-[0.15em] text-paper/80 underline-offset-2 hover:text-paper hover:underline"
          >
            {camHidden ? 'Show my camera' : 'Hide my camera'}
          </button>
        )}
      </div>
    </div>
  );
}

function Video({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    void v.play().catch(() => {});
    return () => {
      v.srcObject = null;
    };
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline className="absolute inset-0 size-full object-cover" />;
}

function EyeOff() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="mx-auto mb-1.5 block size-6 fill-none stroke-current stroke-2">
      <path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.4M6.6 6.6A17 17 0 0 0 3 12s4 6 9 6a9 9 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}
