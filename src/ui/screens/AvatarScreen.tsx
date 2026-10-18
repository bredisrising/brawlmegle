import { useEffect, useState, type FormEvent } from 'react';
import { findProfile, normalizeUsername } from '../../forge/forge';
import { listFighters } from '../../forge/roster';
import { fighterRecord, totalMatches, winRate } from '../../forge/leaderboard';
import { localPlayerId, useGameStore } from '../../game/store';
import type { ForgedFighter, PlayerId } from '../../types';
import { ACCENT } from '../accent';
import { Arrow, ArcadeButton, TextButton } from '../ArcadeButton';
import { useGame } from '../GameContext';

const NAME_MAX = 24;

type Step = 'choose' | 'name' | 'roster';

const STEP_LABEL: Record<Step, string> = { choose: 'Select', name: 'Username', roster: 'Memory card' };

/** After Host / Connect: scan a new fighter (asks for a name first) or pick a saved one. */
export function AvatarScreen() {
  const [step, setStep] = useState<Step>('choose');
  const role = useGameStore((s) => s.role);
  const roomCode = useGameStore((s) => s.roomCode);
  const player = localPlayerId(role);
  const error = useGameStore((s) => (s.players[player].status === 'waiting' ? s.players[player].statusDetail : ''));
  const accent = ACCENT[player];
  // The second click of a double-click on Host would land on whatever card is under it here: ignore clicks briefly.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className={`tex-hatch absolute inset-0 flex flex-col overflow-hidden bg-ink ${armed ? 'pointer-events-auto' : 'pointer-events-none'}`}>
      {/* Asymmetric backdrop: a raised slab on the right, edged in the player's color. */}
      <div aria-hidden className="animate-wipe-l absolute inset-y-0 right-0 hidden w-[42%] md:block">
        <div className={`absolute inset-0 ${accent.bg}`} style={{ clipPath: 'polygon(22% 0, 100% 0, 100% 100%, 0 100%)' }} />
        <div className="tex-dots absolute inset-0 bg-ink-2" style={{ clipPath: 'polygon(calc(22% + 10px) 0, 100% 0, 100% 100%, 10px 100%)' }} />
      </div>

      <header className="relative flex flex-wrap items-center justify-between gap-4 px-5 pt-5 sm:px-10 sm:pt-8">
        <div className="flex items-center gap-5">
          <span className="font-display text-xl uppercase tracking-tight">Brawlmegle</span>
          <span className="h-6 w-[2px] bg-line" />
          {step === 'choose' ? (
            <>
              {/* Back to the title: a fresh page is the cleanest way to drop the room and the camera. */}
              <TextButton onClick={() => window.location.reload()} className="text-sm">
                ← Title
              </TextButton>
              <span className="font-cond text-sm font-bold uppercase tracking-[0.25em] text-paper/50">01 · {STEP_LABEL.choose}</span>
            </>
          ) : (
            <TextButton onClick={() => setStep('choose')} className="text-sm">
              ← Back
            </TextButton>
          )}
        </div>
        <div className="flex items-stretch font-cond text-sm font-bold uppercase tracking-[0.2em]">
          <span className="slant bg-ink-3 px-4 py-2 text-paper/70 [--slant:8px]">{role === 'client' ? 'Connected' : 'Hosting'}</span>
          <span className="slant -ml-1 bg-paper px-4 py-2 text-ink [--slant:8px]">
            Room <span className="font-display tracking-[0.15em]">{roomCode ?? '----'}</span>
          </span>
          <span className={`slant -ml-1 ${accent.bg} px-4 py-2 font-display tracking-normal text-ink [--slant:8px]`}>{accent.tag}</span>
        </div>
      </header>

      {error && (
        <div className="relative mx-5 mt-4 self-start border-l-4 border-dmg bg-ink-2 px-4 py-2 font-semibold sm:mx-10">{error}</div>
      )}

      <main key={step} className="relative flex min-h-0 flex-1 flex-col px-5 pb-8 sm:px-10 sm:pb-12">
        {step === 'choose' && <ChooseStep player={player} onScan={() => setStep('name')} onExisting={() => setStep('roster')} />}
        {step === 'name' && <NameStep player={player} />}
        {step === 'roster' && <RosterStep player={player} />}
      </main>
    </div>
  );
}

/** Small step label + oversized two-line heading, left-aligned. */
function Heading({ step, top, bottom, accent }: { step: string; top: string; bottom: string; accent: string }) {
  return (
    <div className="animate-in-l">
      <p className="font-cond text-sm font-bold uppercase tracking-[0.3em] text-paper/50">{step}</p>
      <h2 className="mt-2 font-display text-[clamp(3rem,8.5vw,8.5rem)] uppercase leading-[0.86] tracking-tighter">
        {top}
        <br />
        <span className={accent}>{bottom}</span>
      </h2>
    </div>
  );
}

function ChooseStep({ player, onScan, onExisting }: { player: PlayerId; onScan: () => void; onExisting: () => void }) {
  return (
    <div className="flex flex-1 flex-col justify-center gap-10 lg:gap-14">
      <Heading step={`${ACCENT[player].tag} · Step 01`} top="Choose" bottom="your fighter" accent="text-hp" />
      <div className="grid w-full max-w-5xl grid-cols-1 gap-4 sm:grid-cols-[1.3fr_1fr] sm:gap-5">
        <ChoiceCard
          index="01"
          title="Enter"
          body="Type your username. Your fighter comes back, or you get scanned and forged into one."
          fill="hover:bg-hp focus-visible:bg-hp"
          bar="bg-hp"
          onClick={onScan}
          className="animate-rise [animation-delay:120ms]"
        />
        <ChoiceCard
          index="02"
          title="Load fighter"
          body="Pick a fighter saved to the memory card, or a house fighter."
          fill="hover:bg-paper focus-visible:bg-paper"
          bar={ACCENT[player].bg}
          onClick={onExisting}
          className="animate-rise sm:mt-12 [animation-delay:200ms]"
        />
      </div>
    </div>
  );
}

function ChoiceCard(props: { index: string; title: string; body: string; fill: string; bar: string; onClick: () => void; className: string }) {
  const { index, title, body, fill, bar, onClick, className } = props;
  return (
    <button
      onClick={onClick}
      className={`group cut relative flex min-h-56 flex-col justify-between gap-6 bg-ink-3 p-6 text-left outline-none transition-colors duration-150 [--cut:24px] sm:p-8 ${fill} ${className}`}
    >
      <div className="flex w-full items-center justify-between font-cond text-sm font-bold tracking-[0.3em] text-paper/50 group-hover:text-ink/60 group-focus-visible:text-ink/60">
        {index}
        <Arrow className="text-3xl text-paper group-hover:text-ink group-focus-visible:text-ink" />
      </div>
      <div>
        <span className="block font-display text-4xl uppercase leading-[0.9] tracking-tight group-hover:text-ink group-focus-visible:text-ink sm:text-6xl">
          {title}
        </span>
        <span className="mt-3 block max-w-sm text-base font-medium text-paper/65 group-hover:text-ink/75 group-focus-visible:text-ink/75 sm:text-lg">
          {body}
        </span>
      </div>
      <span className={`absolute inset-x-0 bottom-0 h-2 ${bar} group-hover:bg-ink group-focus-visible:bg-ink`} />
    </button>
  );
}

/**
 * Username "log in": as you type, the server is checked for your fighter. Found: fight as it (or rescan).
 * New: the memory-card consent, then a scan, and the fighter is saved under your username on every laptop.
 */
function NameStep({ player }: { player: PlayerId }) {
  const game = useGame();
  const [name, setName] = useState('');
  const username = normalizeUsername(name);
  const trimmed = username ?? '';
  const accent = ACCENT[player];
  // undefined = checking, null = no fighter yet
  const [found, setFound] = useState<ForgedFighter | null | undefined>(null);
  const [rescan, setRescan] = useState(false);

  useEffect(() => {
    setRescan(false);
    if (!username) return setFound(null);
    setFound(undefined);
    let alive = true;
    const timer = setTimeout(() => {
      findProfile(username)
        .then((f) => alive && setFound(f))
        .catch(() => alive && setFound(null));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [username]);

  // Still looking this username up: Enter must not start a (paid) scan for someone who already has a fighter.
  const checking = !!username && found === undefined;

  const scan = (e: FormEvent) => {
    e.preventDefault();
    if (checking) return;
    if (found && !rescan) return game.chooseFighter({ kind: 'existing', fighter: found });
    if (trimmed) game.chooseFighter({ kind: 'scan', name: trimmed, username: trimmed });
  };

  return (
    <form onSubmit={scan} className="grid flex-1 content-center items-end gap-10 lg:grid-cols-[1.4fr_1fr] lg:gap-16">
      <div className="flex flex-col gap-8">
        <Heading step={`${accent.tag} · Step 02`} top="Who's" bottom="fighting?" accent="text-hp" />
        <div className="animate-rise [animation-delay:120ms]">
          <label htmlFor="fighter-name" className="font-cond text-sm font-bold uppercase tracking-[0.3em] text-paper/50">
            Username
          </label>
          <div className={`mt-2 flex items-stretch border-b-[6px] ${accent.border}`}>
            <input
              id="fighter-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, NAME_MAX))}
              placeholder="your_name"
              autoComplete="off"
              className="min-w-0 flex-1 bg-paper px-5 py-4 font-display text-3xl uppercase tracking-tight text-ink caret-dmg outline-none placeholder:text-ink/20 sm:text-5xl"
            />
            <span className="grid w-20 shrink-0 place-items-center bg-ink-3 font-cond text-lg font-bold tabular-nums text-paper/60">
              {name.length}/{NAME_MAX}
            </span>
          </div>
        </div>
      </div>

      {found && !rescan ? (
        <div key={found.id} className="animate-in-r flex flex-col gap-6 border-2 border-paper/15 bg-ink p-6 sm:p-8">
          <div className="flex gap-5">
            {found.cardUrl && <img src={found.cardUrl} alt="" className="aspect-[2/3] w-32 shrink-0 object-cover" />}
            <div>
              <span className="bg-hp px-2 py-1 font-cond text-xs font-extrabold uppercase tracking-[0.25em] text-ink">Welcome back</span>
              <p className="mt-4 font-display text-3xl uppercase leading-[0.95] tracking-tight">{found.name}</p>
              <p className="mt-3 text-paper/65">Your fighter is on the memory card{found.glbUrl ? ', 3D model and all' : ''}.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
            <ArcadeButton type="submit">Fight as {found.name}</ArcadeButton>
            <TextButton onClick={() => setRescan(true)}>Rescan me</TextButton>
          </div>
        </div>
      ) : (
      <div className="animate-in-r flex flex-col gap-6 border-2 border-paper/15 bg-ink p-6 [animation-delay:200ms] sm:p-8">
        <div>
          <span className="bg-hp px-2 py-1 font-cond text-xs font-extrabold uppercase tracking-[0.25em] text-ink">
            {checking ? 'Checking memory card…' : 'Memory card'}
          </span>
          <p className="mt-4 font-display text-3xl uppercase leading-[0.95] tracking-tight">Save fighter to memory card?</p>
          <p className="mt-3 text-paper/65">Your photos go to our AI services to build your fighter and are deleted after the event.</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <ArcadeButton type="submit" disabled={!trimmed || checking}>
            Yes, scan me
          </ArcadeButton>
          <TextButton disabled={!trimmed} onClick={() => game.chooseFighter({ kind: 'masked', name: trimmed })}>
            No, go masked
          </TextButton>
        </div>
      </div>
      )}
    </form>
  );
}

function RosterStep({ player }: { player: PlayerId }) {
  const game = useGame();
  // A connected client shows the host's memory card (sent over P2P); only the host keeps fighters.
  const fromHost = useGameStore((s) => s.role === 'client' && s.connection !== null);
  const hostRoster = useGameStore((s) => s.roster);
  const [localRoster, setLocalRoster] = useState<ForgedFighter[] | null>(null);
  const [focused, setFocused] = useState<ForgedFighter | null>(null);
  const fighters = fromHost ? hostRoster : localRoster;
  const preview = focused ?? fighters?.[0] ?? null;
  const accent = ACCENT[player];

  useEffect(() => {
    if (fromHost) return;
    let alive = true;
    listFighters().then((list) => alive && setLocalRoster(list));
    return () => {
      alive = false;
    };
  }, [fromHost]);

  if (!fighters || fighters.length === 0) {
    return (
      <div className="flex flex-1 flex-col justify-center gap-6">
        <Heading step={`${accent.tag} · Step 02`} top="Memory" bottom="card" accent="text-hp" />
        <p className="font-cond text-xl font-bold uppercase tracking-[0.15em] text-paper/60">
          {fighters ? 'No saved fighters yet. Go back and scan one.' : 'Loading fighters…'}
        </p>
      </div>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 gap-6 pt-6 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:gap-10">
      {/* Big preview of the highlighted fighter, character-select style. */}
      <div className="hidden min-h-0 flex-col md:flex">
        <p className="animate-in-l font-cond text-sm font-bold uppercase tracking-[0.3em] text-paper/50">{accent.tag} · Memory card</p>
        {preview && (
          <div key={preview.id} className="animate-wipe-r relative mt-3 min-h-0 flex-1 overflow-hidden">
            <div className={`cut absolute inset-0 ${accent.bg} [--cut:36px]`}>
              <div className="tex-hatch absolute inset-0" />
              {preview.cardUrl ? (
                <img src={preview.cardUrl} alt="" className="absolute inset-0 size-full object-cover" />
              ) : (
                <span className="absolute inset-0 grid place-items-center font-display text-[clamp(8rem,20vw,20rem)] leading-none tracking-tighter text-ink/20">
                  {initials(preview.name)}
                </span>
              )}
            </div>
            <div className="animate-in-l absolute inset-x-0 bottom-0 flex flex-col items-start gap-2 p-6 [animation-delay:100ms]">
              {preview.glbUrl && (
                <span className="bg-ink px-2 py-1 font-cond text-xs font-extrabold uppercase tracking-[0.25em] text-hp">3D model</span>
              )}
              <span className="max-w-full break-words bg-ink px-4 py-2 font-display text-4xl uppercase leading-[0.95] tracking-tight lg:text-6xl">
                {preview.name}
              </span>
              <Leaderboard fighter={preview} expanded />
            </div>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-col gap-4">
        <div className="flex items-end justify-between gap-4">
          <h2 className="animate-in-r font-display text-4xl uppercase leading-none tracking-tighter sm:text-6xl">
            Select <span className="text-hp">fighter</span>
          </h2>
          <span className="whitespace-nowrap font-cond text-sm font-bold uppercase tracking-[0.25em] text-paper/50">
            {fighters.length} fighters
          </span>
        </div>
        <div className="grid min-h-0 grid-cols-2 content-start gap-2 overflow-y-auto pr-1 sm:grid-cols-3 lg:grid-cols-4">
          {fighters.map((f, i) => (
            <RosterTile
              key={f.id}
              fighter={f}
              selected={preview?.id === f.id}
              accent={accent.bg}
              delay={i * 40}
              onFocus={() => setFocused(f)}
              onPick={() => game.chooseFighter({ kind: 'existing', fighter: f })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RosterTile(props: { fighter: ForgedFighter; selected: boolean; accent: string; delay: number; onFocus: () => void; onPick: () => void }) {
  const { fighter, selected, accent, delay, onFocus, onPick } = props;
  const record = fighterRecord(fighter.id);
  return (
    <button
      data-fighter={fighter.id}
      onClick={onPick}
      onMouseEnter={onFocus}
      onFocus={onFocus}
      style={{ animationDelay: `${delay}ms` }}
      className={`animate-rise group relative flex aspect-[3/4] flex-col overflow-hidden border-4 bg-ink-3 text-left outline-none transition-[border-color] duration-100 ${
        selected ? 'border-paper' : 'border-transparent hover:border-paper/40'
      }`}
    >
      <div className="relative flex-1 overflow-hidden">
        {fighter.cardUrl ? (
          <img src={fighter.cardUrl} alt="" className="size-full object-cover" />
        ) : (
          <Initials name={fighter.name} selected={selected} />
        )}
      </div>
      <span className={`truncate px-3 py-2 font-display text-base uppercase tracking-tight sm:text-lg ${selected ? `${accent} text-ink` : 'bg-ink'}`}>
        {fighter.name}
      </span>
      <span className="bg-ink-2 px-3 py-1 font-cond text-xs font-bold uppercase tracking-[0.14em] text-paper/65">
        {record.wins}W · {record.losses}L · {winRate(record)}% WR
      </span>
      {selected && (
        <span className={`absolute right-0 top-0 ${accent} px-2 py-1 font-cond text-xs font-extrabold uppercase tracking-[0.2em] text-ink`}>
          Pick
        </span>
      )}
    </button>
  );
}

function Leaderboard({ fighter, expanded = false }: { fighter: ForgedFighter; expanded?: boolean }) {
  const record = fighterRecord(fighter.id);
  const matches = totalMatches(record);
  return (
    <div className={`border-l-4 border-hp bg-ink/90 px-4 py-3 text-paper ${expanded ? 'animate-rise [animation-delay:180ms]' : ''}`}>
      <p className="font-cond text-xs font-extrabold uppercase tracking-[0.25em] text-hp">Career leaderboard</p>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-cond font-bold uppercase tracking-[0.13em]">
        <span><b className="text-hp">{winRate(record)}%</b> win rate</span>
        <span><b>{record.wins}</b> wins</span>
        <span><b>{record.losses}</b> losses</span>
        <span><b>{record.draws}</b> draws</span>
        <span><b>{matches}</b> fights</span>
        <span><b>{record.bestStreak}</b> best streak</span>
      </div>
    </div>
  );
}

function Initials({ name, selected }: { name: string; selected: boolean }) {
  return (
    <span className={`tex-dots grid size-full place-items-center font-display text-6xl ${selected ? 'text-paper' : 'text-paper/20'}`}>
      {initials(name)}
    </span>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
