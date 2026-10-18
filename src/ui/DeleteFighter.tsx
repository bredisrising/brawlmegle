import { useState, type FormEvent, type ReactNode } from 'react';
import { deleteFighter, formatDeleteCode, isDeleteCode, type DeleteResult } from '../forge/forge';
import { forgetFighter, ownedFighters, type OwnedFighter } from '../forge/roster';
import type { ForgedFighter } from '../types';
import { ArcadeButton, TextButton } from './ArcadeButton';

/**
 * "Delete my fighter", no logins: a fighter scanned in this browser can be deleted with the owner key kept here
 * (MyFighters, on the memory card), any fighter with the delete code shown after its forge (DeleteWithCode). Both
 * ask twice. Deleting removes the scan photos, the design, the 3D model, the record and its highlights on the server.
 */

const WARNING = 'This deletes your scan photos and 3D fighter for good.';

/** The second step: say what happens, then do it. */
function Confirm({ busy, onYes, onNo }: { busy: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="font-semibold text-paper">{WARNING}</p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <ArcadeButton type="button" color="bg-dmg" disabled={busy} onClick={onYes} autoFocus>
          {busy ? 'Deleting…' : 'Delete for good'}
        </ArcadeButton>
        <TextButton disabled={busy} onClick={onNo}>
          Keep it
        </TextButton>
      </div>
    </div>
  );
}

const Note = ({ tone, children }: { tone: 'ok' | 'error'; children: ReactNode }) => (
  <p role="status" className={`border-l-4 ${tone === 'ok' ? 'border-hp' : 'border-dmg'} bg-ink-2 px-3 py-2 text-sm font-semibold`}>
    {children}
  </p>
);

/** After a delete answered: gone (now or already) means this browser forgets the fighter too. */
function settle(result: DeleteResult, id: string | undefined, onDeleted: (id: string) => void) {
  const goneId = result.ok ? result.id || id : result.gone ? id : undefined;
  if (goneId) {
    forgetFighter(goneId);
    onDeleted(goneId);
  }
}

/**
 * The memory card's footer: the fighters this browser scanned (it holds their owner keys), each with a Delete
 * button. Older scans the card no longer shows (a rescan replaced them) are here too: their photos are still kept.
 */
export function MyFighters({ fighters, onDeleted }: { fighters: ForgedFighter[]; onDeleted: (id: string) => void }) {
  const [owned, setOwned] = useState<OwnedFighter[]>(() => ownedFighters());
  const [done, setDone] = useState('');
  if (owned.length === 0 && !done) return null;
  const deleted = (id: string, name: string, already: boolean) => {
    setOwned((list) => list.filter((o) => o.id !== id));
    setDone(already ? `${name || 'That fighter'} was already deleted.` : `Deleted ${name || 'your fighter'} for good.`);
    onDeleted(id);
  };
  return (
    <section aria-label="Your fighters" className="shrink-0 border-t-2 border-paper/15 pt-3">
      <p className="font-cond text-xs font-extrabold uppercase tracking-[0.25em] text-paper/50">Scanned in this browser</p>
      <ul className="mt-2 flex max-h-[min(14rem,28vh)] flex-col gap-2 overflow-y-auto pr-1">
        {owned.map((o) => (
          <OwnedRow key={o.id} owned={o} fighter={fighters.find((f) => f.id === o.id)} onDeleted={deleted} />
        ))}
      </ul>
      {done && <div className="mt-2"><Note tone="ok">{done}</Note></div>}
    </section>
  );
}

function OwnedRow({ owned, fighter, onDeleted }: { owned: OwnedFighter; fighter?: ForgedFighter; onDeleted: (id: string, name: string, already: boolean) => void }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [error, setError] = useState('');
  const name = fighter?.name ?? owned.name;

  const remove = async () => {
    setStep('busy');
    setError('');
    const result = await deleteFighter({ id: owned.id, key: owned.key });
    settle(result, owned.id, (id) => onDeleted(id, name, !result.ok));
    if (!result.ok && !result.gone) {
      setError(result.error);
      setStep('confirm');
    }
  };

  return (
    <li data-owned={owned.id} className="flex flex-col gap-3 bg-ink-2 p-3">
      <div className="flex items-center gap-3">
        <span className="relative block h-14 w-11 shrink-0 overflow-hidden bg-ink-3">
          {fighter?.cardUrl ? (
            <img src={fighter.cardUrl} alt="" className="size-full object-cover object-[50%_8%]" />
          ) : (
            <span className="tex-dots grid size-full place-items-center font-display text-lg uppercase text-paper/30">{name.slice(0, 2)}</span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-xl uppercase leading-none tracking-tight">{name || 'Your fighter'}</span>
          <span className="mt-1 block font-cond text-xs font-bold uppercase tracking-[0.14em] text-paper/55">
            {fighter ? 'On the memory card' : 'An earlier scan, off the card'}
          </span>
        </span>
        {step === 'idle' && (
          <TextButton className="shrink-0 text-sm hover:!border-dmg" onClick={() => setStep('confirm')}>
            Delete my fighter
          </TextButton>
        )}
      </div>
      {step !== 'idle' && <Confirm busy={step === 'busy'} onYes={() => void remove()} onNo={() => (setStep('idle'), setError(''))} />}
      {error && <Note tone="error">{error}</Note>}
    </li>
  );
}

/**
 * "Delete a fighter with a code": the code shown after the forge, for another laptop or a cleared browser. A small
 * link until it's opened.
 */
export function DeleteWithCode({ onDeleted, className = '' }: { onDeleted?: (id: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'enter' | 'confirm' | 'busy'>('enter');
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  if (!open) {
    return (
      <div className={className}>
        <TextButton className="text-sm" onClick={() => setOpen(true)}>
          Delete a fighter with a code
        </TextButton>
        {note && <div className="mt-2"><Note tone={note.tone}>{note.text}</Note></div>}
      </div>
    );
  }

  const close = () => {
    setOpen(false);
    setCode('');
    setStep('enter');
    setNote(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (isDeleteCode(code)) setStep('confirm');
  };
  const remove = async () => {
    setStep('busy');
    setNote(null);
    const result = await deleteFighter({ code });
    settle(result, undefined, (id) => onDeleted?.(id));
    if (result.ok) {
      setOpen(false);
      setCode('');
      setStep('enter');
      setNote({ tone: 'ok', text: `Deleted ${result.name || 'that fighter'} for good.` });
    } else {
      setStep('enter');
      setNote({ tone: 'error', text: result.error });
    }
  };

  return (
    <form onSubmit={submit} className={`flex flex-col gap-3 border-2 border-paper/15 bg-ink p-4 ${className}`}>
      <label htmlFor="delete-code" className="font-cond text-xs font-extrabold uppercase tracking-[0.25em] text-paper/60">
        The delete code from after your scan
      </label>
      <input
        id="delete-code"
        autoFocus
        value={code}
        disabled={step !== 'enter'}
        onChange={(e) => setCode(formatDeleteCode(e.target.value))}
        placeholder="XXXX-XXXX-XXXX-XXXX"
        autoComplete="off"
        spellCheck={false}
        className="w-full select-text border-b-[6px] border-dmg bg-paper px-3 py-2 text-center font-display text-2xl tracking-[0.08em] text-ink caret-dmg outline-none placeholder:text-ink/20 disabled:opacity-60 sm:text-3xl"
      />
      {step === 'enter' ? (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <TextButton onClick={close}>Cancel</TextButton>
          <ArcadeButton type="submit" color="bg-dmg" disabled={!isDeleteCode(code)}>
            Delete
          </ArcadeButton>
        </div>
      ) : (
        <Confirm busy={step === 'busy'} onYes={() => void remove()} onNo={() => setStep('enter')} />
      )}
      {note && <Note tone={note.tone}>{note.text}</Note>}
    </form>
  );
}
