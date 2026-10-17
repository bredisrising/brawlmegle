export function DebugHint() {
  if (!import.meta.env.DEV) return null;
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap border border-line bg-ink px-3 py-1 font-cond text-xs font-semibold uppercase tracking-[0.15em] text-paper/50">
      Dev · <span className="text-paper">1 / 2</span> hit P1 / P2 · hold <span className="text-paper">Shift</span> for a counter
    </div>
  );
}
