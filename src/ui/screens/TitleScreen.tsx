import { useState, type FormEvent } from 'react';
import { Arrow, ArcadeButton, TextButton } from '../ArcadeButton';
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
    <div className="tex-hatch pointer-events-auto absolute inset-0 overflow-hidden bg-ink">
      {/* Red / blue slabs: the two corners of the ring. */}
      <div aria-hidden className="animate-wipe-l absolute inset-y-0 right-0 hidden w-[46%] md:block">
        <div className="absolute inset-0 bg-p1" style={{ clipPath: 'polygon(58% 0, 74% 0, 34% 100%, 18% 100%)' }} />
        <div className="absolute inset-0 bg-p2" style={{ clipPath: 'polygon(76% 0, 100% 0, 100% 100%, 36% 100%)' }} />
        <div className="tex-dots absolute inset-0 bg-ink-2" style={{ clipPath: 'polygon(calc(76% + 10px) 0, 100% 0, 100% 100%, calc(36% + 10px) 100%)' }} />
      </div>

      <div className="relative flex h-full flex-col justify-between gap-10 p-6 sm:p-12">
        <div className="animate-in-l">
          <h1 className="font-display text-[clamp(3.5rem,10.5vw,10rem)] uppercase leading-[0.82] tracking-tighter">
            Brawl<span className="text-hp">egle</span>
          </h1>
          <p className="mt-5 inline-block bg-paper px-3 py-1.5 font-cond text-base font-extrabold uppercase tracking-[0.3em] text-ink sm:text-lg">
            Get scanned. Get forged. Throw hands.
          </p>
        </div>

        <div className="flex flex-col items-start gap-5 md:items-end">
          {mode === 'pick' ? (
            <nav className="flex w-full max-w-md flex-col gap-2">
              <MenuItem index="01" label="Host" hint="Run the fight on this screen" color="hover:bg-p1" bar="bg-p1" disabled={busy} onClick={() => run(() => game.host())} delay={100} />
              <MenuItem index="02" label="Connect" hint="Join with a room code" color="hover:bg-p2" bar="bg-p2" disabled={busy} onClick={() => setMode('connect')} delay={180} />
              <MenuItem index="03" label="Practice" hint="Fight the CPU on this screen" color="hover:bg-hp" bar="bg-hp" disabled={busy} onClick={() => run(() => game.practice())} delay={260} />
              {/* Dev tools live on the same site (local dev serves them from /test/). */}
              <p className="mt-3 flex gap-5 font-cond text-sm font-bold uppercase tracking-[0.25em] text-paper/45">
                <span>Tools</span>
                <a className="underline-offset-4 hover:text-paper hover:underline" href={import.meta.env.DEV ? '/test/tuner/' : '/tuner/'}>Move tester</a>
                <a className="underline-offset-4 hover:text-paper hover:underline" href={import.meta.env.DEV ? '/test/scan/' : '/scan/'}>Scan test</a>
              </p>
            </nav>
          ) : (
            <form onSubmit={submitCode} className="animate-rise flex w-full max-w-md flex-col gap-4 border-2 border-paper/15 bg-ink p-6">
              <label htmlFor="room-code" className="font-cond text-sm font-bold uppercase tracking-[0.3em] text-paper/60">
                Room code from the host screen
              </label>
              <input
                id="room-code"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                placeholder="ABCD"
                autoComplete="off"
                className="w-full border-b-[6px] border-p2 bg-paper py-3 text-center font-display text-6xl tracking-[0.3em] text-ink caret-dmg outline-none placeholder:text-ink/15"
              />
              <div className="flex items-center justify-between gap-6">
                <TextButton onClick={() => setMode('pick')}>← Back</TextButton>
                <ArcadeButton type="submit" color="bg-p2" disabled={busy || code.length !== 4}>
                  Join
                </ArcadeButton>
              </div>
            </form>
          )}
          {error && <p className="border-l-4 border-dmg bg-ink-2 px-3 py-2 font-semibold">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function MenuItem(props: { index: string; label: string; hint: string; color: string; bar: string; disabled: boolean; onClick: () => void; delay: number }) {
  const { index, label, hint, color, bar, disabled, onClick, delay } = props;
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{ animationDelay: `${delay}ms` }}
      className={`animate-in-r group relative flex items-center gap-5 bg-ink-3 py-4 pr-6 pl-8 text-left transition-colors duration-150 ${color} hover:text-ink disabled:pointer-events-none disabled:opacity-40`}
    >
      <span className={`absolute inset-y-0 left-0 w-2 ${bar} group-hover:bg-ink`} />
      <span className="font-cond text-sm font-bold tracking-[0.3em] text-paper/45 group-hover:text-ink/60">{index}</span>
      <span className="flex-1">
        <span className="block font-display text-4xl uppercase leading-none tracking-tight sm:text-5xl">{label}</span>
        <span className="mt-1 block font-cond text-sm font-semibold uppercase tracking-[0.15em] text-paper/50 group-hover:text-ink/70">{hint}</span>
      </span>
      <Arrow className="text-3xl" />
    </button>
  );
}
