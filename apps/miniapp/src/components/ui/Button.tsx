import type { ReactNode } from 'react';
import { sendLightImpactHaptic } from '@/lib/haptic';

/**
 * The two buttons this app has.
 *
 * `primary` is the product's near-black — deliberately not a blue. Borrowing
 * an accent from a well-known app makes a screen look like that app rather
 * than like an app, which is the mistake this design system was rebuilt to
 * undo. Colour here is reserved for saved and overpaid.
 */
export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  className?: string;
}) {
  const look =
    variant === 'primary' ? 'bg-[#191F28] text-white' : 'bg-[#F2F4F6] text-[#4E5968]';

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        sendLightImpactHaptic();
        onClick?.();
      }}
      className={`flex w-full items-center justify-center gap-[7px] rounded-[14px] py-[15px] text-[16px] font-bold tracking-[-.03em] transition-transform active:scale-[.978] ${look} ${disabled ? 'opacity-50' : ''} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * The iOS-style segmented control the mock-up uses to filter a long list.
 *
 * Genuinely a filter and not navigation: on a screen of forty-seven receipts
 * the two things a person is looking for are the ones they got cheap and the
 * ones they overpaid on, and scrolling for those is the work this removes.
 */
export function Segments<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-[3px] rounded-[11px] bg-[#F2F4F6] p-[3px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => {
            sendLightImpactHaptic();
            onChange(option.value);
          }}
          className={`flex-1 rounded-[9px] py-2 text-[13.5px] font-bold tracking-[-.02em] transition-colors ${
            option.value === value
              ? 'bg-white text-[#191F28] shadow-[0_1px_3px_rgba(25,31,40,.10)]'
              : 'text-[#8B95A1]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
