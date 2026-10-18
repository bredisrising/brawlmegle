import { useEffect, useState } from 'react';
import { ISLAND_OFFSET } from '../director/Arena';
import { EFFECT_KINDS, type EffectKind } from '../director/Effects';
import { useGame } from './GameContext';

const AUTO_INTERVAL_MS = 700;
const OFFSET_RANGE = 4;

/** Secret debug panel: press ` (backquote) to toggle. Spawns hit effects in the middle of the arena and nudges the island. */
export function DebugEffects() {
  const game = useGame();
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState(true);
  const [auto, setAuto] = useState<EffectKind | null>(null);
  const [offset, setOffset] = useState(() => game.renderer.arena.islandOffset);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
      if (e.code === 'Backquote') setOpen((o) => !o);
      else if (e.code === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open || !auto) return;
    const id = setInterval(() => game.debugBurst(auto, impact), AUTO_INTERVAL_MS);
    return () => clearInterval(id);
  }, [game, open, auto, impact]);

  const moveIsland = (z: number) => {
    setOffset(z);
    game.renderer.arena.setIslandOffset(z);
  };

  if (!open) return null;
  return (
    <div className="pointer-events-auto absolute right-3 top-3 w-56 border border-line bg-ink/90 p-3 font-cond text-xs font-semibold uppercase tracking-[0.15em] text-paper/70">
      <div className="mb-2 flex items-center justify-between text-paper">
        <span>Effects</span>
        <span className="text-paper/40">` to close</span>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-1">
        {EFFECT_KINDS.map((kind) => (
          <div key={kind} className="contents">
            <button
              className="border border-line bg-ink-2 px-2 py-1.5 text-left text-paper hover:bg-ink-3"
              onClick={() => game.debugBurst(kind, impact)}
            >
              {kind}
            </button>
            <button
              title="Repeat"
              className={`border border-line px-2 ${auto === kind ? 'bg-hp text-ink' : 'bg-ink-2 hover:bg-ink-3'}`}
              onClick={() => setAuto((a) => (a === kind ? null : kind))}
            >
              ↻
            </button>
          </div>
        ))}
      </div>
      <label className="mt-3 flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={impact} onChange={(e) => setImpact(e.target.checked)} />
        Hit-stop + shake
      </label>

      <div className="mb-2 mt-4 flex items-center justify-between text-paper">
        <span>Arena</span>
        <button className="text-paper/40 hover:text-paper" onClick={() => moveIsland(ISLAND_OFFSET)}>
          Reset
        </button>
      </div>
      <label className="flex flex-col gap-1">
        <span className="flex justify-between">
          <span>Back ← → Forward</span>
          <span className="text-paper">{offset.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min={-OFFSET_RANGE}
          max={OFFSET_RANGE}
          step={0.05}
          value={offset}
          onChange={(e) => moveIsland(Number(e.target.value))}
        />
      </label>
    </div>
  );
}
