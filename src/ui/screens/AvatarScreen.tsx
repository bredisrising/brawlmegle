import { useEffect, useState, type FormEvent } from 'react';
import { listFighters } from '../../forge/roster';
import { localPlayerId, useGameStore } from '../../game/store';
import type { ForgedFighter } from '../../types';
import { ArcadeButton } from '../ArcadeButton';
import { useGame } from '../GameContext';

const NAME_MAX = 16;

type Step = 'choose' | 'name' | 'roster';

/** After Host / Connect: scan a new fighter (asks for a name first) or pick a saved one. */
export function AvatarScreen() {
  const [step, setStep] = useState<Step>('choose');
  const role = useGameStore((s) => s.role);
  const roomCode = useGameStore((s) => s.roomCode);
  const player = localPlayerId(role);
  const accent = player === 'p2' ? 'text-p2' : 'text-p1';

  return (
    <div className="pointer-events-auto absolute inset-0 flex flex-col bg-arena/85 px-4 py-6 backdrop-blur-sm sm:px-10">
      <header className="flex items-center justify-between gap-4">
        {step === 'choose' ? (
          <span />
        ) : (
          <button onClick={() => setStep('choose')} className="font-semibold uppercase tracking-widest text-white/60 hover:text-white">
            ← Back
          </button>
        )}
        <div className="rounded border border-white/15 bg-black/40 px-3 py-1 text-sm font-semibold uppercase tracking-widest text-white/70">
          {role === 'client' ? 'Connected' : 'Hosting'} · Room <span className="text-white">{roomCode ?? '····'}</span> ·{' '}
          <span className={accent}>{player === 'p2' ? 'Player 2' : 'Player 1'}</span>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-10">
        {step === 'choose' && <ChooseStep onScan={() => setStep('name')} onExisting={() => setStep('roster')} />}
        {step === 'name' && <NameStep />}
        {step === 'roster' && <RosterStep />}
      </main>
    </div>
  );
}

function ChooseStep({ onScan, onExisting }: { onScan: () => void; onExisting: () => void }) {
  return (
    <>
      <h2 className="font-display text-outline text-center text-6xl text-white sm:text-7xl">Pick your fighter</h2>
      <div className="grid w-full max-w-3xl grid-cols-1 gap-6 sm:grid-cols-2">
        <ChoiceCard
          title="Scan new"
          body="Turn 360° in front of the camera and get forged into a fighter."
          accent="border-hp hover:bg-hp/10"
          onClick={onScan}
        />
        <ChoiceCard
          title="Choose existing"
          body="Pick a fighter saved to the memory card, or a house fighter."
          accent="border-p2 hover:bg-p2/10"
          onClick={onExisting}
        />
      </div>
    </>
  );
}

function ChoiceCard({ title, body, accent, onClick }: { title: string; body: string; accent: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`group flex flex-col gap-3 border-4 ${accent} bg-black/50 p-8 text-left shadow-[8px_8px_0_black] transition hover:-translate-y-1`}
    >
      <span className="font-display text-5xl tracking-wide text-white">{title}</span>
      <span className="text-lg font-medium text-white/70">{body}</span>
    </button>
  );
}

function NameStep() {
  const game = useGame();
  const [name, setName] = useState('');
  const trimmed = name.trim();

  const scan = (e: FormEvent) => {
    e.preventDefault();
    if (trimmed) game.chooseFighter({ kind: 'scan', name: trimmed });
  };

  return (
    <form onSubmit={scan} className="flex w-full max-w-xl flex-col items-center gap-8">
      <label htmlFor="fighter-name" className="font-display text-outline text-center text-5xl text-white sm:text-6xl">
        Enter your fighter name
      </label>
      <div className="w-full">
        <input
          id="fighter-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
          placeholder="Kid Haymaker"
          autoComplete="off"
          className="w-full border-4 border-black bg-white/95 px-4 py-3 text-center font-display text-5xl tracking-wide text-black shadow-[6px_6px_0_black] outline-none placeholder:text-black/20 focus:border-hp"
        />
        <p className="mt-2 text-right text-sm font-semibold text-white/40">
          {name.length}/{NAME_MAX}
        </p>
      </div>

      <div className="border-2 border-white/15 bg-black/40 p-4 text-center">
        <p className="font-display text-2xl tracking-wide text-hp">Save fighter to memory card?</p>
        <p className="mt-1 text-white/70">
          Your photos go to our AI services to build your fighter and are deleted after the event.
        </p>
      </div>

      <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-8">
        <ArcadeButton type="submit" disabled={!trimmed}>
          Yes, scan me
        </ArcadeButton>
        <button
          type="button"
          disabled={!trimmed}
          onClick={() => game.chooseFighter({ kind: 'masked', name: trimmed })}
          className="font-semibold uppercase tracking-widest text-white/60 hover:text-white disabled:opacity-30"
        >
          No, go masked
        </button>
      </div>
    </form>
  );
}

function RosterStep() {
  const game = useGame();
  const [fighters, setFighters] = useState<ForgedFighter[] | null>(null);

  useEffect(() => {
    let alive = true;
    listFighters().then((list) => alive && setFighters(list));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <h2 className="font-display text-outline text-center text-6xl text-white">Memory card</h2>
      {!fighters && <p className="text-white/60">Loading fighters…</p>}
      {fighters?.length === 0 && <p className="text-white/60">No saved fighters yet. Go back and scan one.</p>}
      {fighters && fighters.length > 0 && (
        <div className="grid w-full max-w-4xl grid-cols-2 gap-5 overflow-y-auto p-2 sm:grid-cols-3 lg:grid-cols-4">
          {fighters.map((f) => (
            <button
              key={f.id}
              onClick={() => game.chooseFighter({ kind: 'existing', fighter: f })}
              className="group flex flex-col border-4 border-white/20 bg-black/50 shadow-[6px_6px_0_black] transition hover:-translate-y-1 hover:border-hp"
            >
              <div className="grid aspect-[3/4] place-items-center overflow-hidden bg-gradient-to-b from-white/10 to-transparent">
                {f.cardUrl ? (
                  <img src={f.cardUrl} alt="" className="size-full object-cover" />
                ) : (
                  <span className="font-display text-7xl text-white/30 group-hover:text-hp">{initials(f.name)}</span>
                )}
              </div>
              <span className="truncate px-2 py-2 font-display text-2xl tracking-wide text-white">{f.name}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
