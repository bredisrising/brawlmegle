import { localPlayerId, useGameStore } from '../game/store';
import type { PlayerId } from '../types';
import { ArcadeButton } from './ArcadeButton';
import { useGame } from './GameContext';

/**
 * One half of the 50/50 split on the host screen.
 * The local player arrives via the avatar screen; the remote one joins from the other laptop.
 */
export function PlayerSlot({ id }: { id: PlayerId }) {
  const game = useGame();
  const player = useGameStore((s) => s.players[id]);
  const phase = useGameStore((s) => s.phase);
  const role = useGameStore((s) => s.role);
  const roomCode = useGameStore((s) => s.roomCode);
  const right = id === 'p2';
  const color = right ? 'text-p2' : 'text-p1';
  const busy = player.status === 'scanning' || player.status === 'forging';
  const remote = id !== localPlayerId(role);

  return (
    <div className={`absolute inset-y-0 w-1/2 ${right ? 'right-0' : 'left-0'}`}>
      {player.status !== 'ready' && (
        <div className={`flex h-full flex-col items-center justify-center gap-6 bg-black/45 backdrop-blur-[2px] ${right ? 'border-l' : 'border-r'} border-white/10`}>
          <p className="text-lg font-semibold uppercase tracking-[0.4em] text-white/60">
            {busy ? player.status : 'Waiting for'}
          </p>
          <h2 className={`font-display text-outline text-6xl sm:text-7xl ${color}`}>
            {busy ? player.name : `Player ${right ? 2 : 1}`}
          </h2>

          {busy && (
            <div className="flex items-center gap-3 text-xl font-semibold">
              <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              {player.statusDetail}…
            </div>
          )}

          {!busy && remote && (
            <div className="flex flex-col items-center gap-2 text-center">
              <p className="text-lg font-semibold text-white/70">On the other laptop, tap Connect and enter</p>
              <span className="font-display text-outline text-6xl tracking-[0.2em] text-white">{roomCode ?? '····'}</span>
              {!roomCode && <p className="text-sm text-white/40">Signaling server not connected yet</p>}
            </div>
          )}

          {!busy && player.statusDetail && <p className="text-red-300">{player.statusDetail}</p>}

          {!busy && remote && import.meta.env.DEV && (
            <ArcadeButton color={right ? 'bg-p2' : 'bg-p1'} onClick={() => game.addTestPlayer(id)}>
              Add test player
            </ArcadeButton>
          )}
        </div>
      )}

      {player.status === 'ready' && phase === 'lobby' && (
        <div className="absolute inset-x-0 bottom-16 text-center">
          <span className={`font-display text-outline text-4xl ${color}`}>{player.name} is ready!</span>
          <p className="text-sm font-semibold uppercase tracking-widest text-white/60">Waiting for opponent</p>
        </div>
      )}
    </div>
  );
}
