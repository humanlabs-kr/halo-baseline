import type { ReactNode } from 'react';
import { sendLightImpactHaptic } from '@/lib/haptic';

/**
 * One line of a list, at the proportions the mock-up sets: a 42px tinted
 * icon tile, the title and its caption, and whatever goes on the right.
 *
 * A `<button>` when it leads somewhere and a `<div>` when it does not —
 * rather than a div with an onClick, which is invisible to a screen reader and
 * cannot be reached by a keyboard. `action` exists because a row that contains
 * its own button cannot itself be a button: nesting them means one tap fires
 * both, which is how claiming points used to navigate away mid-transaction.
 */
export function Row({
  icon,
  tone = 'neutral',
  title,
  caption,
  right,
  action,
  onClick,
  dim = false,
  chevron = true,
}: {
  icon?: ReactNode;
  tone?: 'neutral' | 'saved' | 'warm';
  title: ReactNode;
  caption?: ReactNode;
  right?: ReactNode;
  action?: ReactNode;
  onClick?: () => void;
  dim?: boolean;
  /**
   * Off where the right-hand side already carries a stack of its own — a
   * price over a chip. The arrow then competes with the chip for the same
   * edge and the row reads as two controls instead of one.
   */
  chevron?: boolean;
}) {
  const tile = {
    neutral: 'bg-[#F2F4F6] text-[#4E5968]',
    saved: 'bg-[#E7F8F1] text-[#00A06A]',
    warm: 'bg-[#FFF1E6] text-[#E8833A]',
  }[tone];

  const body = (
    <>
      {icon && (
        <span
          className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[14px] ${tile} ${dim ? 'opacity-45' : ''}`}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 text-left">
        <b className={`block break-keep text-[16px] font-bold tracking-[-.03em] ${dim ? 'text-[#8B95A1]' : ''}`}>
          {title}
        </b>
        {caption && (
          <span className="mt-0.5 block text-[13px] font-medium tracking-[-.02em] text-[#8B95A1]">{caption}</span>
        )}
      </span>
      {right && <span className="shrink-0 text-right">{right}</span>}
    </>
  );

  const padding = 'flex items-center gap-3.5 bg-white px-5 py-[15px]';

  if (action) {
    return (
      <div className={padding}>
        {onClick ? (
          <button
            type="button"
            onClick={() => {
              sendLightImpactHaptic();
              onClick();
            }}
            className="flex min-w-0 flex-1 items-center gap-3.5 transition-colors active:bg-[#F2F4F6]"
          >
            {body}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3.5">{body}</div>
        )}
        {action}
      </div>
    );
  }

  if (!onClick) return <div className={padding}>{body}</div>;

  return (
    <button
      type="button"
      onClick={() => {
        sendLightImpactHaptic();
        onClick();
      }}
      className={`${padding} w-full transition-colors active:bg-[#F2F4F6]`}
    >
      {body}
      {chevron && <Chevron />}
    </button>
  );
}

/**
 * The hairline between rows. Inset past the icon, as the mock-up draws it.
 *
 * `inset` off where the rows it separates carry no icon: a rule that starts
 * 64px in with nothing in the gap does not read as an indent, it reads as a
 * rule that failed to reach the edge.
 */
export function RowRule({ inset = true }: { inset?: boolean }) {
  return <div aria-hidden className={`h-px bg-[#F2F4F6] ${inset ? 'ml-16' : 'mx-5'}`} />;
}

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-[18px] w-[18px] shrink-0" fill="none" stroke="#C4CBD3" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/**
 * The section label above a group of rows.
 *
 * `trailing` is for the number that belongs to the whole group — a day's
 * total, how many receipts. It sits on the baseline of the label rather than
 * in the first row, because it describes the group and not the first item in it.
 */
export function GroupHead({ title, trailing }: { title: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between px-5 pt-[26px] pb-2.5">
      <b className="text-[17px] font-bold tracking-[-.03em]">{title}</b>
      {trailing && <span className="text-[13px] font-medium text-[#8B95A1]">{trailing}</span>}
    </div>
  );
}
