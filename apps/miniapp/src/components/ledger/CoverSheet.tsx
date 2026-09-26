import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Amount, useMoneyText } from '@/components/ledger/Amount';
import { Button } from '@/components/ui/Button';
import { breakEvenBps, formatBps, payoutTable, premiumFor, type CoverTerms } from '@/lib/cover';

/**
 * Buying cover, in the language of cover.
 *
 * The words here are not decoration. `bet`, `position`, `yield`, `APY`, `long`
 * and `short` appear nowhere, because the person reading it is buying
 * protection on their groceries and every one of those invites them to read it
 * as something else — and invites a regulator to as well.
 *
 * Three numbers have to be on screen before the button is pressed: what is
 * covered, what it costs, and where the buyer stops losing money. The third is
 * the one that gets left off, and leaving it off is how a screen tells someone
 * they profit from +6% inflation when they are ¥400 down on it.
 *
 * Colours follow the app's rule rather than inventing a palette for this
 * screen: neutral everywhere, `#00A06A` for saved, `#F04452` for overpaid, and
 * the near-black for the primary action.
 */
export function CoverSheet({
  terms,
  currency,
  itemName,
  months,
  onConfirm,
}: {
  terms: CoverTerms;
  currency: string;
  itemName: string;
  months: number;
  onConfirm: (cover: number) => void;
}) {
  const { t } = useTranslation();
  const money = useMoneyText();
  const [cover, setCover] = useState(terms.cover);

  const live = useMemo<CoverTerms>(() => ({ ...terms, cover }), [terms, cover]);
  const premium = premiumFor(live);
  const breakEven = breakEvenBps(live);
  const rows = useMemo(() => payoutTable(live), [live]);

  return (
    <div className="flex flex-col gap-[18px] px-5 pt-1.5 pb-[30px]">
      <div>
        <p className="text-[14px] font-medium tracking-[-.02em] text-[#8B95A1]">
          {t('Cover for {{months}} months', { months })}
        </p>
        <h2 className="mt-1 break-keep text-[22px] font-bold tracking-[-.03em]">
          {t('If {{item}} keeps rising', { item: itemName })}
        </h2>
      </div>

      {/* Steps rather than a free field. The amounts people pick are round, and
          a slider invites fiddling with the number that matters least. */}
      <div className="flex gap-2">
        {[terms.cover / 2, terms.cover, terms.cover * 2].map((amount) => (
          <button
            key={amount}
            type="button"
            onClick={() => setCover(amount)}
            className={`flex-1 rounded-[12px] py-[13px] text-[15px] font-bold tracking-[-.03em] transition-colors ${
              cover === amount ? 'bg-[#191F28] text-white' : 'bg-[#F2F4F6] text-[#4E5968]'
            }`}
          >
            <Amount value={amount} currency={currency} />
          </button>
        ))}
      </div>

      <dl className="rounded-[14px] bg-[#F2F4F6] px-4 py-3.5">
        <Term label={t('Covered')}>
          <Amount value={cover} currency={currency} />
        </Term>
        <Term label={t('Pays from')}>{formatBps(terms.strikeBps)}</Term>
        {/* The row that is easy to omit, and the only one that says where the
            buyer stops being out of pocket. */}
        <Term label={t('You break even at')} strong>
          {breakEven === null ? '—' : formatBps(breakEven)}
        </Term>
        <Term label={t('Full payout at')}>{formatBps(terms.capBps)}</Term>
      </dl>

      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-semibold text-[#4E5968]">{t('You pay')}</span>
        <Amount
          value={premium}
          currency={currency}
          className="text-[26px] font-extrabold tracking-[-.04em]"
        />
      </div>

      <div className="rounded-[14px] bg-[#F2F4F6] px-4 py-3">
        <p className="pb-1.5 text-[13px] font-medium text-[#8B95A1]">
          {t('What comes back to you')}
        </p>
        {rows.map((row) => (
          <div key={row.valueBps} className="flex items-baseline justify-between py-[5px]">
            <span className="text-[13.5px] font-medium text-[#4E5968]">
              {t('{{item}} up {{change}}', { item: itemName, change: formatBps(row.valueBps) })}
            </span>
            <span className="flex items-baseline gap-1.5">
              <Amount value={row.payout} currency={currency} className="text-[13.5px] font-bold" />
              {/* Net beside payout, so no row shows what comes back without
                  showing what it cost. */}
              <span
                className={`text-[12px] font-semibold ${
                  row.net > 0
                    ? 'text-[#00A06A]'
                    : row.net < 0
                      ? 'text-[#F04452]'
                      : 'text-[#8B95A1]'
                }`}
              >
                {/* Sign rendered here and the magnitude passed absolute, because
                    Intl puts a currency symbol before the minus and `¥-1,200`
                    reads as a price rather than a loss. This is the first screen
                    in the app to show negative money, which is why it surfaces
                    now. */}
                {row.net > 0 ? '+' : row.net < 0 ? '−' : ''}
                <Amount value={Math.abs(row.net)} currency={currency} />
              </span>
            </span>
          </div>
        ))}
      </div>

      {/* Maximum loss, before the button rather than after it. */}
      <p className="break-keep text-[12.5px] font-medium leading-[1.55] text-[#8B95A1]">
        {t('The most you can lose is what you pay now. There is nothing more to pay later.')}
      </p>

      <Button onClick={() => onConfirm(cover)}>
        {t('Pay {{amount}}', { amount: money(premium, currency) })}
      </Button>
    </div>
  );
}

function Term({
  label,
  strong,
  children,
}: {
  label: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between py-[5px]">
      <dt className="text-[13.5px] font-medium text-[#4E5968]">{label}</dt>
      <dd
        className={`text-[13.5px] tracking-[-.02em] text-[#191F28] ${
          strong ? 'font-extrabold' : 'font-bold'
        }`}
      >
        {children}
      </dd>
    </div>
  );
}
