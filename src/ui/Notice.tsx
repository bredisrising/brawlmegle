import { useEffect } from 'react';
import { useGameStore } from '../game/store';

/** How long a notice stays up (sticky ones stay until the match starts again). */
const SHOW_MS = 4000;

/**
 * A short notice across the top of the screen when a match is called off: "Your opponent left", "You left the match",
 * or (room code) "X switched away. The fight restarts when they're back".
 */
export function Notice() {
  const notice = useGameStore((s) => s.notice);
  const screen = useGameStore((s) => s.screen);
  useEffect(() => {
    if (!notice || notice.sticky) return;
    const t = setTimeout(() => {
      if (useGameStore.getState().notice?.key === notice.key) useGameStore.setState({ notice: null });
    }, SHOW_MS);
    return () => clearTimeout(t);
  }, [notice]);
  if (!notice || (screen !== 'game' && screen !== 'client')) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-28 z-40 flex justify-center px-4 sm:top-32" role="status" aria-live="polite">
      <p
        key={notice.key}
        data-testid="notice"
        className="animate-slam slant max-w-[min(92vw,44rem)] bg-dmg px-6 py-2 text-center font-display text-2xl uppercase leading-tight tracking-tight text-ink [--slant:10px] sm:text-3xl"
      >
        {notice.text}
      </p>
    </div>
  );
}
