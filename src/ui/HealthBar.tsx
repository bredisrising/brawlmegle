import { useEffect, useRef } from 'react';
import { MAX_HP } from '../game/constants';

const SLANT = 18;
/** Outer end square, inner end (toward the VS badge) cut at an angle. */
const shape = (side: 'left' | 'right', slant: number) =>
  side === 'left'
    ? `polygon(0 0, 100% 0, calc(100% - ${slant}px) 100%, 0 100%)`
    : `polygon(0 0, 100% 0, 100% 100%, ${slant}px 100%)`;

/**
 * Fighting-game bar: anchored at the outer edge, drains toward the center.
 * A red damage chunk trails the yellow bar, and the frame jolts on every hit.
 */
export function HealthBar({ hp, side }: { hp: number; side: 'left' | 'right' }) {
  const frame = useRef<HTMLDivElement>(null);
  const lastHp = useRef(hp);
  const pct = `${Math.max(0, (hp / MAX_HP) * 100)}%`;
  const anchor = side === 'left' ? 'left-0' : 'right-0';
  const low = hp / MAX_HP < 0.3;

  useEffect(() => {
    if (hp < lastHp.current) {
      const dx = side === 'left' ? -1 : 1;
      frame.current?.animate(
        [0, 6, -4, 2, 0].map((x) => ({ transform: `translate(${x * dx}px, ${Math.abs(x) / 2}px)` })),
        { duration: 220, easing: 'ease-out' },
      );
    }
    lastHp.current = hp;
  }, [hp, side]);

  return (
    <div ref={frame} className="bg-paper p-[3px]" style={{ clipPath: shape(side, SLANT) }}>
      <div className="relative h-6 overflow-hidden bg-ink-2 sm:h-7" style={{ clipPath: shape(side, SLANT - 2) }}>
        <div
          className={`absolute inset-y-0 ${anchor} bg-dmg transition-[width] delay-300 duration-700 ease-out`}
          style={{ width: pct }}
        />
        <div
          className={`absolute inset-y-0 ${anchor} transition-[width,background-color] duration-100 ${low ? 'animate-blink bg-low' : 'bg-hp'}`}
          style={{ width: pct }}
        />
        {/* Quarter ticks and a hard top highlight: texture, not shine. */}
        {[25, 50, 75].map((t) => (
          <div key={t} className="absolute inset-y-0 w-[2px] bg-ink/40" style={{ left: `${t}%` }} />
        ))}
        <div className="absolute inset-x-0 top-0 h-[3px] bg-white/35" />
      </div>
    </div>
  );
}
