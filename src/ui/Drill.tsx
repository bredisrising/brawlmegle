import { useGameStore } from '../game/store';
import { ArcadeButton, TextButton } from './ArcadeButton';
import { useGame } from './GameContext';

/**
 * Training's punch drill (game/drill.ts): a button to start it, the move being called in big letters, and the score at
 * the end, with the choice to send the moves (pose points only) so the game learns to read more people.
 */
export function Drill() {
  const game = useGame();
  const training = useGameStore((s) => s.training);
  const fighting = useGameStore((s) => s.phase === 'fighting');
  const drill = useGameStore((s) => s.drill);
  if (!training || !fighting) return null;

  if (!drill) {
    return (
      <div className="pointer-events-none absolute right-4 top-28 sm:right-8 sm:top-32">
        <ArcadeButton color="bg-hp" onClick={() => game.startDrill()}>Punch drill</ArcadeButton>
      </div>
    );
  }

  const r = drill.result;
  if (r) {
    const rows = r.rows;
    return (
      <div className="animate-rise pointer-events-auto absolute right-4 top-28 w-[min(92vw,22rem)] sm:right-8 sm:top-32">
        <span className="slant bg-hp px-3 py-1 font-display text-sm uppercase text-ink [--slant:8px]">Drill score</span>
        <div className="mt-1 bg-ink/85 px-3 py-2.5">
          <p className="font-display text-3xl uppercase leading-none tracking-tight text-paper">
            {r.typed}/{r.scored} <span className="text-lg text-paper/70">right move</span>
          </p>
          <p className="mt-1 font-cond text-xs font-bold uppercase tracking-[0.15em] text-paper/60">
            {r.caught}/{r.scored} caught · {r.quietOk}/{r.quiet} stayed still
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-x-3 text-sm leading-snug">
            {rows.map((row, i) => (
              <li key={i} className={row.verdict === 'hit' || row.verdict === 'clean' ? 'text-paper' : row.verdict === 'wrong type' ? 'text-low' : 'text-dmg'}>
                {row.say}: {row.verdict === 'hit' || row.verdict === 'clean' ? '✓' : row.verdict}
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-1 bg-ink/85 px-3 py-2.5 text-sm leading-snug text-paper/80">
          {drill.sent === 'sent' ? (
            <p>Sent. Thanks: this is how the game learns to read players like you.</p>
          ) : drill.sent === 'failed' ? (
            <p>Couldn't send it this time.</p>
          ) : (
            <>
              <p>Help the game read you better: send these moves to us. Only your tracked points, never video.</p>
              <ArcadeButton className="mt-2" color="bg-p1" disabled={drill.sent === 'sending'} onClick={() => void game.sendDrill()}>
                {drill.sent === 'sending' ? 'Sending' : 'Send my moves'}
              </ArcadeButton>
            </>
          )}
        </div>
        <div className="mt-1 flex gap-4">
          <TextButton onClick={() => game.startDrill()}>Again</TextButton>
          <TextButton onClick={() => game.stopDrill()}>Close</TextButton>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-[18%] flex flex-col items-center text-center">
      {drill.ready !== null ? (
        <p className="font-display text-5xl uppercase tracking-tight text-paper drop-shadow-[0_4px_0_#0b0a10]">Get ready {drill.ready}</p>
      ) : drill.say ? (
        <div key={drill.index} className="animate-slam">
          <p className="font-display text-6xl uppercase leading-none tracking-tighter text-hp drop-shadow-[0_4px_0_#0b0a10] sm:text-8xl">{drill.say}</p>
          <p className="mt-2 font-cond text-lg font-bold uppercase tracking-[0.15em] text-paper drop-shadow-[0_2px_0_#0b0a10]">{drill.hint}</p>
        </div>
      ) : null}
      <p className="mt-3 bg-ink/70 px-2 py-0.5 font-cond text-xs font-bold uppercase tracking-[0.3em] text-paper/85">
        {Math.max(0, drill.index + 1)}/{drill.total}
      </p>
    </div>
  );
}
