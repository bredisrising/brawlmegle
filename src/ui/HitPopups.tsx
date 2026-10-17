import { removePopup, useGameStore, type HitKind } from '../game/store';

/** Plate behind the label; the damage number sits on its own ink chip. */
const STYLE: Record<HitKind, { plate: string; size: string }> = {
  light: { plate: 'bg-paper text-ink', size: 'text-xl sm:text-2xl' },
  heavy: { plate: 'bg-dmg text-paper', size: 'text-2xl sm:text-4xl' },
  blocked: { plate: 'bg-ink-3 text-paper', size: 'text-lg sm:text-xl' },
};

/** Floating hit labels at the impact point. */
export function HitPopups() {
  const popups = useGameStore((s) => s.popups);

  return (
    <>
      {popups.map((p) => (
        <div
          key={p.id}
          className={`animate-popup absolute flex items-stretch whitespace-nowrap font-display uppercase leading-none ${STYLE[p.kind].size}`}
          style={{ left: p.x, top: p.y }}
          onAnimationEnd={() => removePopup(p.id)}
        >
          <span className={`px-3 py-1.5 ${STYLE[p.kind].plate}`}>{p.label}</span>
          <span className={`grid place-items-center bg-ink px-2.5 text-[0.75em] ${p.kind === 'heavy' ? 'text-hp' : 'text-paper'}`}>
            {p.damage}
          </span>
        </div>
      ))}
    </>
  );
}
