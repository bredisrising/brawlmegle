import { localPlayerId, useGameStore } from '../game/store';
import type { PlayerId } from '../types';
import { ACCENT } from './accent';
import { ArcadeButton, TextButton } from './ArcadeButton';
import { CamToggle } from './CamToggle';
import { DeleteCode } from './DeleteCode';
import { Tips } from './Tips';
import { ForgePreview } from './ForgePreview';
import { ForgeSteps } from './ForgeSteps';
import { PLAYER_COLORS } from '../game/constants';
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
  const quick = useGameStore((s) => s.quick);
  const searching = useGameStore((s) => s.searching);
  const right = id === 'p2';
  const accent = ACCENT[id];
  const busy = player.status === 'scanning' || player.status === 'forging';
  // A watching screen (spectate) has no player of its own and no controls: both slots just show the players.
  const watching = role === 'spectator';
  const remote = watching || id !== localPlayerId(role);

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
          {rejoining ? 'Reconnecting…' : quick && searching ? 'Looking for an opponent…' : 'Waiting for opponent'}
        </span>
        {!remote && <DeleteCode />}
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
          className={`relative flex h-full flex-col justify-center ${player.status === 'forging' && player.forge ? 'gap-3' : 'gap-6'} pt-28 pb-16 ${
            right ? 'items-end pr-4 pl-14 text-right sm:pr-14 sm:pl-24' : 'items-start pl-4 pr-14 sm:pl-14 sm:pr-24'
          }`}
        >
          <div className={`flex items-stretch ${right ? 'animate-in-r flex-row-reverse' : 'animate-in-l'}`}>
            <span className={`slant ${accent.bg} grid place-items-center px-3 font-display text-sm text-ink [--slant:8px]`}>
              {accent.tag}
            </span>
            <span className="slant -mx-1 bg-paper px-4 py-1.5 font-cond text-sm font-extrabold uppercase tracking-[0.25em] text-ink [--slant:8px]">
              {busy ? player.status : watching ? 'Getting ready' : remote ? (connection === 'open' ? (quick ? 'Opponent found' : 'Challenger connected') : quick ? 'Online' : 'Waiting for challenger') : 'Waiting'}
            </span>
          </div>

          <h2
            className={`max-w-full break-words font-display text-3xl uppercase leading-[0.9] tracking-tighter ${
              player.status === 'forging' && player.forge ? 'sm:text-4xl lg:text-5xl' : 'sm:text-7xl lg:text-8xl [@media(max-height:720px)]:sm:!text-6xl'
            } ${
              right ? 'animate-in-r' : 'animate-in-l'
            } [animation-delay:80ms]`}
          >
            {busy ? player.name : quick && remote && !watching ? 'Opponent' : `Player ${right ? 2 : 1}`}
          </h2>

          {busy && (
            <div className={`animate-rise flex w-full flex-col ${player.forge ? 'gap-3' : 'gap-4'} [animation-delay:160ms] ${right ? 'items-end' : 'items-start'}`}>
              <ForgeSteps status={player.status} color={accent.bg} />
              {/* With the live preview up, its own stage line says what's happening: room for a bigger preview. */}
              <p className={`font-cond text-2xl font-bold uppercase tracking-[0.12em] sm:text-3xl ${player.forge ? 'hidden' : ''}`}>
                {player.statusDetail}
                <span className="animate-blink">_</span>
              </p>
              {/* Something to watch while it forges: the brief, the sheet developing, then the 3D stages live. */}
              {player.status === 'forging' && (player.forge || player.portraitUrl) && (
                <ForgePreview
                  preview={player.forge}
                  art={player.portraitUrl}
                  color={accent.bg}
                  hex={PLAYER_COLORS[id]}
                  other={PLAYER_COLORS[right ? 'p1' : 'p2']}
                  right={right}
                />
              )}
              {player.status === 'forging' && !remote && !watching && (
                <TextButton onClick={() => game.skipForgeWait(id)} title="Fight as a stand-in now; your fighter materializes in when it's ready">
                  Don't wait: fight now
                </TextButton>
              )}
            </div>
          )}

          {!busy && remote && !watching && quick && <QuickSearch right={right} found={connection === 'open'} searching={searching} />}

          {!busy && remote && !watching && !quick && (
            <div className={`animate-rise flex flex-col gap-3 [animation-delay:160ms] ${right ? 'items-end' : 'items-start'}`}>
              <p className="font-cond text-lg font-semibold uppercase tracking-[0.15em] text-paper/70">
                {connection === 'open' ? (
                  'Your friend is picking a fighter'
                ) : rejoining ? (
                  'Lost your friend. They can rejoin with'
                ) : (
                  <span className="text-paper">Send this code to your friend</span>
                )}
              </p>
              <RoomCode code={roomCode} />
              {!roomCode && (
                <p className="font-cond text-sm font-semibold uppercase tracking-[0.15em] text-paper/40">Getting a code…</p>
              )}
              {roomCode && connection !== 'open' && !rejoining && (
                <p className="font-cond text-sm font-semibold uppercase tracking-[0.12em] text-paper/50">
                  On their screen: <span className="text-paper/80">Play a friend</span>, then <span className="text-paper/80">Join with a code</span>
                </p>
              )}
            </div>
          )}

          {!busy && player.statusDetail && (
            <p className="border-l-4 border-dmg bg-ink-2 px-3 py-2 font-semibold text-paper">{player.statusDetail}</p>
          )}

          {!busy && remote && !watching && !quick && connection !== 'open' && (
            <div className={`animate-rise flex flex-col gap-2 [animation-delay:240ms] ${right ? 'items-end' : 'items-start'}`}>
              <p className="font-cond text-sm font-semibold uppercase tracking-[0.2em] text-paper/60">No one around? Fight the CPU</p>
              <div className="flex flex-wrap gap-2">
                {(['easy', 'normal', 'hard'] as const).map((level) => (
                  <ArcadeButton key={level} color={accent.bg} onClick={() => void game.addCpuPlayer(id, level)}>
                    {level}
                  </ArcadeButton>
                ))}
              </div>
            </div>
          )}

          {!busy && remote && !watching && import.meta.env.DEV && (
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

/** Matchmaking: the opponent's side while we look for one (no code to share: the server pairs strangers). */
function QuickSearch({ right, found, searching }: { right: boolean; found: boolean; searching: boolean }) {
  const game = useGame();
  return (
    <div className={`animate-rise flex flex-col gap-3 [animation-delay:160ms] ${right ? 'items-end' : 'items-start'}`}>
      {found ? (
        <p className="font-cond text-2xl font-bold uppercase tracking-[0.12em] text-hp">Opponent found! Getting their fighter ready</p>
      ) : searching ? (
        <>
          <p data-testid="searching" className="flex items-center gap-3 whitespace-nowrap font-display text-2xl uppercase tracking-tight sm:text-3xl">
            <Radar />
            Looking for an opponent<span className="animate-blink">…</span>
          </p>
          <p className="max-w-sm font-cond text-base font-semibold uppercase tracking-[0.12em] text-paper/60">
            Stay on this screen: the fight starts as soon as someone's found.
          </p>
          <CamChoice right={right} />
          <Tips align={right ? 'end' : 'start'} />
        </>
      ) : (
        <>
          <p className="max-w-sm font-cond text-lg font-semibold uppercase tracking-[0.12em] text-paper/60">
            We'll find you an opponent as soon as your fighter is ready
          </p>
          <CamChoice right={right} />
        </>
      )}
      <TextButton className="text-sm" onClick={() => game.toTitle()}>
        Cancel
      </TextButton>
    </div>
  );
}

/** Before a stranger is found: whether they'll see this camera (and this player theirs), switchable right there. */
function CamChoice({ right }: { right: boolean }) {
  const hidden = useGameStore((s) => s.camHidden);
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${right ? 'justify-end' : ''}`}>
      <CamToggle />
      <span className="font-cond text-sm font-semibold uppercase tracking-[0.12em] text-paper/50">
        {hidden ? 'Cameras stay off both ways' : "You'll see each other's camera"}
      </span>
    </div>
  );
}

/** A sweeping ring: we're looking. */
function Radar() {
  return (
    <span aria-hidden className="relative grid size-8 shrink-0 place-items-center">
      <span className="absolute inset-0 animate-ping rounded-full border-2 border-p2" />
      <span className="size-2.5 rounded-full bg-p2" />
    </span>
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
