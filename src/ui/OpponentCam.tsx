import { useEffect, useRef } from 'react';
import { camView } from '../game/CameraShare';
import { useGameStore } from '../game/store';
import { ACCENT } from './accent';
import { CamToggle } from './CamToggle';
import { useClientStage } from './screens/ClientScreen';

/**
 * The opponent's camera, Omegle style: a framed picture in the bottom-right corner, in their
 * color. "Hide my camera" (here in the lobby and on the K.O. screen, and in the Esc menu) stops it both ways, and the
 * frame says who hid. While this laptop's camera goes out, a LIVE line says so.
 */
export function OpponentCam() {
  const role = useGameStore((s) => s.role);
  const screen = useGameStore((s) => s.screen);
  const connection = useGameStore((s) => s.connection);
  const cutscene = useGameStore((s) => s.walkout || s.replay);
  const camHidden = useGameStore((s) => s.camHidden);
  const opponentCamHidden = useGameStore((s) => s.opponentCamHidden);
  const opponentVideo = useGameStore((s) => s.opponentVideo);
  const camSending = useGameStore((s) => s.camSending);
  const opponent = role === 'client' ? 'p1' : 'p2';
  const name = useGameStore((s) => s.players[opponent].name);
  const ready = useGameStore((s) => s.players[opponent].status === 'ready');
  const stage = useClientStage();

  if ((role !== 'host' && role !== 'client') || connection !== 'open' || cutscene) return null;
  if (screen !== 'game' && screen !== 'client') return null;
  const view = camView({ camHidden, opponentCamHidden, opponentVideo, camSending });
  const accent = ACCENT[opponent];
  // Bottom right (above the menu chips), whoever the opponent is: clear of the HUD, the combo counter (28% down, on
  // the attacker's side), this laptop's own camera (bottom left) and the fighters. The client's waiting screen: top right.
  // The switch is always on the frame, mid-round too: turning the camera off should never mean digging through a menu.
  // While this laptop's forge has the right half as its stage: bottom left, under the player's column.
  const place =
    screen !== 'client'
      ? 'bottom-[5.5rem] right-3 flex-col-reverse items-end sm:right-4'
      : stage
        ? 'bottom-6 left-6 flex-col-reverse items-start sm:left-14'
        : 'right-6 top-6 flex-col items-end sm:right-10';

  return (
    <div
      data-testid="opponent-cam"
      className={`pointer-events-none fixed z-30 flex w-[clamp(9rem,15vw,14rem)] gap-1 ${place} animate-rise`}
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
          <span className={`absolute top-0 right-0 ${accent.bg} px-2 py-0.5 font-display text-xs text-ink`}>{accent.tag}</span>
          {ready && (
            <span className={`absolute bottom-0 inset-x-0 truncate bg-gradient-to-t from-ink/90 to-transparent px-2 pt-4 pb-1 font-display text-sm uppercase tracking-tight text-right`}>
              {name}
            </span>
          )}
        </div>
      </div>
      <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${stage ? 'justify-start' : 'justify-end'}`}>
        {view.sending && (
          <span className="flex items-center gap-1.5 bg-ink/85 px-2 py-1 font-cond text-[10px] font-bold uppercase tracking-[0.15em] text-paper/80" title="Your opponent sees a small copy of your camera">
            <span className="animate-blink size-1.5 rounded-full bg-dmg" />
            Opponent sees your camera
          </span>
        )}
        <CamToggle />
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
