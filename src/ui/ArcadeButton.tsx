import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Tailwind background class, e.g. "bg-p1". */
  color?: string;
  size?: 'md' | 'lg';
};

/** Flat notched-corner button. Hover flips it to paper and kicks the arrow forward. */
export function ArcadeButton({ color = 'bg-hp', size = 'md', className = '', children, ...rest }: Props) {
  const sizing = size === 'lg' ? 'gap-4 px-9 py-5 text-3xl' : 'gap-3 px-7 py-4 text-xl';
  return (
    <button
      {...rest}
      className={`group cut pointer-events-auto inline-flex items-center justify-between ${color} ${sizing} font-display uppercase leading-none tracking-tight text-ink transition-[background-color,transform] duration-150 hover:bg-paper active:translate-y-0.5 disabled:pointer-events-none disabled:opacity-35 ${className}`}
    >
      <span>{children}</span>
      <Arrow />
    </button>
  );
}

/** Chevron used on every forward action. */
export function Arrow({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 14"
      className={`h-[0.7em] w-auto shrink-0 fill-current transition-transform duration-150 group-hover:translate-x-1 ${className}`}
    >
      <path d="M0 0h5l7 7-7 7H0l7-7z" />
    </svg>
  );
}

/** Secondary action: condensed caps with a hard underline. */
export function TextButton({ className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`pointer-events-auto border-b-2 border-paper/30 pb-1 font-cond text-lg font-bold uppercase tracking-[0.18em] text-paper/70 transition-colors hover:border-hp hover:text-paper disabled:pointer-events-none disabled:opacity-30 ${className}`}
    >
      {children}
    </button>
  );
}
