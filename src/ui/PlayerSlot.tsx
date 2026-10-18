import { localPlayerId, useGameStore } from '../game/store';
import type { PlayerId } from '../types';
import { ACCENT } from './accent';
import { ArcadeButton } from './ArcadeButton';
import { ForgeSteps } from './ForgeSteps';
import { useGame } from './GameContext';

/** Half-width of the diagonal where the two panels meet, and the player-color edge along it. */
const LEAN = 40;
const EDGE = 6;

/**
 * One half of the 50/50 split on the host screen.
 * The local player arrives via the avatar screen; the remote one joins from the other laptop.
 * The two panels meet on a shared diagonal, each edged in its player's color.
 */
export function PlayerSlot({ id }: { id: PlayerId }) {
  const game = useGame();
  const player = useGameStore((s) => s.players[id]);
  const phase = useGameStore((s) => s.phase);
  const role = useGameStore((s) => s.role);
  const roomCode = useGameStore((s) => s.roomCode);
  const connection = useGameStore((s) => s.connection);
  const right = id === 'p2';
  const accent = ACCENT[id];
  const busy = player.status === 'scanning' || player.status === 'forging';
  const remote = id !== localPlayerId(role);

  const rejoining = remote && connection === 'reconnecting';

  if (player.status === 'ready') {
    if (phase !== 'lobby') {
      // Mid-fight the other laptop dropped: P2 holds guard until it rejoins.
      if (!rejoining) return null;
      return (
        <span className={`absolute bottom-14 bg-ink px-3 py-1 font-cond text-sm font-bold uppercase tracking-[0.25em] text-paper/80 ${right ? 'right-6 sm:right-12' : 'left-6 sm:left-12'}`}>
          Reconnecting…
        </span>
      );
    }
    return (
      <div className={`absolute bottom-14 flex max-w-[45%] flex-col gap-2 ${right ? 'right-6 items-end sm:right-12' : 'left-6 items-start sm:left-12'}`}>
        <div className={`flex items-stretch ${right ? 'animate-in-r flex-row-reverse' : 'animate-in-l'}`}>
          <span className="animate-slam slant grid place-items-center bg-hp px-5 font-display text-2xl uppercase text-ink [--slant:10px] [animation-delay:200ms]">
            Ready
          </span>
          <span className="slant -mx-1 truncate bg-ink px-6 py-2 font-display text-xl uppercase tracking-tight [--slant:10px] sm:text-4xl">
            {player.name}
          </span>
        </div>
        <span className="bg-ink px-3 py-1 font-cond text-sm font-bold uppercase tracking-[0.25em] text-paper/60">
          {rejoining ? 'Reconnecting…' : 'Waiting for opponent'}
        </span>
      </div>
    );
  }

  const outer = right
    ? `polygon(${LEAN * 2}px 0, 100% 0, 100% 100%, 0 100%)`
    : `polygon(0 0, 100% 0, calc(100% - ${LEAN * 2}px) 100%, 0 100%)`;
  const inner = right
    ? `polygon(${LEAN * 2 + EDGE}px 0, 100% 0, 100% 100%, ${EDGE}px 100%)`
    : `polygon(0 0, calc(100% - ${EDGE}px) 0, calc(100% - ${LEAN * 2 + EDGE}px) 100%, 0 100%)`;

  return (
    <div
      className={`absolute inset-y-0 ${right ? 'animate-wipe-l right-0' : 'animate-wipe-r left-0'}`}
      style={{ width: `calc(50% + ${LEAN}px)` }}
    >
      <div className={`absolute inset-0 ${accent.bg}`} style={{ clipPath: outer }} />
      <div className="tex-hatch absolute inset-0 overflow-hidden bg-ink" style={{ clipPath: inner }}>
        {/* Oversized hollow player number: typographic texture. */}
        <span
          aria-hidden
          className={`text-hollow absolute -bottom-[0.18em] font-display text-[22rem] leading-none sm:text-[34rem] ${right ? '-right-[0.06em]' : '-left-[0.06em]'}`}
        >
          {right ? 2 : 1}
        </span>

        <div
          className={`relative flex h-full flex-col justify-center gap-6 pt-28 pb-16 ${
            right ? 'items-end pr-4 pl-14 text-right sm:pr-14 sm:pl-24' : 'items-start pl-4 pr-14 sm:pl-14 sm:pr-24'
          }`}
        >
          <div className={`flex items-stretch ${right ? 'animate-in-r flex-row-reverse' : 'animate-in-l'}`}>
            <span className={`slant ${accent.bg} grid place-items-center px-3 font-display text-sm text-ink [--slant:8px]`}>
              {accent.tag}
            </span>
            <span className="slant -mx-1 bg-paper px-4 py-1.5 font-cond text-sm font-extrabold uppercase tracking-[0.25em] text-ink [--slant:8px]">
              {busy ? player.status : remote ? (connection === 'open' ? 'Challenger connected' : 'Waiting for challenger') : 'Waiting'}
            </span>
          </div>

          <h2
            className={`max-w-full break-words font-display text-3xl uppercase leading-[0.9] tracking-tighter sm:text-7xl lg:text-8xl ${
              right ? 'animate-in-r' : 'animate-in-l'
            } [animation-delay:80ms]`}
          >
            {busy ? player.name : `Player ${right ? 2 : 1}`}
          </h2>

          {busy && (
            <div className={`animate-rise flex w-full flex-col gap-4 [animation-delay:160ms] ${right ? 'items-end' : 'items-start'}`}>
              <ForgeSteps status={player.status} color={accent.bg} />
              <p className="font-cond text-2xl font-bold uppercase tracking-[0.12em] sm:text-3xl">
                {player.statusDetail}
                <span className="animate-blink">_</span>
              </p>
            </div>
          )}

          {!busy && remote && (
            <div className={`animate-rise flex flex-col gap-3 [animation-delay:160ms] ${right ? 'items-end' : 'items-start'}`}>
              <p className="font-cond text-lg font-semibold uppercase tracking-[0.15em] text-paper/70">
                {connection === 'open' ? (
                  'Picking a fighter on the other laptop'
                ) : rejoining ? (
                  'Lost the other laptop. Rejoin with'
                ) : (
                  <>
                    On the other laptop, tap <span className="text-paper">Connect</span> and enter
                  </>
                )}
              </p>
              <RoomCode code={roomCode} />
              {!roomCode && (
                <p className="font-cond text-sm font-semibold uppercase tracking-[0.15em] text-paper/40">Signaling server not connected yet</p>
              )}
            </div>
          )}

          {!busy && player.statusDetail && (
            <p className="border-l-4 border-dmg bg-ink-2 px-3 py-2 font-semibold text-paper">{player.statusDetail}</p>
          )}

          {!busy && remote && import.meta.env.DEV && (
            <div className="animate-rise [animation-delay:240ms]">
              <ArcadeButton color={accent.bg} onClick={() => game.addTestPlayer(id)}>
                Add test player
              </ArcadeButton>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One paper tile per character, so the code reads from across the room. */
function RoomCode({ code }: { code: string | null }) {
  const chars = (code ?? '----').padEnd(4, '-').split('');
  return (
    <div className="flex gap-1 sm:gap-2">
      {chars.map((c, i) => (
        <span
          key={i}
          className={`cut grid h-14 w-10 place-items-center font-display text-3xl [--cut:8px] sm:h-24 sm:w-20 sm:text-6xl ${
            code ? 'bg-paper text-ink' : 'bg-ink-3 text-paper/30'
          }`}
        >
          {c}
        </span>
      ))}
    </div>
  );
}
