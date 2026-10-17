import { useGameStore } from '../game/store';

export function Countdown() {
  const countdown = useGameStore((s) => s.countdown);
  if (countdown === null) return null;

  return (
    <div className="absolute inset-0 grid place-items-center">
      {/* key restarts the animation on every tick */}
      <span
        key={countdown}
        className={`font-display text-outline animate-countdown ${countdown === 0 ? 'text-[10rem] text-hp' : 'text-[14rem] text-white'}`}
      >
        {countdown === 0 ? 'FIGHT!' : countdown}
      </span>
    </div>
  );
}
