import { useEffect, useRef, useState } from 'react';
import { config } from '../config';
import { useGameStore } from '../game/store';
import { cameraErrorText } from '../input/sources/CameraSource';
import { ArcadeButton, TextButton } from './ArcadeButton';
import { CamToggle } from './CamToggle';

/** Same settings the fight asks for, so the camera doesn't have to switch modes when it starts. */
const VIDEO: MediaStreamConstraints = { audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 }, facingMode: 'user' } };
/** Set once the player has read the camera popup and said yes: later visits skip it. */
const INTRO_KEY = 'brawlmegle.camIntro';
/** "Not now" holds for the rest of this visit (the title screen comes back after every fight). */
let notNow = false;
/** The browser said no to this site before: its own box won't open again until the player allows it. */
const BLOCKED = 'Your browser is blocking the camera here. Click the camera (or settings) icon in the address bar, allow it, then Try again.';

type Step = 'checking' | 'ask' | 'waiting' | 'live' | 'off';

/** The browser's camera permission ('granted', 'denied', 'prompt'), or null where it can't say (older Firefox). */
async function cameraPermission(): Promise<PermissionState | null> {
  try {
    return (await navigator.permissions.query({ name: 'camera' as PermissionName })).state;
  } catch {
    return null;
  }
}

function seenIntro() {
  try {
    return localStorage.getItem(INTRO_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberIntro() {
  try {
    localStorage.setItem(INTRO_KEY, '1');
  } catch {
    // Storage blocked: the popup shows again next visit.
  }
}

/**
 * The title screen's corner mirror: this laptop's camera, small, top right, from the moment the site opens (so the
 * camera is sorted before the first fight), with the "My camera" switch under it. Only the camera's picture: the pose
 * model starts with a fight. The stream stops when the title closes; the fight opens its own.
 *
 * A first-time player gets a short popup first (what the camera is for, who sees it), and the browser's permission
 * box only opens when they click Turn on camera. Once the browser has said yes, it's straight to the mirror.
 */
export function TitleCam() {
  const ref = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const gone = useRef(false);
  const [step, setStep] = useState<Step>('checking');
  const [error, setError] = useState('');
  const hidden = useGameStore((s) => s.camHidden);
  const usable = config.input === 'camera' && !!navigator.mediaDevices?.getUserMedia;

  /** Opens the camera; `asked` when the player clicked for it (then a failure is explained in the popup). */
  const open = async (asked: boolean) => {
    if (asked) {
      setStep('waiting');
      setError('');
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia(VIDEO);
      if (gone.current) return s.getTracks().forEach((t) => t.stop());
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = s;
      if (ref.current) ref.current.srcObject = s;
      if (asked) rememberIntro();
      setStep('live');
    } catch (err) {
      if (gone.current) return;
      if (!asked) return setStep('off'); // no camera or no permission: the fight asks again, and says why
      // Closing the browser's box without answering isn't a block: just ask again.
      const state = await cameraPermission();
      setError(state === 'denied' ? BLOCKED : state === 'prompt' ? '' : cameraErrorText(err));
      setStep('ask');
    }
  };

  useEffect(() => {
    gone.current = false;
    // A screen opened to watch a room (?watch=) is a TV: no camera, no popup.
    const watching = new URLSearchParams(window.location.search).has('watch');
    if (usable && !notNow && !watching) {
      void cameraPermission().then((state) => {
        if (gone.current) return;
        if (state === 'granted' || (state !== 'denied' && seenIntro())) return void open(false);
        if (state === 'denied') setError(BLOCKED);
        setStep('ask');
      });
    }
    return () => {
      gone.current = true;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
    // Once per title screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (config.input !== 'camera') return null;
  const asking = step === 'ask' || step === 'waiting';
  const later = () => {
    notNow = true;
    setStep('off');
  };
  return (
    <>
      <div className={`animate-rise absolute right-4 top-4 z-10 hidden flex-col items-end gap-1.5 md:flex sm:right-6 sm:top-6 ${step === 'live' ? '' : 'invisible'}`}>
        <div className="relative aspect-[4/3] w-[clamp(7.5rem,11vw,10.5rem)] overflow-hidden border-2 border-paper/25 bg-black shadow-2xl">
          <video ref={ref} autoPlay muted playsInline className="size-full -scale-x-100 object-cover" />
          <span className="absolute left-1 top-1 bg-black/70 px-1.5 py-0.5 font-cond text-[9px] font-bold uppercase tracking-[0.15em] text-paper/75">
            {hidden ? 'Hidden from opponents' : 'Shown to opponents'}
          </span>
        </div>
        <CamToggle />
      </div>
      {asking && <CameraIntro waiting={step === 'waiting'} error={error} onYes={() => void open(true)} onLater={later} />}
    </>
  );
}

/** The popup: three quick lines on what the camera does, then the button that opens the browser's own box. */
function CameraIntro({ waiting, error, onYes, onLater }: { waiting: boolean; error: string; onYes: () => void; onLater: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onLater();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onLater]);

  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-ink/80 p-4 backdrop-blur-sm">
      <section role="dialog" aria-modal="true" aria-labelledby="cam-intro-title" className="animate-rise w-full max-w-[29rem] border-2 border-paper/20 bg-ink shadow-2xl">
        <div className="flex items-center gap-4 border-b-2 border-hp bg-ink-2 px-5 py-4 sm:px-6">
          <CamBadge />
          <div className="min-w-0">
            <p className="font-cond text-xs font-bold uppercase tracking-[0.3em] text-hp">Before you fight</p>
            <h2 id="cam-intro-title" className="mt-0.5 font-display text-[1.9rem] uppercase leading-[0.9] tracking-tighter sm:text-4xl">
              This game uses your <span className="text-hp">camera</span>
            </h2>
          </div>
        </div>
        <ul className="flex flex-col gap-2.5 px-5 pt-4 font-semibold leading-snug text-pretty text-paper/85 sm:px-6">
          <Line bar="bg-p1">Punch, block and dodge for real. Your fighter copies you.</Line>
          <Line bar="bg-p2">Your moves are read right here, on your laptop.</Line>
          <Line bar="bg-hp">Opponents see a small video of you. Switch it off anytime with My camera.</Line>
        </ul>
        {error && (
          <p role="alert" className="mx-5 mt-4 border-l-4 border-dmg bg-ink-2 px-3 py-2 text-sm font-semibold sm:mx-6">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 pb-5 pt-5 sm:px-6">
          <ArcadeButton type="button" disabled={waiting} onClick={onYes} autoFocus>
            {waiting ? 'Waiting…' : error ? 'Try again' : 'Turn on camera'}
          </ArcadeButton>
          <TextButton onClick={onLater}>Not now</TextButton>
        </div>
        {waiting && (
          <p role="status" className="-mt-1 px-5 pb-4 font-cond text-sm font-bold uppercase tracking-[0.14em] text-hp sm:px-6">
            ↑ Click Allow in your browser's box up top
          </p>
        )}
      </section>
    </div>
  );
}

function Line({ bar, children }: { bar: string; children: string }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className={`mt-1 h-4 w-1.5 shrink-0 ${bar}`} />
      <span>{children}</span>
    </li>
  );
}

function CamBadge() {
  return (
    <span aria-hidden className="cut grid size-14 shrink-0 place-items-center bg-hp text-ink [--cut:10px]">
      <svg viewBox="0 0 24 24" className="size-8 fill-none stroke-current stroke-[2.5]">
        <path d="M3 7h12v10H3zM15 10l6-3v10l-6-3" />
      </svg>
    </span>
  );
}
