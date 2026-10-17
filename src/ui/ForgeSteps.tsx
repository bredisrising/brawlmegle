import type { PlayerStatus } from '../types';

const STEPS = ['Scan', 'Forge', 'Ready'] as const;
const CURRENT: Record<PlayerStatus, number> = { waiting: -1, scanning: 0, forging: 1, ready: 3 };

/** Scan -> Forge -> Ready tracker. The live step runs animated stripes in the player's color. */
export function ForgeSteps({ status, color }: { status: PlayerStatus; color: string }) {
  const current = CURRENT[status];

  return (
    <ol className="flex w-full max-w-md gap-1.5">
      {STEPS.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'live' : 'todo';
        return (
          <li
            key={label}
            className={`slant relative flex flex-1 items-baseline gap-2 overflow-hidden px-4 py-2.5 [--slant:10px] ${
              state === 'done' ? 'bg-paper text-ink' : state === 'live' ? `${color} text-ink` : 'bg-ink-3 text-paper/40'
            }`}
          >
            {state === 'live' && <span className="tex-stripes animate-stripes absolute inset-0" />}
            <span className="relative font-cond text-xs font-bold tracking-widest">0{i + 1}</span>
            <span className="relative font-display text-sm uppercase sm:text-base">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
