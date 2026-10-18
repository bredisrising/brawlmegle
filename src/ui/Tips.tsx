import { useEffect, useState } from 'react';

/**
 * How to get read well, while players wait (searching, the lobby, the K.O. screen). The camera reads big, clear
 * moves; people's first instinct is fast little flurries, so that tip comes first and comes back every other time.
 */
const MAIN = "Don't rush: make every move big and clear, then come back to your guard. Fast little punches get missed.";
const OTHERS = [
  'Exaggerate it: a full swing reads better than a flick of the wrist.',
  'One punch at a time. Let each one finish before the next.',
  'Block: both fists up by your face, and hold them there.',
  'Dodge: lean your head and shoulders to one side, quickly.',
  'A kick or a knee breaks a block. Punches beat a kick.',
  'Keep your head, shoulders and hands in the shot.',
  'Light on your face, not behind you, and the camera sees you better.',
];
const tipAt = (i: number) => (i % 2 === 0 ? MAIN : OTHERS[(i >> 1) % OTHERS.length]);

export function Tips({ className = '', align = 'center', width = 'max-w-xl' }: { className?: string; align?: 'start' | 'center' | 'end'; width?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => n + 1), 7000);
    return () => clearInterval(t);
  }, []);
  const justify = align === 'start' ? 'justify-start text-left' : align === 'end' ? 'justify-end text-right' : 'justify-center text-center';
  return (
    <p className={`flex ${width} items-start gap-3 ${justify} ${className}`}>
      <span className="shrink-0 bg-hp px-2 py-0.5 font-display text-base uppercase tracking-tight text-ink sm:text-lg">Tip</span>
      <span key={i} className="animate-rise font-cond text-base font-bold uppercase leading-snug tracking-[0.08em] text-paper sm:text-lg">
        {tipAt(i)}
      </span>
    </p>
  );
}
