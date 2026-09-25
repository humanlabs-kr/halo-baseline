import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { monthLabel } from '@/lib/basket';
import { sendLightImpactHaptic } from '@/lib/haptic';

/**
 * The month, as a Korean ledger app writes it: one tappable label at the top
 * left with a chevron, not a centred title flanked by arrows.
 *
 * Arrows look like navigation and are one month per tap; the label opens the
 * list, which is how somebody gets to March from September. Every ledger app
 * on the phone does it this way, and matching them is not imitation — a
 * control that behaves unlike its lookalikes is the expensive kind of
 * original.
 */
export function MonthPicker({
  month,
  lang,
  onChange,
}: {
  month: string | undefined;
  lang: string;
  onChange: (month: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const current = month ?? thisMonth();

  return (
    <>
      <button
        type="button"
        onClick={() => {
          sendLightImpactHaptic();
          setOpen(true);
        }}
        className="flex items-center gap-1 py-1.5 text-[19px] font-bold tracking-[-.03em] transition-opacity active:opacity-55"
      >
        {monthLabel(current, lang)}
        <svg viewBox="0 0 24 24" aria-hidden className="h-[18px] w-[18px] opacity-40" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/30" onClick={() => setOpen(false)}>
          <div
            className="max-h-[70vh] overflow-y-auto rounded-t-3xl bg-white pb-[max(20px,env(safe-area-inset-bottom))]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sticky top-0 bg-white px-5 pt-5 pb-3">
              <b className="text-[17px] font-bold tracking-[-.03em]">{t('Pick a month')}</b>
            </div>
            {recentMonths().map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  sendLightImpactHaptic();
                  onChange(value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between px-5 py-4 text-left text-[16px] tracking-[-.02em] transition-colors active:bg-[#F2F4F6] ${
                  value === current ? 'font-bold' : 'font-medium text-[#4E5968]'
                }`}
              >
                {monthLabel(value, lang)}
                {value === current && <Tick />}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Tick() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="#191F28" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/**
 * Two years back, newest first. Far enough for anybody who has been scanning
 * since launch, and short enough that the sheet does not need a year picker
 * of its own.
 */
function recentMonths(): string[] {
  const now = new Date();
  return Array.from({ length: 24 }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

export function thisMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
