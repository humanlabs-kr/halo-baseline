import type { ReactNode } from 'react';

/**
 * The `‹ label ›` control, for a list that is read one page at a time.
 *
 * One component because the app has two of these — the raffle round's date and
 * the payout list's page — and they were hand-rolled separately, at different
 * sizes, on two screens one tap apart. Two shapes for one gesture reads as two
 * mechanisms.
 */
export function Stepper({
  label,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
  canPrevious = true,
  canNext = true,
}: {
  label: ReactNode;
  /** The arrows carry no text, so these are what a screen reader announces. */
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
  canPrevious?: boolean;
  canNext?: boolean;
}) {
  return (
    <div className="flex items-center justify-center gap-4 px-5 py-2.5">
      <Arrow direction="previous" label={previousLabel} onClick={onPrevious} disabled={!canPrevious} />
      <span className="min-w-[140px] text-center text-[16px] font-bold tabular-nums tracking-[-.03em]">
        {label}
      </span>
      <Arrow direction="next" label={nextLabel} onClick={onNext} disabled={!canNext} />
    </div>
  );
}

function Arrow({
  direction,
  label,
  onClick,
  disabled,
}: {
  direction: 'previous' | 'next';
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`pressed flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#F2F4F6] text-[#4E5968] ${
        disabled ? 'opacity-40' : ''
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={direction === 'previous' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
      </svg>
    </button>
  );
}
