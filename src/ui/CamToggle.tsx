import { setCamHidden, useGameStore } from '../game/store';

/**
 * "My camera" as a switch you can't miss: on, the opponent sees a small copy of your camera and you see theirs; off,
 * neither sees the other. Remembered in this browser, so it's set once, not asked every match.
 */
export function CamToggle({ className = '' }: { className?: string }) {
  const hidden = useGameStore((s) => s.camHidden);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!hidden}
      onClick={() => setCamHidden(!hidden)}
      title={hidden ? "Off: neither of you sees the other's camera" : 'On: your opponent sees your camera, and you see theirs'}
      className={`pointer-events-auto flex items-center gap-2 border-2 bg-ink/90 px-2.5 py-1.5 font-cond text-xs font-bold uppercase tracking-[0.15em] transition-colors ${hidden ? 'border-paper/35 text-paper/75 hover:border-paper hover:text-paper' : 'border-hp text-paper hover:border-paper'} ${className}`}
    >
      <CamIcon off={hidden} />
      My camera
      <span className={`relative flex h-5 w-11 items-center rounded-full px-1 text-[9px] tracking-[0.1em] ${hidden ? 'justify-end bg-paper/20 text-paper/70' : 'justify-start bg-hp text-ink'}`}>
        {hidden ? 'off' : 'on'}
        <span className={`absolute top-0.5 size-4 rounded-full bg-paper transition-[left] duration-150 ${hidden ? 'left-0.5' : 'left-[1.625rem]'}`} />
      </span>
    </button>
  );
}

function CamIcon({ off }: { off: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4 shrink-0 fill-none stroke-current stroke-2">
      <path d="M3 7h12v10H3zM15 10l6-3v10l-6-3" />
      {off && <path d="M2 3l20 18" />}
    </svg>
  );
}
