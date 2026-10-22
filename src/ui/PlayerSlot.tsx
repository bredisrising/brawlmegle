import { localPlayerId, useGameStore } from '../game/store';
import type { PlayerId } from '../types';
import { ACCENT } from './accent';
import { ArcadeButton, TextButton } from './ArcadeButton';
import { CamToggle } from './CamToggle';
import { Tips } from './Tips';
import { BotCountdown } from './BotCountdown';
import { ForgePreview, useStageFits } from './ForgePreview';
import { ForgeSteps } from './ForgeSteps';
import { PLAYER_COLORS } from '../game/constants';
import { useGame } from './GameContext';

/** Half-width of the diagonal where the two panels meet, and the player-color edge along it. */
const LEAN = 40;
const EDGE = 6;
/**
 * The big forge stage's box in P2's half: under the HUD, right of the camera picture (bottom center; the left edge is
 * set from LEAN), left of the menu and moves hints (bottom right).
 */
const STAGE_BOX = 'pt-28 pb-6 pr-[7.5rem]';

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
  // This laptop's player forging gets the big stage in the right half (P2's side), instead of the card in their panel.
  const stageUp = useBigStage();
  const onStage = stageUp && !right;

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
      <>
        {stageUp && right && (
          // As in P2's panel (STAGE_BOX), and above the Ready plate.
          <div className="absolute top-28 bottom-40 left-[calc(50%+8rem)] right-[7.5rem]">
            <BigStage />
          </div>
        )}
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
        </div>
      </>
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

        {stageUp && right ? (
          <div className={`relative h-full ${STAGE_BOX}`} style={{ paddingLeft: `calc(${LEAN}px + 8rem)` }}>
            <BigStage />
          </div>
        ) : (
          <div
            className={`relative flex h-full flex-col justify-center ${player.status === 'forging' && player.forge && !onStage ? 'gap-3' : 'gap-6'} pt-28 pb-16 ${
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
                player.status === 'forging' && player.forge && !onStage ? 'sm:text-4xl lg:text-5xl' : 'sm:text-7xl lg:text-8xl [@media(max-height:720px)]:sm:!text-6xl'
              } ${
                right ? 'animate-in-r' : 'animate-in-l'
              } [animation-delay:80ms]`}
            >
              {busy ? player.name : quick && remote && !watching ? 'Opponent' : `Player ${right ? 2 : 1}`}
            </h2>

            {busy && (
              <div className={`animate-rise flex w-full flex-col ${player.forge && !onStage ? 'gap-3' : 'gap-4'} [animation-delay:160ms] ${right ? 'items-end' : 'items-start'}`}>
                <ForgeSteps status={player.status} color={accent.bg} />
                {/* With the card up, its own stage line says what's happening: room for a bigger card. */}
                <p className={`font-cond text-2xl font-bold uppercase tracking-[0.12em] sm:text-3xl ${player.forge && !onStage ? 'hidden' : ''}`}>
                  {player.statusDetail}
                  <span className="animate-blink">_</span>
                </p>
                {/* Something to watch while it forges: the brief, the sheet developing, then the 3D stages live. */}
                {player.status === 'forging' && (player.forge || player.portraitUrl) && !onStage && (
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
                  <TextButton onClick={() => game.skipForgeWait(id)} title={player.forge?.glbUrl ? undefined : "Fight as a stand-in now; your fighter materializes in when it's ready"}>
                    {player.forge?.glbUrl ? 'Fight now' : "Don't wait: fight now"}
                  </TextButton>
                )}
                {onStage && <StageAside />}
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
        )}
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
          <BotCountdown />
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

/** One paper tile per character, so the code reads from across the room (`small`: beside the forge stage). */
function RoomCode({ code, small = false }: { code: string | null; small?: boolean }) {
  const chars = (code ?? '----').padEnd(4, '-').split('');
  return (
    <div className={`flex ${small ? 'gap-1' : 'gap-1 sm:gap-2'}`}>
      {chars.map((c, i) => (
        <span
          key={i}
          className={`cut grid place-items-center font-display ${small ? 'h-11 w-9 text-2xl [--cut:6px] lg:h-14 lg:w-11 lg:text-3xl' : 'h-14 w-10 text-3xl [--cut:8px] sm:h-24 sm:w-20 sm:text-6xl'} ${
            code ? 'bg-paper text-ink' : 'bg-ink-3 text-paper/30'
          }`}
        >
          {c}
        </span>
      ))}
    </div>
  );
}

/**
 * This laptop's player (P1) is forging and gets the big stage: a laptop-sized window, in the lobby, and P2's half free
 * of a scan or forge of its own (then both keep their cards).
 */
function useBigStage(): boolean {
  const fits = useStageFits();
  const up = useGameStore((s) => {
    const { p1, p2 } = s.players;
    if (s.phase !== 'lobby' || s.role === 'spectator' || localPlayerId(s.role) !== 'p1') return false;
    return p1.status === 'forging' && Boolean(p1.forge || p1.portraitUrl) && p2.status !== 'scanning' && p2.status !== 'forging';
  });
  return fits && up;
}

/** P1's forge, big: their fighter built up on a turntable, then the finish (see ForgePreview). */
function BigStage() {
  const p1 = useGameStore((s) => s.players.p1);
  return <ForgePreview stage preview={p1.forge} art={p1.portraitUrl} color={ACCENT.p1.bg} hex={PLAYER_COLORS.p1} other={PLAYER_COLORS.p2} right />;
}

/**
 * What P2's half still has to say while P1's forge has it as the stage, under P1's own progress, kept small: the code
 * to send a friend, or that the search starts once the fighter's ready. The CPU buttons wait for the fighter.
 */
function StageAside() {
  const game = useGame();
  const roomCode = useGameStore((s) => s.roomCode);
  const connection = useGameStore((s) => s.connection);
  const quick = useGameStore((s) => s.quick);
  const p2 = useGameStore((s) => s.players.p2);
  const note = 'font-cond text-sm font-semibold uppercase tracking-[0.15em] text-paper/60';
  if (p2.status !== 'waiting') return null; // the opponent's in: nothing left to say for them
  return (
    <div className="mt-2 flex flex-col items-start gap-2 border-l-4 border-p2 pl-3">
      {quick ? (
        <>
          <p className={note}>{connection === 'open' ? 'Opponent found! Getting their fighter ready' : "Then we'll find you an opponent"}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <CamToggle />
            <TextButton className="text-sm" onClick={() => game.toTitle()}>
              Cancel
            </TextButton>
          </div>
        </>
      ) : connection === 'open' ? (
        <p className={note}>Your friend is picking a fighter</p>
      ) : (
        <>
          <p className={note}>{connection === 'reconnecting' ? 'Lost your friend. They can rejoin with' : <span className="text-paper/80">Send this code to your friend</span>}</p>
          <RoomCode code={roomCode} small />
        </>
      )}
      {p2.statusDetail && <p className="border-l-4 border-dmg bg-ink-2 px-3 py-2 text-sm font-semibold text-paper">{p2.statusDetail}</p>}
    </div>
  );
}
