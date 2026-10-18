import { useGameStore } from '../game/store';
import { TextButton } from './ArcadeButton';

/**
 * After a forge: the fighter's delete code, big enough to screenshot, until "Got it". The forge hands it out once;
 * it deletes the fighter from any laptop (Leaders, or the memory card: "Delete a fighter with a code").
 */
export function DeleteCode({ className = '' }: { className?: string }) {
  const code = useGameStore((s) => s.deleteCode);
  if (!code) return null;
  return (
    <div data-testid="delete-code" className={`animate-rise pointer-events-auto flex max-w-md flex-col gap-1.5 border-l-4 border-hp bg-ink/95 px-4 py-3 text-left ${className}`}>
      <p className="font-cond text-xs font-extrabold uppercase tracking-[0.25em] text-hp">
        Your delete code{code.name ? ` · ${code.name}` : ''}
      </p>
      <p className="select-text whitespace-nowrap font-display text-2xl tracking-[0.06em] text-paper sm:text-3xl">{code.code}</p>
      <p className="text-sm font-medium text-paper/65">
        Screenshot it. It deletes your scan photos and fighter for good, from any laptop (Leaders, then "Delete a fighter
        with a code").
      </p>
      <TextButton className="mt-1 self-start text-sm" onClick={() => useGameStore.setState({ deleteCode: null })}>
        Got it
      </TextButton>
    </div>
  );
}
