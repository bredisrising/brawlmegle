import { useState, type FormEvent } from 'react';
import { ArcadeButton } from '../ArcadeButton';
import { useGame } from '../GameContext';

/** Host / Connect. The host laptop runs the game; the client laptop joins with a room code. */
export function TitleScreen() {
  const game = useGame();
  const [mode, setMode] = useState<'pick' | 'connect'>('pick');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      console.error(err);
      setError('Could not connect. Check the code and try again.');
      setBusy(false);
    }
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (code.length === 4) run(() => game.join(code));
  };

  return (
    <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-12 bg-gradient-to-b from-arena/60 via-arena/80 to-arena px-4">
      <div className="text-center">
        <h1 className="font-display text-outline -rotate-3 text-7xl leading-none text-hp sm:text-9xl">Brawlegle</h1>
        <p className="mt-4 text-lg font-semibold uppercase tracking-[0.35em] text-white/70">
          Get scanned. Get forged. Throw hands.
        </p>
      </div>

      {mode === 'pick' ? (
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:gap-10">
          <ArcadeButton size="lg" color="bg-p1" disabled={busy} onClick={() => run(() => game.host())}>
            Host
          </ArcadeButton>
          <ArcadeButton size="lg" color="bg-p2" disabled={busy} onClick={() => setMode('connect')}>
            Connect
          </ArcadeButton>
        </div>
      ) : (
        <form onSubmit={submitCode} className="flex flex-col items-center gap-5">
          <label htmlFor="room-code" className="text-lg font-semibold uppercase tracking-widest text-white/70">
            Room code from the host screen
          </label>
          <input
            id="room-code"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
            placeholder="ABCD"
            autoComplete="off"
            className="w-64 border-4 border-black bg-white/95 py-3 text-center font-display text-6xl tracking-[0.3em] text-black shadow-[6px_6px_0_black] outline-none placeholder:text-black/20 focus:border-p2"
          />
          <div className="flex items-center gap-6">
            <button type="button" onClick={() => setMode('pick')} className="font-semibold uppercase tracking-widest text-white/60 hover:text-white">
              Back
            </button>
            <ArcadeButton type="submit" color="bg-p2" disabled={busy || code.length !== 4}>
              Join
            </ArcadeButton>
          </div>
        </form>
      )}

      {error && <p className="font-semibold text-red-300">{error}</p>}
    </div>
  );
}
