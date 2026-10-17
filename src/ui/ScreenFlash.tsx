import { useGameStore } from '../game/store';

/** Brief white flash on heavy hits. */
export function ScreenFlash() {
  const flashKey = useGameStore((s) => s.flashKey);
  if (!flashKey) return null;
  return <div key={flashKey} className="animate-flash absolute inset-0 bg-white" />;
}
