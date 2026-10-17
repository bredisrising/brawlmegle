import { useGameStore } from '../game/store';
import type { PlayerId } from '../types';
import { useGame } from './GameContext';

/** One half of the 50/50 split: "Waiting for player N" until that player is detected. */
export function PlayerSlot({ id }: { id: PlayerId }) {
  const game = useGame();
  const player = useGameStore((s) => s.players[id]);
  const phase = useGameStore((s) => s.phase);
  const right = id === 'p2';
  const num = right ? 2 : 1;
  const color = right ? 'text-p2' : 'text-p1';
  const bg = right ? 'bg-p2' : 'bg-p1';
  const busy = player.status === 'scanning' || player.status === 'forging';

  return (
    <div className={`absolute inset-y-0 w-1/2 ${right ? 'right-0' : 'left-0'}`}>
      {player.status !== 'ready' && (
        <div className={`flex h-full flex-col items-center justify-center gap-6 bg-black/45 backdrop-blur-[2px] ${right ? 'border-l' : 'border-r'} border-white/10`}>
          <p className="text-lg font-semibold uppercase tracking-[0.4em] text-white/60">
            {busy ? player.status : 'Waiting for'}
          </p>
          <h2 className={`font-display text-outline text-6xl sm:text-7xl ${color}`}>Player {num}</h2>

          {busy ? (
            <div className="flex items-center gap-3 text-xl font-semibold">
              <span className={`size-4 animate-spin rounded-full border-2 border-white/30 border-t-white`} />
              {player.statusDetail}…
            </div>
          ) : (
            <>
              <button
                onClick={() => game.detectPlayer(id)}
                className={`pointer-events-auto -skew-x-12 ${bg} px-8 py-3 font-display text-3xl tracking-wider text-black shadow-[6px_6px_0_black] transition hover:scale-105 active:translate-x-1 active:translate-y-1 active:shadow-none`}
              >
                <span className="inline-block skew-x-12">Detect Player</span>
              </button>
              {player.statusDetail && <p className="text-red-300">{player.statusDetail}</p>}
            </>
          )}
        </div>
      )}

      {player.status === 'ready' && phase === 'lobby' && (
        <div className="absolute inset-x-0 bottom-16 text-center">
          <span className={`font-display text-outline text-4xl ${color}`}>Ready!</span>
          <p className="text-sm font-semibold uppercase tracking-widest text-white/60">Waiting for opponent</p>
        </div>
      )}
    </div>
  );
}
