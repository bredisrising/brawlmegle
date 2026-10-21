import { useEffect, useState } from 'react';
import { compareRecords, fetchRecords, type FighterRecord } from '../forge/leaderboard';
import { listFighters } from '../forge/roster';
import type { ForgedFighter } from '../types';

/** How many leaders take turns, and how long each one holds the plate (ms). */
const KINGS = 3;
const HOLD_MS = 5000;

/**
 * The title screen's reigning champions: the top three on the leaderboard take turns on one small plate under the
 * tagline (their forged fighter's face, name, record and streak), so being up there is something everyone sees.
 * Clicking it opens the leaderboard. Nothing shows until someone has won a fight.
 */
export function Kings({ onOpen }: { onOpen: () => void }) {
  const [kings, setKings] = useState<{ fighter: ForgedFighter; record: FighterRecord }[]>([]);
  const [turn, setTurn] = useState(0);

  useEffect(() => {
    let alive = true;
    void Promise.all([listFighters(), fetchRecords()]).then(([fighters, records]) => {
      if (!alive) return;
      const ranked = fighters
        .map((fighter) => ({ fighter, record: records[fighter.id] }))
        .filter((k): k is { fighter: ForgedFighter; record: FighterRecord } => !!k.record && k.record.wins > 0)
        .sort((a, b) => compareRecords(a.record, b.record) || a.fighter.name.localeCompare(b.fighter.name));
      setKings(ranked.slice(0, KINGS));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (kings.length < 2) return;
    const t = setInterval(() => setTurn((n) => (n + 1) % kings.length), HOLD_MS);
    return () => clearInterval(t);
  }, [kings.length]);

  if (!kings.length) return null;
  const rank = turn % kings.length;
  const { fighter, record } = kings[rank];
  const streak = record.streak >= 2 ? `${record.streak}-win streak` : `best streak ${record.bestStreak}`;

  return (
    <button
      type="button"
      onClick={onOpen}
      title="See the leaderboard"
      className="group mt-[clamp(0.6rem,2vh,1.1rem)] flex max-w-[22rem] items-stretch text-left"
    >
      <span key={fighter.id} className="animate-rise flex min-w-0 items-stretch">
        <span className="relative block h-16 w-14 shrink-0 overflow-hidden bg-ink-3 ring-2 ring-hp sm:h-20 sm:w-16">
          {fighter.cardUrl ? (
            <img src={fighter.cardUrl} alt="" className="absolute left-1/2 top-[4%] h-[230%] w-auto max-w-none -translate-x-1/2" />
          ) : (
            <span className="tex-dots grid size-full place-items-center font-display text-xl uppercase text-paper/30">{fighter.name.slice(0, 2)}</span>
          )}
        </span>
        <span className="flex min-w-0 flex-col justify-center bg-ink/85 px-3 py-1.5 group-hover:bg-ink-2">
          <span className="flex items-center gap-1.5 font-cond text-[0.68rem] font-extrabold uppercase tracking-[0.25em] text-hp sm:text-xs">
            <Crown className="h-3 w-auto sm:h-3.5" />
            {rank === 0 ? 'Reigning king' : `Contender #${rank + 1}`}
          </span>
          <span className="block truncate font-display text-2xl uppercase leading-none tracking-tight text-paper sm:text-3xl">{fighter.name}</span>
          <span className="mt-0.5 block font-cond text-[0.68rem] font-bold uppercase tracking-[0.14em] text-paper/65 sm:text-xs">
            <b className="text-hp">{record.wins}W</b> · {record.losses}L · {streak}
          </span>
        </span>
      </span>
    </button>
  );
}

function Crown({ className = '' }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 20 14" className={`fill-current ${className}`}>
      <path d="M0 3l5 4 5-7 5 7 5-4-2 11H2z" />
    </svg>
  );
}
