/**
 * The guard under the health bar: it drains while you block and with every blocked hit. Empty, the guard is crushed:
 * the bar turns red and refills while you can't block, with the seconds left on it.
 */
export function GuardBar({ guard, lock, side }: { guard: number; lock: number; side: 'left' | 'right' }) {
  const crushed = lock > 0;
  const low = !crushed && guard < 30;
  const pct = `${Math.max(0, Math.min(100, guard))}%`;
  const right = side === 'right';
  return (
    <div className={`flex w-[72%] items-center gap-2 ${right ? 'flex-row-reverse self-end' : ''}`}>
      <span
        className={`shrink-0 px-1.5 py-px font-cond text-[10px] font-extrabold uppercase tracking-[0.18em] sm:text-xs ${
          crushed ? 'animate-blink bg-dmg text-paper' : low ? 'bg-low text-ink' : 'bg-paper text-ink'
        }`}
      >
        {crushed ? `Guard broken ${lock.toFixed(1)}` : 'Guard'}
      </span>
      <div className="relative h-2.5 flex-1 overflow-hidden bg-ink-2 ring-2 ring-paper/70 sm:h-3">
        <div
          className={`absolute inset-y-0 ${right ? 'right-0' : 'left-0'} transition-[width] duration-100 ${
            crushed ? 'bg-dmg/70' : low ? 'animate-blink bg-low' : 'bg-p2'
          }`}
          style={{ width: pct }}
        />
      </div>
    </div>
  );
}
