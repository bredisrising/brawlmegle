import { useGameStore } from '../game/store';
import { TextButton } from './ArcadeButton';

/**
 * After a forge: the fighter's delete code, to screenshot, until "Got it". The forge hands it out once; it deletes the
 * fighter from any laptop (Leaders, or the memory card: "Delete a fighter with a code").
 *   row: one line (the lobby's bottom strip, the K.O. screen in place of the tips);
 *   card: stacked (the client laptop's screen).
 */
export function DeleteCode({ layout = 'card' }: { layout?: 'row' | 'card' }) {
  const code = useGameStore((s) => s.deleteCode);
  if (!code) return null;
  const row = layout === 'row';
  return (
    <div
      data-testid="delete-code"
      className={`animate-rise pointer-events-auto flex border-l-4 border-hp bg-ink/95 px-4 py-2.5 text-left shadow-2xl ${
        row ? 'max-w-3xl flex-wrap items-center gap-x-5 gap-y-1' : 'max-w-md flex-col items-start gap-1.5'
      }`}
    >
      <span className="flex flex-col">
        <span className="font-cond text-xs font-extrabold uppercase tracking-[0.25em] text-hp">
          Your delete code{code.name ? ` · ${code.name}` : ''}
        </span>
        <span className="select-text whitespace-nowrap font-display text-2xl tracking-[0.06em] text-paper">{code.code}</span>
      </span>
      <span className={`text-sm font-medium leading-snug text-paper/70 ${row ? 'min-w-48 max-w-[17rem] flex-1' : ''}`}>
        Screenshot it: it deletes your scan photos and fighter for good, from any laptop (Leaders).
      </span>
      <TextButton className="text-sm" onClick={() => useGameStore.setState({ deleteCode: null })}>
        Got it
      </TextButton>
    </div>
  );
}

/** The lobby (after a forge, before the fight): the code along the bottom, clear of the player panels. */
export function DeleteCodeStrip() {
  const lobby = useGameStore((s) => s.phase === 'lobby' && !s.walkout);
  if (!lobby) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-4 sm:bottom-4">
      <DeleteCode layout="row" />
    </div>
  );
}
