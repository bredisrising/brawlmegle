import { useEffect, useState } from 'react';
import { useGameStore } from '../game/store';

/** Matchmaking: the seconds until a bot steps in, if nobody turns up first (Game.botFill). */
export function BotCountdown() {
  const botAt = useGameStore((s) => s.botAt);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (botAt === null) return;
    const t = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(t);
  }, [botAt]);
  if (botAt === null) return null;
  const left = Math.max(0, Math.ceil((botAt - now) / 1000));
  return (
    <p className="max-w-sm font-cond text-base font-semibold uppercase tracking-[0.12em] text-paper/60">
      Nobody yet? A bot steps in <span className="text-paper">{left > 0 ? `in ${left}` : 'now'}</span>
    </p>
  );
}
