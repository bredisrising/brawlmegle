import { useGameStore } from '../game/store';

export function Countdown() {
  const countdown = useGameStore((s) => s.countdown);
  if (countdown === null) return null;
  const fight = countdown === 0;

  return (
    <div className="absolute inset-0 grid place-items-center">
      {/* Band wipes in once for the numbers, and again (yellow) for FIGHT. */}
      <div key={String(fight)} className={`animate-band relative w-[110%] -rotate-3 ${fight ? 'bg-hp' : 'bg-ink'}`}>
        <div className={`absolute inset-x-0 top-0 h-1.5 ${fight ? 'bg-ink' : 'bg-paper'}`} />
        <div className={`absolute inset-x-0 bottom-0 h-1.5 ${fight ? 'bg-ink' : 'bg-paper'}`} />
        <div className="tex-hatch flex h-44 items-center justify-center overflow-hidden sm:h-60">
          {/* key restarts the slam on every tick */}
          <span
            key={countdown}
            className={`animate-countdown font-display leading-none tracking-tighter ${
              fight ? 'text-[6rem] text-ink sm:text-[11rem]' : 'text-[9rem] text-paper sm:text-[14rem]'
            }`}
          >
            {fight ? 'FIGHT!' : countdown}
          </span>
        </div>
      </div>
    </div>
  );
}
