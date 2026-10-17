import { useGameStore } from '../../game/store';

/** What the client laptop shows after picking a fighter: its own player's progress. The fight is on the host screen. */
export function ClientScreen() {
  const player = useGameStore((s) => s.players.p2);
  const roomCode = useGameStore((s) => s.roomCode);
  const busy = player.status === 'scanning' || player.status === 'forging';

  return (
    <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-6 bg-arena/85 px-4 text-center backdrop-blur-sm">
      <p className="text-sm font-semibold uppercase tracking-widest text-white/50">Room {roomCode}</p>
      <h2 className="font-display text-outline text-7xl text-p2">{player.name}</h2>

      {busy && (
        <div className="flex items-center gap-3 text-2xl font-semibold">
          <span className="size-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          {player.statusDetail}…
        </div>
      )}

      {player.status === 'ready' && (
        <>
          <p className="font-display text-outline text-5xl text-hp">You're in!</p>
          <p className="text-xl font-semibold text-white/70">Stay in front of this camera and look at the big screen.</p>
        </>
      )}

      {player.status === 'waiting' && player.statusDetail && <p className="text-red-300">{player.statusDetail}</p>}
    </div>
  );
}
