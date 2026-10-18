import { useGameStore } from '../game/store';
import type { PlayerId } from '../types';
import { ACCENT } from './accent';
import { HealthBar } from './HealthBar';

/** Top bar: [portrait | hp / name]  VS  [hp / name | portrait] */
export function HUD() {
  const phase = useGameStore((s) => s.phase);
  const timeLeft = useGameStore((s) => s.timeLeft);
  const ending = useGameStore((s) => s.ending);
  const training = useGameStore((s) => s.training);
  const label = phase === 'ko' ? (ending === 'time' ? 'TIME' : 'KO') : training && phase === 'fighting' ? '\u221e' : phase === 'fighting' && timeLeft !== null ? String(timeLeft) : 'VS';
  const urgent = phase === 'fighting' && timeLeft !== null && timeLeft <= 10;
  // The K.O. replay is a cutscene: no HUD over it.
  const replay = useGameStore((s) => s.replay);
  if (replay) return null;

  return (
    <div className="absolute inset-x-0 top-0 grid grid-cols-[1fr_auto_1fr] items-start gap-2 px-3 pt-3 sm:gap-4 sm:px-8 sm:pt-6">
      <PlayerHUD id="p1" />
      <div className="animate-rise flex flex-col items-center">
        <div className="cut bg-paper p-[3px] [--cut:10px]">
          <div className="cut grid h-12 w-16 place-items-center bg-ink [--cut:9px] sm:h-16 sm:w-24">
            <span
              className={`font-display leading-none tracking-tight ${label.length > 2 ? 'text-2xl sm:text-4xl' : 'text-3xl sm:text-5xl'} ${
                phase === 'ko' || urgent ? 'text-dmg' : 'text-paper'
              }`}
            >
              {label}
            </span>
          </div>
        </div>
        <div className="mt-1 h-1.5 w-10 bg-hp sm:w-14" />
      </div>
      <PlayerHUD id="p2" />
    </div>
  );
}

const STATUS_LABEL = { waiting: 'Waiting', scanning: 'Scanning', forging: 'Forging', ready: 'Ready' };

function PlayerHUD({ id }: { id: PlayerId }) {
  const player = useGameStore((s) => s.players[id]);
  const phase = useGameStore((s) => s.phase);
  const right = id === 'p2';
  const accent = ACCENT[id];
  const showStatus = player.status !== 'ready' || phase === 'lobby';

  return (
    <div className={`flex min-w-0 items-start gap-2 sm:gap-3 ${right ? 'animate-in-r flex-row-reverse' : 'animate-in-l'}`}>
      <div className={`cut hidden shrink-0 ${accent.bg} p-[3px] [--cut:10px] sm:block`}>
        <div className="cut grid size-14 place-items-center overflow-hidden bg-ink [--cut:9px] sm:size-20">
          {player.portraitUrl ? (
            <img src={player.portraitUrl} alt="" className="size-full object-cover" />
          ) : (
            <span className={`font-display text-2xl leading-none sm:text-4xl ${accent.text}`}>{accent.tag}</span>
          )}
        </div>
      </div>

      <div className={`flex min-w-0 flex-1 flex-col gap-1.5 sm:gap-2 ${right ? 'items-end' : 'items-start'}`}>
        <div className="w-full">
          <HealthBar hp={player.hp} side={right ? 'right' : 'left'} />
          <SuperMeter value={player.meter} right={right} color={accent.bg} />
        </div>
        <div className={`flex max-w-full items-stretch ${right ? 'flex-row-reverse' : ''}`}>
          <span className={`slant ${accent.bg} grid place-items-center px-3 font-display text-xs leading-none text-ink [--slant:6px] sm:text-sm`}>
            {accent.tag}
          </span>
          <span className="slant -mx-1 truncate bg-ink px-4 py-1 font-display text-base uppercase leading-tight tracking-tight [--slant:6px] sm:text-2xl">
            {player.name}
          </span>
          {showStatus && (
            <span
              className={`slant grid place-items-center px-3 font-cond text-[0.7rem] font-bold uppercase tracking-[0.2em] [--slant:6px] sm:text-xs ${
                player.status === 'ready' ? 'bg-hp text-ink' : 'bg-ink-3 text-paper/70'
              }`}
            >
              {STATUS_LABEL[player.status]}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Super meter under the health bar: fills as you land hits; full, it glows and says how to throw the fireball. */
function SuperMeter({ value, right, color }: { value: number; right: boolean; color: string }) {
  const full = value >= 100;
  return (
    <div className={`mt-1 flex items-center gap-2 ${right ? 'flex-row-reverse' : ''}`}>
      <div className={`relative h-2 w-1/2 overflow-hidden bg-ink/80 sm:h-2.5 ${right ? 'ml-auto' : ''}`}>
        <div
          className={`absolute inset-y-0 ${right ? 'right-0' : 'left-0'} ${full ? 'animate-blink bg-paper' : color} transition-[width] duration-150`}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
      {full && (
        <span className="animate-slam whitespace-nowrap bg-paper px-1.5 font-display text-[0.65rem] uppercase leading-tight text-ink sm:text-xs">
          Super! fists up high
        </span>
      )}
    </div>
  );
}
