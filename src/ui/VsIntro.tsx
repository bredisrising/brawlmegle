import { COUNTDOWN_FROM } from '../game/constants';
import { useGameStore } from '../game/store';
import type { PlayerId } from '../types';
import { ACCENT } from './accent';

/** Before each round, fighting-game style: both fighters' card art slams in from the sides, VS in the middle. */
export function VsIntro() {
  const show = useGameStore((s) => s.phase === 'countdown' && s.countdown === COUNTDOWN_FROM);
  if (!show) return null;
  return (
    <div className="absolute inset-0 overflow-hidden bg-ink">
      <Side id="p1" />
      <Side id="p2" />
      <div className="absolute inset-0 grid place-items-center">
        <span className="animate-slam font-display text-[7rem] leading-none tracking-tighter text-paper drop-shadow-[0_6px_0_#0b0a10] [animation-delay:350ms] sm:text-[12rem]">
          VS
        </span>
      </div>
    </div>
  );
}

function Side({ id }: { id: PlayerId }) {
  const player = useGameStore((s) => s.players[id]);
  const right = id === 'p2';
  const accent = ACCENT[id];
  // Each half is cut on the diagonal where they meet, edged in the player's color.
  const clip = right ? 'polygon(56% 0, 100% 0, 100% 100%, 44% 100%)' : 'polygon(0 0, 56% 0, 44% 100%, 0 100%)';
  return (
    <div className={`absolute inset-0 ${right ? 'animate-vs-r' : 'animate-vs-l'}`}>
      <div className={`absolute inset-0 ${accent.bg}`} style={{ clipPath: clip }} />
      <div
        className="tex-hatch absolute inset-0 bg-ink-2"
        style={{ clipPath: right ? 'polygon(calc(56% + 8px) 0, 100% 0, 100% 100%, calc(44% + 8px) 100%)' : 'polygon(0 0, calc(56% - 8px) 0, calc(44% - 8px) 100%, 0 100%)' }}
      >
        {player.portraitUrl && (
          <img
            src={player.portraitUrl}
            alt=""
            className={`absolute bottom-0 h-[92%] w-1/2 object-cover object-top ${right ? 'right-0' : 'left-0'}`}
            style={{ maskImage: 'linear-gradient(to top, transparent, black 25%)' }}
          />
        )}
      </div>
      <div className={`absolute bottom-[10%] flex flex-col gap-1 ${right ? 'right-6 items-end sm:right-12' : 'left-6 items-start sm:left-12'}`}>
        <span className={`slant ${accent.bg} px-3 py-1 font-display text-sm text-ink [--slant:8px]`}>{accent.tag}</span>
        <span className="max-w-[44vw] truncate font-display text-4xl uppercase leading-none tracking-tighter text-paper drop-shadow-[0_4px_0_#0b0a10] sm:text-7xl">
          {player.name}
        </span>
      </div>
    </div>
  );
}
