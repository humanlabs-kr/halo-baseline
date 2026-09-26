import { useTranslation } from 'react-i18next';

import { Amount } from '@/components/ledger/Amount';
import { sendLightImpactHaptic } from '@/lib/haptic';
import { formatBps } from '@/lib/cover';

/**
 * What somebody is holding, and whether they can do anything about it.
 *
 * Four states, and the one that matters is `frozen`. Between an epoch closing
 * and its value being finalised nothing can be traded or redeemed, and a
 * screen that renders a dead button in that window teaches people the app is
 * broken. Saying why, with the date it lifts, is the difference between a wait
 * and a fault.
 */
export type Position = {
  marketId: string;
  itemName: string;
  currency: string;
  /** Face value of the cover. */
  cover: number;
  strikeBps: number;
  capBps: number;
  /** Null until the epoch settles. */
  settledBps: number | null;
  /** What redemption would pay right now. Null while unsettled. */
  payout: number | null;
  status: 'open' | 'frozen' | 'settled' | 'redeemed';
  /** When the freeze lifts, for the only state where waiting is the answer. */
  opensAt?: string;
};

export function Positions({
  positions,
  onRedeem,
}: {
  positions: readonly Position[];
  onRedeem: (marketId: string) => void;
}) {
  const { t } = useTranslation();

  if (positions.length === 0) {
    return (
      <p className="px-5 py-10 text-[15px] font-medium text-[#8B95A1]">
        {t('You have no cover yet')}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2.5 px-5 pt-1.5">
      {positions.map((p) => (
        <li key={p.marketId} className="rounded-[14px] bg-[#F2F4F6] px-4 py-3.5">
          <div className="flex items-baseline justify-between">
            <span className="text-[16px] font-bold tracking-[-.03em]">{p.itemName}</span>
            <Amount
              value={p.cover}
              currency={p.currency}
              className="text-[16px] font-bold tracking-[-.03em]"
            />
          </div>

          <p className="mt-0.5 text-[13px] font-medium text-[#8B95A1]">
            {t('Pays from {{strike}}, full at {{cap}}', {
              strike: formatBps(p.strikeBps),
              cap: formatBps(p.capBps),
            })}
          </p>

          {p.status === 'settled' && p.payout !== null && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="min-w-0 text-[13.5px] font-medium text-[#4E5968]">
                {t('Settled at {{change}}', { change: formatBps(p.settledBps ?? 0) })}
              </span>
              {/* Not the shared Button: that one is w-full by design, for the
                  one primary action at the bottom of a screen. Inside a row it
                  has to be told its size, and fighting a base class with a
                  later utility depends on stylesheet order rather than on
                  anything written here. */}
              <button
                type="button"
                onClick={() => {
                  sendLightImpactHaptic();
                  onRedeem(p.marketId);
                }}
                className="shrink-0 rounded-[10px] bg-[#191F28] px-3.5 py-2 text-[13.5px] font-bold tracking-[-.03em] text-white transition-transform active:scale-[.978]"
              >
                {t('Redeem')}
              </button>
            </div>
          )}

          {/* A wait, explained. Not a disabled button with no reason beside it. */}
          {p.status === 'frozen' && (
            <p className="mt-2.5 text-[13px] font-medium text-[#8B95A1] break-keep">
              {t('Locked while this month closes. Opens {{date}}.', { date: p.opensAt ?? '—' })}
            </p>
          )}

          {/* Zero is neutral, not green. A payout of nothing coloured as a
              saving reads as good news about an outcome where the buyer got
              none — the strike was never reached and the premium is gone. */}
          {p.status === 'redeemed' && p.payout !== null && (
            <p
              className={`mt-2.5 text-[13px] font-semibold ${
                p.payout > 0 ? 'text-[#00A06A]' : 'text-[#8B95A1]'
              }`}
            >
              {p.payout > 0 ? t('Paid out') : t('Paid out nothing')}{' '}
              {p.payout > 0 && <Amount value={p.payout} currency={p.currency} />}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
