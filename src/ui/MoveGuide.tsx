import { useEffect, useState } from 'react';
import { localPlayerId, useGameStore } from '../game/store';

/** How to do each move, in the reader's terms (same wording as the move tester). */
const MOVES: [name: string, how: string][] = [
  ['Punch', 'From your guard, snap a fist straight at the screen and back.'],
  ['Hook', 'Swing a fist round from the side, elbow bent.'],
  ['Uppercut', 'Dip a fist, then drive it up, elbow bent.'],
  ['Combo', "Throw them fast: every punch you throw comes out."],
  ['Block', 'Both fists up in front of your face. Hold.'],
  ['Duck', 'Drop your head and shoulders quickly.'],
  ['Dodge', 'Lean your head quickly to one side.'],
  ['Kick / knee', 'Standing: lift a knee fast. Breaks a block.'],
];

/**
 * The move list. Open in the lobby (so new players and judges see it), out of the way in a fight; H toggles it.
 * `inline` renders it as a plain block (the client laptop's waiting screen).
 */
export function MoveGuide({ inline = false }: { inline?: boolean }) {
  const phase = useGameStore((s) => s.phase);
  const walkout = useGameStore((s) => s.walkout);
  // In the lobby, once this laptop's player is ready (before that their own setup panel is in that spot).
  const lobby = useGameStore((s) => s.phase === 'lobby' && s.players[localPlayerId(s.role)].status === 'ready');
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyH' && !(e.target instanceof HTMLInputElement)) setOpen((o) => !(o ?? lobby));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lobby]);
  // Re-open for each new lobby, close when a fight starts, unless toggled.
  useEffect(() => setOpen(null), [phase]);
  if (walkout && !inline) return null; // nothing over the walkout
  const shown = inline || (open ?? lobby);

  if (!shown) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="pointer-events-auto absolute bottom-4 right-4 bg-ink/80 px-3 py-1.5 font-cond text-xs font-bold uppercase tracking-[0.2em] text-paper/70 hover:text-paper"
      >
        Moves [H]
      </button>
    );
  }
  return (
    <div
      className={
        inline
          ? 'w-full max-w-xl'
          : 'animate-rise pointer-events-auto absolute left-4 top-28 w-[min(92vw,22rem)] sm:left-8 sm:top-32'
      }
    >
      <div className="flex items-stretch">
        <span className="slant bg-hp px-3 py-1 font-display text-sm uppercase text-ink [--slant:8px]">How to fight</span>
        {!inline && (
          <button type="button" onClick={() => setOpen(false)} className="ml-auto px-2 font-cond text-xs font-bold uppercase tracking-[0.2em] text-paper/60 hover:text-paper">
            Hide [H]
          </button>
        )}
      </div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 bg-ink/85 px-3 py-2.5 text-sm leading-snug">
        {MOVES.map(([name, how]) => (
          <div key={name} className="contents">
            <dt className="font-display uppercase tracking-tight text-paper">{name}</dt>
            <dd className="text-paper/75">{how}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1 bg-ink/85 px-3 py-1.5 font-cond text-xs font-semibold uppercase tracking-[0.15em] text-paper/60">
        Sitting or standing both work. Lean in to step forward.
      </p>
    </div>
  );
}
