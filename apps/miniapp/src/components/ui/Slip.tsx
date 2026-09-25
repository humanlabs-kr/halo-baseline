import type { ReactNode } from 'react';

/**
 * A receipt, as an object lying on the app.
 *
 * The metaphor belongs here and only here. When the whole chrome was made of
 * paper the app looked like a printed document; the fix is not to delete the
 * paper but to put it back where it means something — the two screens that
 * show the user a receipt they actually photographed.
 *
 * The torn bottom edge is an SVG background rather than a CSS mask: masks
 * render as a straight edge on some Android WebViews, and a signature that
 * disappears on half the install base is not a signature.
 */
export function Slip({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`relative ${className}`}>
      <div className="rounded-t-2xl rounded-b bg-white px-[18px] pt-5 shadow-[0_1px_2px_rgba(25,31,40,.06),0_8px_24px_rgba(25,31,40,.10)]">
        {children}
        <div className="h-4" />
      </div>
      <div
        aria-hidden
        className="absolute inset-x-0 -bottom-[9px] h-[10px] bg-repeat-x"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='10' viewBox='0 0 16 10'%3E%3Cpath d='M0 0h16v4.5L8 10 0 4.5z' fill='%23ffffff'/%3E%3C/svg%3E\")",
          backgroundSize: '16px 10px',
        }}
      />
    </div>
  );
}

/**
 * One printed line: what it was, what it cost, and — quietly, underneath —
 * what that works out to per unit.
 *
 * `verdict` is deliberately optional. On the login screen there is no shopper
 * to compare against yet, so the lines carry their unit price and nothing
 * else; adding a fake comparison there would be the one false note on a screen
 * whose whole job is to be believable.
 */
export function SlipLine({
  name,
  price,
  unit,
  verdict,
  tone = 'neutral',
}: {
  name: string;
  price: ReactNode;
  unit?: ReactNode;
  verdict?: ReactNode;
  tone?: 'neutral' | 'saved' | 'over';
}) {
  const colour = { neutral: 'text-[#B0B8C1]', saved: 'text-[#00A06A]', over: 'text-[#F04452]' }[tone];

  return (
    <div className="flex justify-between gap-3 py-[9px] text-[14px] tracking-[-.02em] [&+&]:border-t [&+&]:border-[#F2F4F6]">
      <span className="min-w-0">
        <b className="font-semibold text-[#191F28]">{name}</b>
        {verdict && <span className={`mt-[3px] block text-[12.5px] font-semibold ${colour}`}>{verdict}</span>}
      </span>
      <span className="shrink-0 text-right">
        <b className="font-bold tabular-nums">{price}</b>
        {unit && <span className="mt-[3px] block text-[12.5px] font-medium tabular-nums text-[#B0B8C1]">{unit}</span>}
      </span>
    </div>
  );
}

/** The double rule a till prints above the total. */
export function SlipTotal({ label, amount }: { label: string; amount: ReactNode }) {
  return (
    <div className="mt-1 flex justify-between gap-3 border-t-2 border-[#191F28] py-[9px] text-[15px] tracking-[-.02em]">
      <b className="font-semibold">{label}</b>
      <b className="text-[16px] font-bold tabular-nums">{amount}</b>
    </div>
  );
}
