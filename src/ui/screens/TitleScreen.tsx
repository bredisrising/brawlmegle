import { useEffect, useState, type FormEvent } from 'react';
import { compareRecords, emptyRecord, fetchRecords, fighterRecords, recentWinRate, totalMatches, winRate, type FighterRecord } from '../../forge/leaderboard';
import { listFighters } from '../../forge/roster';
import type { ForgedFighter } from '../../types';
import { Arrow, ArcadeButton, TextButton } from '../ArcadeButton';
import { useGame } from '../GameContext';
import { HighlightReel } from '../HighlightReel';

/** Host / Connect. The host laptop runs the game; the client laptop joins with a room code. */
export function TitleScreen() {
  const game = useGame();
  const [mode, setMode] = useState<'pick' | 'connect' | 'leaderboard'>('pick');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fighters, setFighters] = useState<ForgedFighter[] | null>(null);
  const [records, setRecords] = useState<Readonly<Record<string, FighterRecord>>>({});

  useEffect(() => {
    if (mode !== 'leaderboard') return;
    let alive = true;
    setFighters(null);
    setRecords(fighterRecords());
    void fetchRecords().then((shared) => alive && setRecords(shared));
    listFighters().then((list) => alive && setFighters(list));
    return () => { alive = false; };
  }, [mode]);

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
  const watchCode = () => {
    if (code.length === 4) run(() => game.watch(code));
  };

  // `?watch=ABCD`: a screen set up to show a room's fight (a TV or a third laptop) goes straight to watching it.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('watch')?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (wanted?.length === 4) {
      setCode(wanted);
      void run(() => game.watch(wanted));
    }
    // Once, on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="tex-hatch pointer-events-auto absolute inset-0 overflow-hidden bg-ink">
      {/* Red / blue slabs: the two corners of the ring. */}
      <div aria-hidden className="animate-wipe-l absolute inset-y-0 right-0 hidden w-[46%] md:block">
        <div className="absolute inset-0 bg-p1" style={{ clipPath: 'polygon(58% 0, 74% 0, 34% 100%, 18% 100%)' }} />
        <div className="absolute inset-0 bg-p2" style={{ clipPath: 'polygon(76% 0, 100% 0, 100% 100%, 36% 100%)' }} />
        <div className="tex-dots absolute inset-0 bg-ink-2" style={{ clipPath: 'polygon(calc(76% + 10px) 0, 100% 0, 100% 100%, calc(36% + 10px) 100%)' }} />
      </div>

      <div className="relative flex h-full flex-col justify-between gap-[clamp(1rem,3.5vh,2.5rem)] overflow-y-auto p-6 sm:px-12 sm:py-[clamp(1.25rem,4.5vh,3rem)]">
        <div className="animate-in-l">
          <h1 className="font-display text-[clamp(3rem,min(10.5vw,15vh),10rem)] uppercase leading-[0.82] tracking-tighter">
            Brawl<span className="text-hp">megle</span>
          </h1>
          <p className="mt-[clamp(0.6rem,2.2vh,1.25rem)] inline-block bg-paper px-3 py-1.5 font-cond text-base font-extrabold uppercase tracking-[0.3em] text-ink sm:text-lg">
            Get scanned. Get forged. Throw hands.
          </p>
        </div>

        <div className="flex flex-1 items-end gap-[clamp(1.5rem,3.5vw,3.5rem)]">
          {/* Recent K.O.s in the free space left of the menu (hidden on phones and when there's no room). */}
          <div className="reel-area hidden min-w-0 flex-1 items-end self-stretch md:flex">
            <HighlightReel paused={mode === 'leaderboard'} />
          </div>
          <div className="flex w-full flex-col items-start gap-5 md:w-md md:shrink-0 md:items-end">
            {mode === 'pick' ? (
              <nav className="flex w-full max-w-md flex-col gap-[clamp(0.3rem,1vh,0.5rem)]">
                <MenuItem index="01" label="Host" hint="Run the fight on this screen" color="hover:bg-p1" bar="bg-p1" disabled={busy} onClick={() => run(() => game.host())} delay={100} />
                <MenuItem index="02" label="Connect" hint="Join with a room code" color="hover:bg-p2" bar="bg-p2" disabled={busy} onClick={() => setMode('connect')} delay={180} />
                <MenuItem index="03" label="Practice" hint="Fight the CPU on this screen" color="hover:bg-hp" bar="bg-hp" disabled={busy} onClick={() => run(() => game.practice())} delay={260} />
                <MenuItem index="04" label="Training" hint="Practice moves on a dummy" color="hover:bg-hp" bar="bg-hp" disabled={busy} onClick={() => run(() => game.practice('dummy'))} delay={340} />
                <MenuItem index="05" label="Leaderboard" hint="See every fighter's record" color="hover:bg-paper" bar="bg-paper" disabled={busy} onClick={() => setMode('leaderboard')} delay={420} />
                {/* Dev tools live on the same site (local dev serves them from /test/). */}
                <p className="mt-[clamp(0.25rem,1.2vh,0.75rem)] flex gap-5 font-cond text-sm font-bold uppercase tracking-[0.25em] text-paper/45">
                  <span>Tools</span>
                  <a className="underline-offset-4 hover:text-paper hover:underline" href={import.meta.env.DEV ? '/test/tuner/' : '/tuner/'}>Move tester</a>
                  <a className="underline-offset-4 hover:text-paper hover:underline" href={import.meta.env.DEV ? '/test/scan/' : '/scan/'}>Scan test</a>
                </p>
              </nav>
            ) : mode === 'connect' ? (
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
                <p className="font-cond text-sm font-semibold uppercase tracking-[0.12em] text-paper/55">
                  Join to play as Player 2. Watch to show the fight on this screen (no camera).
                </p>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <TextButton onClick={() => setMode('pick')}>← Back</TextButton>
                  <div className="flex gap-3">
                    <ArcadeButton type="button" color="bg-paper" disabled={busy || code.length !== 4} onClick={watchCode}>
                      Watch
                    </ArcadeButton>
                    <ArcadeButton type="submit" color="bg-p2" disabled={busy || code.length !== 4}>
                      Join
                    </ArcadeButton>
                  </div>
                </div>
              </form>
            ) : null}
            {error && <p className="border-l-4 border-dmg bg-ink-2 px-3 py-2 font-semibold">{error}</p>}
          </div>
        </div>
      </div>
      {mode === 'leaderboard' && <Leaderboard fighters={fighters} records={records} onBack={() => setMode('pick')} />}
    </div>
  );
}

function Leaderboard({ fighters, records, onBack }: { fighters: ForgedFighter[] | null; records: Readonly<Record<string, FighterRecord>>; onBack: () => void }) {
  const ranked = (fighters ?? []).map((fighter) => ({ fighter, record: records[fighter.id] ?? emptyRecord() }))
    .sort((a, b) => compareRecords(a.record, b.record) || a.fighter.name.localeCompare(b.fighter.name));

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-ink/85 p-3 backdrop-blur-sm sm:p-6">
      <section role="dialog" aria-modal="true" aria-label="Leaderboard" className="animate-rise flex h-[min(760px,calc(100svh-1.5rem))] w-full max-w-4xl flex-col overflow-hidden border-2 border-paper/20 bg-ink shadow-2xl sm:h-[min(760px,calc(100svh-3rem))]">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b-2 border-hp bg-ink-2 p-5 sm:p-7">
          <div className="min-w-0">
            <p className="font-cond text-xs font-bold uppercase tracking-[0.3em] text-hp sm:text-sm">Hall of fame</p>
            <h2 className="mt-1 font-display text-4xl uppercase leading-none tracking-tighter sm:text-7xl">Leader<span className="text-hp">board</span></h2>
          </div>
          <TextButton className="shrink-0 text-base sm:text-lg" onClick={onBack}>← Back</TextButton>
        </div>
        <div className="shrink-0 px-5 pt-4 sm:px-7">
          <p className="font-cond text-xs font-bold uppercase tracking-[0.14em] text-paper/55 sm:text-sm">Ranked by wins · last 7 · career win rate · fights played.</p>
        </div>
        {!fighters ? (
          <p className="grid flex-1 place-items-center px-5 text-center font-cond text-xl font-bold uppercase tracking-[0.2em] text-paper/55">Loading records…</p>
        ) : (
          <div className="mx-5 mt-4 min-h-0 flex-1 overflow-y-auto border-t border-paper/15 sm:mx-7">
            <Podium top={ranked.slice(0, 3)} />
            {ranked.map(({ fighter, record }, index) => (
              <div key={fighter.id} className="grid grid-cols-[2.25rem_3rem_minmax(0,1fr)] items-center gap-2 border-b border-paper/15 py-3 sm:grid-cols-[3.5rem_3.5rem_minmax(0,1fr)_auto_auto_auto] sm:gap-5 sm:px-2">
                <span className={`font-display text-2xl ${index < 3 ? 'text-hp' : 'text-paper/45'} sm:text-3xl`}>#{index + 1}</span>
                <Portrait fighter={fighter} zoom className="h-14 w-12 sm:h-[4.5rem] sm:w-14" />
                <span className="min-w-0">
                  <span className="block truncate font-display text-xl uppercase leading-none tracking-tight sm:text-3xl">{fighter.name}</span>
                  <span className="mt-1 block font-cond text-[0.68rem] font-bold uppercase tracking-[0.1em] text-paper/55 sm:text-xs sm:tracking-[0.15em]">{totalMatches(record)} fights · {record.bestStreak} best streak <span className="sm:hidden">· {record.wins}W / {record.losses}L / {record.draws}D · last 7: {recentWinRate(record)}% · career: {winRate(record)}%</span></span>
                </span>
                <span className="hidden text-right font-cond text-sm font-bold uppercase tracking-[0.12em] text-paper/70 sm:block"><b className="text-hp">{record.wins}W</b> · {record.losses}L · {record.draws}D</span>
                <span className="hidden text-right font-cond text-xs font-bold uppercase tracking-[0.1em] text-paper/70 sm:block"><b className="text-hp">L7</b> {recentWinRate(record)}%</span>
                <span className="hidden font-display text-2xl text-paper sm:block sm:text-3xl">{winRate(record)}%</span>
              </div>
            ))}
            {ranked.length === 0 && <p className="grid h-full place-items-center px-5 text-center font-cond text-xl font-bold uppercase tracking-[0.2em] text-paper/55">No fighters saved yet</p>}
          </div>
        )}
      </section>
    </div>
  );
}

/** A fighter's posed card art (from the forge), cropped to head and shoulders; their initials when there's none. */
function Portrait({ fighter, className = '', zoom = false }: { fighter: ForgedFighter; className?: string; zoom?: boolean }) {
  return (
    <span className={`relative block shrink-0 overflow-hidden bg-ink-3 ${className}`}>
      {fighter.cardUrl ? (
        <img
          src={fighter.cardUrl}
          alt=""
          loading="lazy"
          // zoom: the card's upper part (head and fists), big enough to recognize in a list row.
          className={zoom ? 'absolute left-1/2 top-[4%] h-[230%] w-auto max-w-none -translate-x-1/2' : 'size-full object-cover object-[50%_12%]'}
        />
      ) : (
        <span className="tex-dots grid size-full place-items-center font-display text-xl uppercase text-paper/30">
          {fighter.name.slice(0, 2)}
        </span>
      )}
    </span>
  );
}

/** The top three as big posed cards: #1 in the middle and tallest, like a podium. Hidden on phones (the list has them). */
function Podium({ top }: { top: { fighter: ForgedFighter; record: FighterRecord }[] }) {
  if (top.length < 3 || !top.some(({ fighter }) => fighter.cardUrl)) return null;
  const order = [1, 0, 2];
  return (
    <div className="hidden items-end justify-center gap-4 border-b border-paper/15 px-2 pt-5 pb-4 sm:flex">
      {order.map((i) => {
        const { fighter, record } = top[i];
        const first = i === 0;
        return (
          <div key={fighter.id} className={`animate-rise flex w-[30%] max-w-56 flex-col ${first ? '' : 'pt-6'}`} style={{ animationDelay: `${i * 90}ms` }}>
            <div className={`cut ${first ? 'bg-hp' : 'bg-paper/30'} p-[3px] [--cut:12px]`}>
              <div className={`cut relative overflow-hidden bg-ink-3 [--cut:10px] ${first ? 'aspect-[3/4]' : 'aspect-[4/5]'}`}>
                <Portrait fighter={fighter} className="absolute inset-0 size-full" />
                <span className={`absolute left-0 top-0 px-2.5 py-1 font-display text-xl ${first ? 'bg-hp text-ink' : 'bg-ink text-paper'}`}>#{i + 1}</span>
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink via-ink/80 to-transparent px-3 pt-8 pb-2">
                  <span className="block truncate font-display text-2xl uppercase leading-none tracking-tight">{fighter.name}</span>
                  <span className="mt-1 block font-cond text-xs font-bold uppercase tracking-[0.14em] text-paper/70">
                    <b className="text-hp">{record.wins}W</b> · {record.losses}L · {winRate(record)}%
                  </span>
                </span>
              </div>
            </div>
          </div>
        );
      })}
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
      className={`animate-in-r group relative flex w-full items-center gap-5 bg-ink-3 py-[clamp(0.45rem,1.7vh,1rem)] pr-6 pl-8 text-left transition-[background-color,padding,gap,width] duration-150 hover:w-[calc(100vw-1.5rem)] hover:gap-0 hover:py-[clamp(0.7rem,2.6vh,1.5rem)] hover:pr-6 hover:pl-6 hover:text-ink sm:hover:w-[calc(100%+2rem)] disabled:pointer-events-none disabled:opacity-40 ${color}`}
    >
      <span className={`absolute inset-y-0 left-0 w-2 ${bar} group-hover:bg-ink`} />
      <span className="font-cond text-sm font-bold tracking-[0.3em] text-paper/45 group-hover:hidden">{index}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-[clamp(1.6rem,5vh,3rem)] uppercase leading-none tracking-tight">{label}</span>
        <span className="mt-1 block truncate font-cond text-sm font-semibold uppercase tracking-[0.15em] text-paper/50 group-hover:text-ink/70 [@media(max-height:680px)]:hidden">{hint}</span>
      </span>
      <Arrow className="text-3xl group-hover:hidden" />
    </button>
  );
}
