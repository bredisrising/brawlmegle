import { useGameStore } from '../game/store';

/** Commentator captions, bottom center, always on (the voices can be muted with M). */
export function Captions() {
  const caption = useGameStore((s) => s.caption);
  const walkout = useGameStore((s) => s.walkout);
  if (!caption || walkout) return null;
  const a = caption.voice === 'A';
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[9%] flex justify-center px-4">
      <div key={caption.key} className="animate-rise flex max-w-3xl items-stretch">
        <span className={`slant grid place-items-center px-2.5 font-display text-sm text-ink [--slant:8px] ${a ? 'bg-hp' : 'bg-paper'}`}>
          {a ? 'PLAY' : 'COLOR'}
        </span>
        <span className="slant -ml-1 bg-ink/90 px-4 py-2 font-cond text-lg font-bold uppercase leading-snug tracking-[0.06em] text-paper [--slant:8px] sm:text-2xl">
          {caption.text}
        </span>
      </div>
    </div>
  );
}
