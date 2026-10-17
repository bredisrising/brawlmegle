import { MAX_HP } from '../game/constants';

/**
 * Street Fighter-style bar: anchored at the outer edge, drains toward the center.
 * A lagging red "damage" layer trails behind the yellow bar.
 */
export function HealthBar({ hp, side }: { hp: number; side: 'left' | 'right' }) {
  const pct = `${Math.max(0, (hp / MAX_HP) * 100)}%`;
  const anchor = side === 'left' ? 'left-0' : 'right-0';
  const low = hp / MAX_HP < 0.3;

  return (
    <div className={`relative h-5 w-full overflow-hidden border-2 border-black bg-black/70 ${side === 'left' ? '-skew-x-12' : 'skew-x-12'}`}>
      <div
        className={`absolute inset-y-0 ${anchor} bg-red-600 transition-[width] delay-300 duration-700 ease-out`}
        style={{ width: pct }}
      />
      <div
        className={`absolute inset-y-0 ${anchor} transition-[width] duration-100 ${low ? 'animate-pulse bg-orange-500' : 'bg-gradient-to-b from-hp to-amber-500'}`}
        style={{ width: pct }}
      />
      <div className="absolute inset-x-0 top-0 h-1/3 bg-white/25" />
    </div>
  );
}
