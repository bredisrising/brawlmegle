import { ROUNDS_TO_WIN, isFinal } from '../game/rounds';
import { useGameStore } from '../game/store';
import type { PlayerId } from '../types';
import { ACCENT } from './accent';
import { GuardBar } from './GuardBar';
import { HealthBar } from './HealthBar';

/** Top bar: [portrait | hp / name]  VS  [hp / name | portrait] */
export function HUD() {
  const phase = useGameStore((s) => s.phase);
  const timeLeft = useGameStore((s) => s.timeLeft);
  const ending = useGameStore((s) => s.ending);
  const training = useGameStore((s) => s.training);
  const round = useGameStore((s) => s.round);
  const final = useGameStore((s) => isFinal(s.round, s.wins));
  const over = phase === 'ko' || phase === 'break';
  const label = over ? (ending === 'time' ? 'TIME' : 'KO') : training && phase === 'fighting' ? '\u221e' : phase === 'fighting' && timeLeft !== null ? String(timeLeft) : 'VS';
  const urgent = phase === 'fighting' && timeLeft !== null && timeLeft <= 10;
  // The K.O. replay is a cutscene: no HUD over it.
  const replay = useGameStore((s) => s.replay);
  const walkout = useGameStore((s) => s.walkout);
  if (replay || walkout) return null;

  return (
    <div className="absolute inset-x-0 top-0 grid grid-cols-[1fr_auto_1fr] items-start gap-2 px-3 pt-3 sm:gap-4 sm:px-8 sm:pt-6">
      <PlayerHUD id="p1" />
      <div className="animate-rise flex flex-col items-center">
        <div className="cut bg-paper p-[3px] [--cut:10px]">
          <div className="cut grid h-12 w-16 place-items-center bg-ink [--cut:9px] sm:h-16 sm:w-24">
            <span
              className={`font-display leading-none tracking-tight ${label.length > 3 ? 'text-xl sm:text-3xl' : label.length > 2 ? 'text-2xl sm:text-4xl' : 'text-3xl sm:text-5xl'} ${
                over || urgent ? 'text-dmg' : 'text-paper'
              }`}
            >
              {label}
            </span>
          </div>
        </div>
        {/* Which of the best of three this is (the lobby and Training just get the yellow underline). */}
        {phase === 'lobby' || training ? (
          <div className="mt-1 h-1.5 w-10 bg-hp sm:w-14" />
        ) : (
          <span
            key={final ? 'final' : round}
            className={`animate-slam mt-1 px-2 py-px font-cond text-[10px] font-extrabold uppercase leading-tight tracking-[0.2em] sm:text-xs ${
              final ? 'bg-dmg text-paper' : 'bg-hp text-ink'
            }`}
          >
            {final ? 'Final round' : `Round ${round}`}
          </span>
        )}
      </div>
      <PlayerHUD id="p2" />
    </div>
  );
}

/**
 * Rounds won, under the health bar's inner end (toward the clock): a diamond per round it takes to win the match,
 * lit yellow (with a slam) as each is taken.
 */
function RoundPips({ won, right }: { won: number; right: boolean }) {
  return (
    <div className={`flex shrink-0 items-center gap-1.5 pr-4 sm:gap-2 sm:pr-6 ${right ? 'flex-row-reverse pl-4 pr-0 sm:pl-6 sm:pr-0' : ''}`} aria-label={`${won} round${won === 1 ? '' : 's'} won`}>
      {Array.from({ length: ROUNDS_TO_WIN }, (_, i) => {
        // Lit from the outer end inward (P2's row runs right to left).
        const lit = i < won;
        return (
          <span key={i} className="grid size-3.5 rotate-45 place-items-center bg-paper sm:size-4">
            <span key={lit ? 'lit' : 'dim'} className={`size-2 sm:size-2.5 ${lit ? 'animate-slam bg-hp' : 'bg-ink-2'}`} />
          </span>
        );
      })}
    </div>
  );
}

const STATUS_LABEL = { waiting: 'Waiting', scanning: 'Scanning', forging: 'Forging', ready: 'Ready' };

function PlayerHUD({ id }: { id: PlayerId }) {
  const player = useGameStore((s) => s.players[id]);
  const phase = useGameStore((s) => s.phase);
  const training = useGameStore((s) => s.training);
  const wins = useGameStore((s) => s.wins[id]);
  const right = id === 'p2';
  const accent = ACCENT[id];
  const showStatus = player.status !== 'ready' || phase === 'lobby';
  const inMatch = phase !== 'lobby';

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
        <div className="flex w-full flex-col gap-1">
          <HealthBar hp={player.hp} side={right ? 'right' : 'left'} />
          {inMatch && (
            <div className={`flex items-center justify-between gap-2 ${right ? 'flex-row-reverse' : ''}`}>
              <GuardBar guard={player.guard} lock={player.guardLock} side={right ? 'right' : 'left'} />
              {!training && <RoundPips won={wins} right={right} />}
            </div>
          )}
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

