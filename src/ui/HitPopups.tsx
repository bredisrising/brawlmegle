import { removePopup, useGameStore, type HitKind } from '../game/store';

const STYLE: Record<HitKind, string> = {
  light: 'text-white text-3xl',
  heavy: 'text-hp text-5xl',
  blocked: 'text-sky-300 text-2xl',
};

/** Floating damage labels at the impact point. */
export function HitPopups() {
  const popups = useGameStore((s) => s.popups);

  return (
    <>
      {popups.map((p) => (
        <div
          key={p.id}
          className={`font-display text-outline animate-popup absolute whitespace-nowrap text-center leading-none ${STYLE[p.kind]}`}
          style={{ left: p.x, top: p.y }}
          onAnimationEnd={() => removePopup(p.id)}
        >
          {p.label}
          <div className="text-[0.6em]">-{p.damage}</div>
        </div>
      ))}
    </>
  );
}
