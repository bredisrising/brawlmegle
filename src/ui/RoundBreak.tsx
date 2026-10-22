import { useEffect, useState } from 'react';
import { BREAK, isFinal, restLine } from '../game/rounds';
import { useGameStore } from '../game/store';
import { ACCENT } from './accent';

/**
 * Between rounds (phase 'break', best of three): the round's K.O. / TIME slammed in with who took it, then a breather
 * (it's a physical game): the score, a line to loosen up, and the seconds to the next round's call. Timed from when
 * the break reached this laptop, like the host's own clock for it (rounds.ts BREAK).
 */
export function RoundBreak() {
  const phase = useGameStore((s) => s.phase);
  if (phase !== 'break') return null;
  return <Break />;
}

function Break() {
  const winner = useGameStore((s) => s.winner);
  const winnerName = useGameStore((s) => (s.winner ? s.players[s.winner].name : ''));
  const ending = useGameStore((s) => s.ending);
  const round = useGameStore((s) => s.round);
  const wins = useGameStore((s) => s.wins);
  const [start] = useState(() => performance.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(t);
  }, []);
  const elapsed = now - start;
  if (elapsed < BREAK.resultMs) return <Result winner={winner} name={winnerName} ending={ending} round={round} />;
  const next = isFinal(round + 1, wins) ? 'Final round' : `Round ${round + 1}`;
  const left = Math.max(1, Math.ceil((BREAK.totalMs - elapsed) / 1000));
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-[min(1.5rem,3vh)] bg-ink/35">
      <div className="animate-rise flex items-center gap-[0.3em] font-display text-[min(8rem,17vh,20vw)] leading-none tracking-tighter">
        <span className="text-p1" style={{ WebkitTextStroke: '0.03em #0b0a10', paintOrder: 'stroke fill' }}>{wins.p1}</span>
        <span className="text-[0.5em] text-paper/80">–</span>
        <span className="text-p2" style={{ WebkitTextStroke: '0.03em #0b0a10', paintOrder: 'stroke fill' }}>{wins.p2}</span>
      </div>
      <p className="animate-in-l slant bg-paper px-6 py-2 font-display text-[min(3rem,7vh,8vw)] uppercase leading-tight tracking-tight text-ink [--slant:10px] [animation-delay:120ms]">
        {restLine(round)}
      </p>
      <p className="animate-rise bg-ink/75 px-3 py-1 font-cond text-lg font-bold uppercase tracking-[0.2em] text-paper/85 [animation-delay:300ms]" aria-live="polite">
        {next} in <span key={left} className="animate-slam inline-block font-display text-2xl text-hp">{left}</span>
      </p>
    </div>
  );
}

/** The round's finish: the K.O. screen's band, quicker and without the menu, and who took the round. */
function Result({ winner, name, ending, round }: { winner: 'p1' | 'p2' | null; name: string; ending: 'ko' | 'time' | null; round: number }) {
  const accent = ACCENT[winner ?? 'p1'];
  const fromRight = winner === 'p2';
  const word = ending === 'time' ? 'TIME' : winner ? 'K.O.' : 'DOUBLE K.O.';
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-ink/30">
      <div className="animate-band relative w-[110%] -rotate-3 bg-dmg">
        <div className="absolute inset-x-0 top-0 h-2 bg-ink" />
        <div className="absolute inset-x-0 bottom-0 h-2 bg-ink" />
        <div className="tex-hatch flex h-[min(13rem,23vh)] items-center justify-center overflow-hidden">
          <span className={`animate-slam font-display leading-none tracking-tighter text-ink [animation-delay:120ms] ${word.length > 4 ? 'text-[min(9rem,16vh,15vw)]' : 'text-[min(11rem,19vh,24vw)]'}`}>
            {word}
          </span>
        </div>
      </div>
      <div className={`mt-[min(2rem,3.5vh)] flex items-stretch [animation-delay:450ms] ${fromRight ? 'animate-in-r' : 'animate-in-l'}`}>
        {winner && (
          <span className={`slant ${accent.bg} grid place-items-center px-4 font-display text-xl text-ink [--slant:10px] sm:text-2xl`}>
            {accent.tag}
          </span>
        )}
        <span className="slant -ml-1 max-w-[80vw] truncate bg-paper px-6 py-2.5 font-display text-2xl uppercase tracking-tight text-ink [--slant:10px] sm:text-4xl">
          {winner ? `${name} takes round ${round}` : `Even round: one each`}
        </span>
      </div>
    </div>
  );
}
