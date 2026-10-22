import { useEffect, useState } from 'react';
import { localPlayerId, useGameStore } from '../game/store';
import { opponentOf } from '../types';
import { ACCENT } from './accent';
import { ArcadeButton, TextButton } from './ArcadeButton';
import { useGame } from './GameContext';
import { Tips } from './Tips';
import { DeleteCode } from './DeleteCode';
import { PLACEMENT, tierOf, type RatingChange } from '../forge/leaderboard';

export function KOOverlay() {
  const game = useGame();
  const phase = useGameStore((s) => s.phase);
  const winner = useGameStore((s) => s.winner);
  const winnerName = useGameStore((s) => (s.winner ? s.players[s.winner].name : ''));
  const ending = useGameStore((s) => s.ending);
  const replay = useGameStore((s) => s.replay);
  const role = useGameStore((s) => s.role);
  const quick = useGameStore((s) => s.quick);
  const votes = useGameStore((s) => s.votes);
  const nextAt = useGameStore((s) => s.nextAt);
  // A fresh forge's delete code, not yet dismissed, takes the tips' place (they're back after "Got it").
  const deleteCode = useGameStore((s) => s.deleteCode !== null);
  // The commentators' captions sit where the tip does: the tip steps aside (keeping its space) while they talk.
  const talking = useGameStore((s) => s.caption !== null);
  // A human on the other laptop (not the CPU, which always says yes).
  const human = useGameStore((s) => s.connection === 'open');
  // This laptop's player's rating, once the host has reported a round between two people.
  const rating = useGameStore((s) => s.players[localPlayerId(s.role)].rating);
  if (phase !== 'ko') return null;
  if (replay) return <ReplayBars />;
  const accent = ACCENT[winner ?? 'p1'];
  const fromRight = winner === 'p2';
  const me = localPlayerId(role);
  const voted = votes[me];
  const theyVoted = human && votes[opponentOf(me)];

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-ink/45">
      <div className="animate-band relative w-[110%] -rotate-3 bg-dmg">
        <div className="absolute inset-x-0 top-0 h-2 bg-ink" />
        <div className="absolute inset-x-0 bottom-0 h-2 bg-ink" />
        <div className="tex-hatch flex h-[min(16rem,28vh)] items-center justify-center overflow-hidden">
          <span className="animate-slam font-display text-[min(14rem,24vh,30vw)] leading-none tracking-tighter text-ink [animation-delay:120ms]">
            {ending === 'time' ? 'TIME' : 'K.O.'}
          </span>
        </div>
      </div>

      <div className={`mt-[min(2.5rem,4vh)] flex items-stretch [animation-delay:450ms] ${fromRight ? 'animate-in-r' : 'animate-in-l'}`}>
        <span className={`slant ${accent.bg} grid place-items-center px-5 font-display text-2xl text-ink [--slant:10px]`}>
          {accent.tag}
        </span>
        <span className="slant -ml-1 bg-paper px-6 py-3 font-display text-3xl uppercase tracking-tight text-ink [--slant:10px] sm:text-5xl">
          {winner ? `${winnerName} wins` : 'Draw'}
        </span>
      </div>

      {rating && role !== 'spectator' && <RatingLine change={rating} />}

      <div className="animate-rise mt-[min(2rem,3.5vh)] flex flex-col items-center gap-4 [animation-delay:700ms]">
        {role !== 'spectator' && (
          <div className="flex flex-col items-center gap-2">
            {/* Both players have to want it: say who's in. */}
            <p className={`h-8 font-display text-2xl uppercase tracking-tight ${theyVoted ? 'animate-slam text-hp' : 'invisible'}`}>
              {voted ? 'Rematch on!' : 'Opponent wants a rematch!'}
            </p>
            <ArcadeButton
              size="lg"
              data-voted={voted || undefined}
              aria-pressed={voted}
              className={voted ? 'pointer-events-none !bg-ink-3 !text-paper/80' : theyVoted ? 'animate-pulse' : ''}
              onClick={() => game.voteRematch()}
            >
              {voted ? 'Waiting for opponent…' : 'Rematch'}
            </ArcadeButton>
            {quick && nextAt !== null && <NextCountdown at={nextAt} />}
          </div>
        )}
        <div className="flex gap-6">
          {quick && role !== 'spectator' && <TextButton onClick={() => game.nextOpponent()}>Next opponent →</TextButton>}
          {role === 'host' && !quick && <TextButton onClick={() => game.changeFighter()}>Change fighter</TextButton>}
          <TextButton onClick={() => game.toTitle()}>Title</TextButton>
        </div>
        {role !== 'spectator' && (deleteCode ? <DeleteCode layout="row" /> : <Tips width="max-w-3xl" className={`bg-ink/70 px-3 py-2 ${talking ? 'invisible' : ''}`} />)}
      </div>
    </div>
  );
}

/** Matchmade fights: unless both vote for a rematch, both go find someone new when this runs out. */
function NextCountdown({ at }: { at: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((at - now) / 1000));
  return (
    <p className="font-cond text-lg font-bold uppercase tracking-[0.2em] text-paper/80" aria-live="polite">
      {left > 0 ? (
        <>
          Next opponent in <span key={left} className="animate-slam inline-block font-display text-2xl text-paper">{left}</span>…
        </>
      ) : (
        'Finding your next opponent…'
      )}
    </p>
  );
}

/** During the K.O. replay: letterbox bars and a REPLAY tag, so it reads as a replay and not live play. */
function ReplayBars() {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="absolute inset-x-0 top-0 h-[11%] bg-black" />
      <div className="absolute inset-x-0 bottom-0 h-[11%] bg-black" />
      <div className="absolute left-6 top-[13%] flex items-center gap-2 font-display text-2xl uppercase tracking-tight text-paper sm:text-3xl">
        <span className="animate-blink size-3 rounded-full bg-dmg" />
        Replay
      </div>
    </div>
  );
}

/**
 * The rated round's payoff: how far the rating moved, where it stands, and the rank (or how far into the placement
 * rounds). Finishing placement, or climbing into a new rank, gets its own line.
 */
function RatingLine({ change }: { change: RatingChange }) {
  const delta = change.after - change.before;
  const tier = tierOf(change.after);
  const placed = change.rated === PLACEMENT;
  const climbed = change.rated > PLACEMENT && delta > 0 && tierOf(change.before) !== tier;
  return (
    <div className="animate-rise mt-[min(1.25rem,2.5vh)] flex flex-col items-center gap-2 [animation-delay:600ms]">
      <p className="flex items-baseline gap-3 bg-ink/85 px-4 py-1.5 font-cond text-lg font-extrabold uppercase tracking-[0.16em]">
        <span className={delta >= 0 ? 'text-hp' : 'text-dmg'}>{delta >= 0 ? `+${delta}` : `−${-delta}`}</span>
        <span className="font-display text-3xl tracking-tight text-paper">{change.after.toLocaleString('en-US')}</span>
        <span className="text-paper/70">{change.rated >= PLACEMENT ? tier : `Placement ${change.rated}/${PLACEMENT}`}</span>
      </p>
      {(placed || climbed) && (
        <p className="animate-slam bg-hp px-3 py-1 font-display text-xl uppercase tracking-tight text-ink [animation-delay:900ms]">
          {placed ? `Ranked: ${tier}!` : `New rank: ${tier}!`}
        </p>
      )}
    </div>
  );
}
