import { COUNTDOWN_FROM } from '../game/constants';
import { isFinal } from '../game/rounds';
import { useGameStore } from '../game/store';

const CHROME = 'linear-gradient(180deg, #ffffff 0%, #e9ecf2 38%, #8d93a3 50%, #f4f6fa 62%, #ffffff 100%)';

/**
 * After the walkout (the countdown's first beat, round 1 only): ROUND N (FINAL ROUND for the decider), then FIGHT!.
 * Chrome lettering with the walkout's brush numeral, slammed in like Street Fighter 6. The announcer shouts both
 * (director/Walkout.ts, Game).
 */
export function Countdown() {
  const countdown = useGameStore((s) => s.countdown);
  const round = useGameStore((s) => s.round);
  const final = useGameStore((s) => isFinal(s.round, s.wins));
  if (countdown === null || countdown === COUNTDOWN_FROM) return null;
  return (
    <div className="absolute inset-0 grid place-items-center overflow-hidden">
      {countdown === 0 ? <Fight /> : final ? <FinalRound /> : <Round n={round} />}
    </div>
  );
}

const chrome = { backgroundImage: CHROME, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', WebkitTextStroke: '0.02em #0b0a10' } as const;

/** The decider: FINAL over ROUND, the band in red. */
function FinalRound() {
  return (
    <div className="relative flex flex-col items-center">
      <div className="animate-round-band absolute inset-x-[-40vw] top-1/2 h-[70%] -translate-y-1/2 -skew-y-3 bg-dmg/80" />
      <span
        className="animate-num-slam relative font-display text-[min(11vw,17vh)] uppercase leading-[0.9] text-hp"
        style={{ WebkitTextStroke: '0.035em #0b0a10', paintOrder: 'stroke fill', textShadow: '0.05em 0.06em 0 #ff2d95, 0.09em 0.1em 0 #0b0a10' }}
      >
        Final
      </span>
      <span className="animate-round-in relative font-display text-[min(15vw,24vh)] uppercase leading-[0.9] tracking-tighter" style={chrome}>
        Round
      </span>
    </div>
  );
}

function Round({ n }: { n: number }) {
  return (
    <div className="relative flex items-center">
      <div className="animate-round-band absolute inset-x-[-40vw] top-1/2 h-[46%] -translate-y-1/2 -skew-y-3 bg-ink/70" />
      <span
        className="animate-round-in relative font-display text-[min(15vw,24vh)] uppercase leading-none tracking-tighter"
        style={chrome}
      >
        Round
      </span>
      <span className="relative ml-[0.25em] grid place-items-center">
        <svg viewBox="-100 -100 200 200" className="animate-num-splat absolute h-[min(26vw,40vh)] w-[min(26vw,40vh)]">
          <path d="M-62 -18 Q-70 -60 -22 -72 Q8 -96 34 -66 Q78 -64 70 -18 Q96 12 62 40 Q54 84 6 70 Q-34 92 -52 56 Q-92 34 -62 -18Z M74 -70 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0Z M-84 62 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0Z" fill="#ff2d95" />
        </svg>
        <span
          className="animate-num-slam relative font-display text-[min(22vw,34vh)] leading-none text-hp"
          style={{ WebkitTextStroke: '0.035em #0b0a10', paintOrder: 'stroke fill', textShadow: '0.05em 0.06em 0 #ff2d95, 0.09em 0.1em 0 #0b0a10' }}
        >
          {n}
        </span>
      </span>
    </div>
  );
}

function Fight() {
  return (
    <div className="relative">
      <span
        className="animate-fight-slam relative block font-display text-[min(22vw,36vh)] uppercase leading-none tracking-tighter"
        style={{
          backgroundImage: `linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.95) 50%, transparent 60%), ${CHROME}`,
          backgroundSize: '250% 100%, 100% 100%',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
          WebkitTextStroke: '0.022em #0b0a10',
          filter: 'drop-shadow(0 0 28px rgba(255, 106, 19, 0.75)) drop-shadow(0.04em 0.05em 0 #0b0a10)',
        }}
      >
        Fight!
      </span>
    </div>
  );
}
