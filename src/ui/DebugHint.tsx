export function DebugHint() {
  if (!import.meta.env.DEV) return null;
  return (
    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/50 px-3 py-1 text-xs font-semibold tracking-wide text-white/50">
      DEV · press 1 / 2 to hit P1 / P2 · hold Shift for a heavy hit
    </div>
  );
}
