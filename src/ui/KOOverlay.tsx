import { useGameStore } from '../game/store';
import { useGame } from './GameContext';

export function KOOverlay() {
  const game = useGame();
  const phase = useGameStore((s) => s.phase);
  const winner = useGameStore((s) => s.winner);
  const winnerName = useGameStore((s) => (s.winner ? s.players[s.winner].name : ''));
  if (phase !== 'ko') return null;

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/40">
      <span className="font-display text-outline animate-slam text-[12rem] leading-none text-red-500">K.O.</span>
      <span className={`font-display text-outline text-5xl ${winner === 'p2' ? 'text-p2' : 'text-p1'}`}>
        {winnerName} wins!
      </span>
      <button
        onClick={() => game.rematch()}
        className="pointer-events-auto mt-4 -skew-x-12 bg-hp px-8 py-3 font-display text-3xl tracking-wider text-black shadow-[6px_6px_0_black] transition hover:scale-105"
      >
        <span className="inline-block skew-x-12">Rematch</span>
      </button>
    </div>
  );
}
