import { useGameStore } from '../game/store';
import type { PlayerId } from '../types';
import { HealthBar } from './HealthBar';

/** Top bar: P1 [portrait | name | hp]  VS  [hp | name | portrait] P2 */
export function HUD() {
  const phase = useGameStore((s) => s.phase);

  return (
    <div className="absolute inset-x-0 top-0 flex items-start gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 pt-3 pb-8 sm:px-8">
      <PlayerHUD id="p1" />
      <div className="flex w-20 shrink-0 flex-col items-center pt-1">
        <span className="font-display text-outline text-4xl text-white sm:text-5xl">
          {phase === 'ko' ? 'KO' : 'VS'}
        </span>
      </div>
      <PlayerHUD id="p2" />
    </div>
  );
}

function PlayerHUD({ id }: { id: PlayerId }) {
  const player = useGameStore((s) => s.players[id]);
  const right = id === 'p2';
  const color = right ? 'text-p2' : 'text-p1';
  const border = right ? 'border-p2' : 'border-p1';

  return (
    <div className={`flex flex-1 items-center gap-3 ${right ? 'flex-row-reverse' : ''}`}>
      <div className={`grid size-14 shrink-0 place-items-center overflow-hidden rounded-md border-2 ${border} bg-black/60`}>
        {player.portraitUrl ? (
          <img src={player.portraitUrl} alt="" className="size-full object-cover" />
        ) : (
          <span className={`font-display text-3xl ${color}`}>{right ? 'P2' : 'P1'}</span>
        )}
      </div>
      <div className={`flex flex-1 flex-col gap-1 ${right ? 'items-end' : 'items-start'}`}>
        <div className={`flex w-full items-baseline justify-between gap-2 ${right ? 'flex-row-reverse' : ''}`}>
          <span className={`font-display text-2xl tracking-wide ${color}`}>{player.name}</span>
          <span className="text-sm font-semibold uppercase tracking-widest text-white/60">
            {player.status === 'ready' ? `${Math.ceil(player.hp)} HP` : player.status}
          </span>
        </div>
        <HealthBar hp={player.hp} side={right ? 'right' : 'left'} />
      </div>
    </div>
  );
}
