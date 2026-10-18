import { useEffect, useState } from 'react';
import { useGameStore } from '../game/store';
import { ACCENT } from './accent';

/** "3 HITS" on the attacker's side while a combo is going, gone a moment after it ends. */
export function ComboCounter() {
  const combo = useGameStore((s) => s.combo);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!combo) return setShown(false);
    setShown(true);
    const t = setTimeout(() => setShown(false), 1400);
    return () => clearTimeout(t);
  }, [combo]);
  if (!combo || !shown) return null;
  const right = combo.player === 'p2';
  const accent = ACCENT[combo.player];

  return (
    <div className={`pointer-events-none absolute top-[28%] ${right ? 'right-4 items-end sm:right-10' : 'left-4 items-start sm:left-10'} flex flex-col`}>
      <div key={combo.key} className={`animate-slam flex items-baseline gap-2 ${right ? 'flex-row-reverse origin-right' : 'origin-left'}`}>
        <span className="font-display text-6xl leading-none tracking-tighter text-paper drop-shadow-[0_4px_0_#0b0a10] sm:text-8xl">
          {combo.hits}
        </span>
        <span className={`slant ${accent.bg} px-3 py-1 font-display text-2xl uppercase text-ink [--slant:8px] sm:text-3xl`}>Hits</span>
      </div>
      <span className="mt-1 font-cond text-sm font-extrabold uppercase tracking-[0.35em] text-paper/80 drop-shadow-[0_2px_0_#0b0a10]">
        Combo
      </span>
    </div>
  );
}

/** Big announcer callouts across the middle: FIRST ATTACK, PERFECT. */
export function Callout() {
  const callout = useGameStore((s) => s.callout);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!callout) return setShown(false);
    setShown(true);
    const t = setTimeout(() => setShown(false), 1300);
    return () => clearTimeout(t);
  }, [callout]);
  if (!callout || !shown) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[18%] flex justify-center">
      <span
        key={callout.key}
        className="animate-slam slant bg-hp px-6 py-2 font-display text-4xl uppercase tracking-tight text-ink [--slant:12px] sm:text-6xl"
      >
        {callout.text}
      </span>
    </div>
  );
}
