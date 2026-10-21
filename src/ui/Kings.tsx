import { useEffect, useState, type CSSProperties } from 'react';
import { compareRecords, fetchRecords, type FighterRecord } from '../forge/leaderboard';
import { listFighters } from '../forge/roster';
import type { ForgedFighter } from '../types';

/** How many leaders take turns, and how long each one holds the plate (ms). */
const KINGS = 3;
const HOLD_MS = 5000;
/** Gold, silver and bronze: the plate's metal for #1, #2 and #3. */
const METAL = ['var(--color-hp)', '#c8ccd6', '#d0894c'];
const TITLE = ['Reigning king', 'Contender', 'Contender'];

/**
 * The title screen's reigning champions: the top three on the leaderboard take turns on one plate under the tagline,
 * like a fighting game's champion card: their forged fighter's face in a metal frame (gold, silver, bronze), the rank
 * stamped behind their name, a crown on the king, a flame on a hot streak, and a shine as each one slams in. Kept
 * short so the menu still fits a laptop screen. Clicking it opens the leaderboard. Nothing shows until someone has
 * won a fight.
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
  const metal = { '--metal': METAL[rank] } as CSSProperties;
  const hot = record.streak >= 3;

  return (
    <button type="button" onClick={onOpen} title="See the leaderboard" style={metal} className="group mt-[clamp(0.5rem,1.6vh,0.9rem)] block max-w-[22rem] text-left">
      <span key={fighter.id} className="animate-in-l relative flex items-stretch">
        {/* Portrait in a notched metal frame; the king wears the crown. */}
        <span className="relative shrink-0">
          <span className="cut block bg-[var(--metal)] p-[3px] [--cut:10px]">
            <span className="cut relative block h-[3.6rem] w-[3rem] overflow-hidden bg-ink-3 [--cut:8px] sm:h-[4rem] sm:w-[3.4rem]">
              {fighter.cardUrl ? (
                <img src={fighter.cardUrl} alt="" className="absolute left-1/2 top-[4%] h-[230%] w-auto max-w-none -translate-x-1/2 transition-transform duration-300 group-hover:scale-105" />
              ) : (
                <span className="tex-dots grid size-full place-items-center font-display text-lg uppercase text-paper/30">{fighter.name.slice(0, 2)}</span>
              )}
            </span>
          </span>
          {rank === 0 && <Crown className="animate-bob absolute -top-3 -left-2 h-4 w-auto text-hp drop-shadow-[0_2px_0_#0b0a10] sm:-top-3.5 sm:h-5" />}
        </span>

        {/* The card: title, name over a big hollow rank number, record, streak. */}
        <span className="slant relative -ml-1 flex min-w-0 flex-1 flex-col justify-center overflow-hidden bg-ink/90 py-1 pr-7 pl-4 [--slant:12px] group-hover:bg-ink-2">
          <span aria-hidden className="text-hollow pointer-events-none absolute -top-2.5 right-3 font-display text-[3.8rem] leading-none [--hollow:color-mix(in_srgb,var(--metal)_35%,transparent)] sm:text-[4.4rem]">
            {rank + 1}
          </span>
          <span aria-hidden className="animate-shine pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent" />
          <span className="relative flex items-center gap-1.5 font-cond text-[0.68rem] font-extrabold uppercase tracking-[0.28em] text-[var(--metal)] sm:text-xs">
            {TITLE[rank]}{rank > 0 && ` #${rank + 1}`}
          </span>
          <span className="relative block truncate font-display text-[1.4rem] uppercase leading-none tracking-tight text-paper sm:text-[1.7rem]">{fighter.name}</span>
          <span className="relative mt-0.5 flex items-center gap-2 font-cond text-[0.68rem] font-bold uppercase tracking-[0.14em] text-paper/70 sm:text-xs">
            <span><b className="text-[var(--metal)]">{record.wins}W</b> · {record.losses}L</span>
            {hot ? (
              <span className="flex items-center gap-1 text-low"><Flame className="h-3 w-auto" />{record.streak} straight</span>
            ) : (
              <span>best streak {record.bestStreak}</span>
            )}
          </span>
        </span>
      </span>
    </button>
  );
}

function Crown({ className = '' }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 16" className={`fill-current ${className}`}>
      <path d="M0 4l6 5 6-9 6 9 6-5-2.5 12h-19z" />
      <circle cx="12" cy="1.4" r="1.4" />
      <circle cx="0.8" cy="3.6" r="1.1" />
      <circle cx="23.2" cy="3.6" r="1.1" />
    </svg>
  );
}

function Flame({ className = '' }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 12 16" className={`fill-current ${className}`}>
      <path d="M6 0c1 3 5 5 5 9.5A5 5 0 0 1 1 9.5C1 7 2.5 5.5 3.5 4c.3 1.6 1 2.6 2 3C5 4.5 5.2 2.2 6 0z" />
    </svg>
  );
}
