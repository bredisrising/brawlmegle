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
      className={`pointer-events-auto flex items-center gap-2.5 whitespace-nowrap border-2 bg-ink/90 px-3.5 py-2 font-cond text-sm font-extrabold uppercase tracking-[0.15em] transition-colors ${hidden ? 'border-paper/35 text-paper/75 hover:border-paper hover:text-paper' : 'border-hp text-paper hover:border-paper'} ${className}`}
    >
      <CamIcon off={hidden} />
      My camera
      <span className={`relative flex h-7 w-14 items-center rounded-full px-1.5 text-[11px] tracking-[0.1em] ${hidden ? 'justify-end bg-paper/20 text-paper/70' : 'justify-start bg-hp text-ink'}`}>
        {hidden ? 'off' : 'on'}
        <span className={`absolute top-1 size-5 rounded-full bg-paper transition-[left] duration-150 ${hidden ? 'left-1' : 'left-8'}`} />
      </span>
    </button>
  );
}

function CamIcon({ off }: { off: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-5 shrink-0 fill-none stroke-current stroke-2">
      <path d="M3 7h12v10H3zM15 10l6-3v10l-6-3" />
      {off && <path d="M2 3l20 18" />}
    </svg>
  );
}
