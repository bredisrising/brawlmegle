import { useGameStore } from '../../game/store';
import type { Phase } from '../../types';
import { ACCENT } from '../accent';
import { ForgeSteps } from '../ForgeSteps';
import { MoveGuide } from '../MoveGuide';
import { ForgePreview, useStageFits } from '../ForgePreview';
import { PLAYER_COLORS } from '../../game/constants';
import { TextButton } from '../ArcadeButton';
import { DeleteCode } from '../DeleteCode';
import { useGame } from '../GameContext';

/** Headline once P2 is ready, following the host's phase. */
const READY_HEADLINE: Record<Phase, string> = {
  lobby: "You're in!",
  countdown: 'Get ready!',
  fighting: 'FIGHT!',
  break: 'Next round!',
  ko: 'K.O.!',
};

/**
 * The forge's big moment on this laptop: on a laptop-sized window its preview gets the right half as a stage, instead
 * of a card in the column (the opponent's camera moves bottom left for it, see OpponentCam).
 */
export function useClientStage(): boolean {
  const fits = useStageFits();
  const shown = useGameStore((s) => s.screen === 'client' && s.players.p2.status === 'forging' && Boolean(s.players.p2.forge || s.players.p2.portraitUrl));
  return fits && shown;
}

/** What the client laptop shows after picking a fighter: its own player's progress. The fight is on the host screen. */
export function ClientScreen() {
  const game = useGame();
  const player = useGameStore((s) => s.players.p2);
  const roomCode = useGameStore((s) => s.roomCode);
  const connection = useGameStore((s) => s.connection);
  const phase = useGameStore((s) => s.phase);
  const busy = player.status === 'scanning' || player.status === 'forging';
  const accent = ACCENT.p2;
  const forgeShown = player.status === 'forging' && Boolean(player.forge || player.portraitUrl);
  const stage = useClientStage();

  return (
    <div className="tex-hatch pointer-events-auto absolute inset-0 overflow-hidden bg-ink">
      <span aria-hidden className="text-hollow absolute -right-[0.06em] -bottom-[0.18em] font-display text-[22rem] leading-none sm:text-[34rem]">
        2
      </span>

      {stage && (
        // Right of the camera picture (bottom center).
        <div className="absolute top-10 bottom-10 left-[calc(50%+8.5rem)] right-6 sm:right-14">
          <ForgePreview stage preview={player.forge} art={player.portraitUrl} color={accent.bg} hex={PLAYER_COLORS.p2} other={PLAYER_COLORS.p1} right />
        </div>
      )}

      <div className={`relative flex h-full flex-col justify-center gap-6 px-6 sm:px-14 ${stage ? 'w-[calc(50%+8rem)] pb-[calc(clamp(9rem,15vw,14rem)*0.75+6.5rem)]' : ''}`}>
        <div className="animate-in-l flex items-stretch font-cond text-sm font-extrabold uppercase tracking-[0.25em]">
          <span className={`slant ${accent.bg} grid place-items-center px-3 font-display tracking-normal text-ink [--slant:8px]`}>{accent.tag}</span>
          <span className="slant -ml-1 bg-paper px-4 py-1.5 text-ink [--slant:8px]">Room {roomCode}</span>
        </div>

        <h2 className="animate-in-l max-w-full break-words font-display text-6xl uppercase leading-[0.88] tracking-tighter [animation-delay:80ms] sm:text-8xl">
          {player.name}
        </h2>

        {connection === 'reconnecting' && (
          <div className="flex items-center gap-3 self-start border-l-4 border-dmg bg-ink-2 px-4 py-2 font-semibold">
            <span className="animate-blink size-3 bg-dmg" />
            Lost the big screen. Reconnecting…
          </div>
        )}

        {(busy || player.status === 'ready') && <ForgeSteps status={player.status} color={accent.bg} />}

        {busy && (
          <p className="font-cond text-2xl font-bold uppercase tracking-[0.12em] sm:text-3xl">
            {player.statusDetail}
            <span className="animate-blink">_</span>
          </p>
        )}
        {forgeShown && !stage && (
          <ForgePreview preview={player.forge} art={player.portraitUrl} color={accent.bg} hex={PLAYER_COLORS.p2} other={PLAYER_COLORS.p1} right={false} />
        )}
        {player.status === 'forging' && (
          <TextButton className="self-start" onClick={() => game.skipForgeWait('p2')}>
            {player.forge?.glbUrl ? 'Fight now' : "Don't wait: fight now"}
          </TextButton>
        )}

        {player.status === 'ready' && (
          <div className="flex flex-col items-start gap-3">
            <p key={phase} className="animate-slam origin-left bg-hp px-4 py-2 font-display text-5xl uppercase tracking-tight text-ink sm:text-6xl">
              {READY_HEADLINE[phase]}
            </p>
            <p className="font-cond text-xl font-bold uppercase tracking-[0.12em] text-paper/70">
              Stay in front of this camera. The fight shows here as soon as it starts.
            </p>
          </div>
        )}

        {player.status === 'ready' && <DeleteCode />}
        {player.status === 'ready' && <MoveGuide inline />}

        {player.status === 'waiting' && player.statusDetail && (
          <p className="self-start border-l-4 border-dmg bg-ink-2 px-4 py-2 font-semibold">{player.statusDetail}</p>
        )}
      </div>
    </div>
  );
}
