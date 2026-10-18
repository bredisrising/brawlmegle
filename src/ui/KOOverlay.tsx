import { useGameStore } from '../game/store';
import { ACCENT } from './accent';
import { ArcadeButton } from './ArcadeButton';
import { useGame } from './GameContext';

export function KOOverlay() {
  const game = useGame();
  const phase = useGameStore((s) => s.phase);
  const winner = useGameStore((s) => s.winner);
  const winnerName = useGameStore((s) => (s.winner ? s.players[s.winner].name : ''));
  const ending = useGameStore((s) => s.ending);
  if (phase !== 'ko') return null;
  const accent = ACCENT[winner ?? 'p1'];
  const fromRight = winner === 'p2';

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-ink/45">
      <div className="animate-band relative w-[110%] -rotate-3 bg-dmg">
        <div className="absolute inset-x-0 top-0 h-2 bg-ink" />
        <div className="absolute inset-x-0 bottom-0 h-2 bg-ink" />
        <div className="tex-hatch flex h-48 items-center justify-center overflow-hidden sm:h-64">
          <span className="animate-slam font-display text-[8rem] leading-none tracking-tighter text-ink [animation-delay:120ms] sm:text-[14rem]">
            {ending === 'time' ? 'TIME' : 'K.O.'}
          </span>
        </div>
      </div>

      <div className={`mt-10 flex items-stretch [animation-delay:450ms] ${fromRight ? 'animate-in-r' : 'animate-in-l'}`}>
        <span className={`slant ${accent.bg} grid place-items-center px-5 font-display text-2xl text-ink [--slant:10px]`}>
          {accent.tag}
        </span>
        <span className="slant -ml-1 bg-paper px-6 py-3 font-display text-3xl uppercase tracking-tight text-ink [--slant:10px] sm:text-5xl">
          {winner ? `${winnerName} wins` : 'Draw'}
        </span>
      </div>

      <div className="animate-rise mt-8 [animation-delay:700ms]">
        <ArcadeButton size="lg" onClick={() => game.rematch()}>
          Rematch
        </ArcadeButton>
      </div>
    </div>
  );
}
