import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Tailwind background class, e.g. "bg-p1". */
  color?: string;
  size?: 'md' | 'lg';
};

/** Chunky skewed button with a hard drop shadow. */
export function ArcadeButton({ color = 'bg-hp', size = 'md', className = '', children, ...rest }: Props) {
  const sizing = size === 'lg' ? 'px-10 py-4 text-4xl' : 'px-8 py-3 text-3xl';
  return (
    <button
      {...rest}
      className={`pointer-events-auto -skew-x-12 ${color} ${sizing} font-display tracking-wider text-black shadow-[6px_6px_0_black] transition hover:scale-105 active:translate-x-1 active:translate-y-1 active:shadow-none disabled:pointer-events-none disabled:opacity-40 ${className}`}
    >
      <span className="inline-block skew-x-12">{children}</span>
    </button>
  );
}
