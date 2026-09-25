import type { ReactNode } from 'react';

/**
 * The grey pill.
 *
 * One component, because a chip that is two pixels rounder on one screen stops
 * reading as the same object. `tone` is the only decision a caller gets, and
 * it is a decision about meaning rather than colour — `saved` and `over` are
 * the two states this product has an opinion about.
 */
export function Chip({
  children,
  tone = 'neutral',
  size = 'md',
  className = '',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'saved' | 'over';
  size?: 'sm' | 'md';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-[#F2F4F6] text-[#4E5968]',
    saved: 'bg-[#E7F8F1] text-[#00A06A]',
    over: 'bg-[#FFEBEE] text-[#F04452]',
  }[tone];

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-bold tabular-nums tracking-[-.02em] ${tones} ${
        size === 'sm' ? 'px-[9px] py-1 text-[12px]' : 'px-[11px] py-1.5 text-[13px]'
      } ${className}`}
    >
      {children}
    </span>
  );
}
