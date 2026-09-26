import { useTranslation } from 'react-i18next';

import { formatBps } from '@/lib/cover';

/**
 * The published index for a country, with the thing that makes it checkable.
 *
 * THE OBSERVATION COUNT IS NOT DECORATION. A price index with no sample size
 * beside it is a number somebody is asking to be believed, and the whole
 * design of the oracle underneath is an argument that nobody should have to.
 * Showing the count — and the as-of date — is the cheapest version of that
 * argument, and it is the first thing a sceptical reader looks for.
 *
 * WHEN THERE IS NOT ENOUGH DATA the band says what is missing rather than
 * hiding. "Not enough data" is not something anyone can act on; "seen at two
 * shops, needs three" is. That copy comes straight from the eligibility
 * reasons the index endpoint returns, so the screen and the rules cannot drift.
 */
export function IndexBand({
  country,
  changeBps,
  observations,
  asOf,
  reasons = [],
  onOpen,
}: {
  country: string;
  /** Null while the series has not cleared its floors. */
  changeBps: number | null;
  observations: number;
  asOf: string | null;
  /** Why it is not published yet, straight from the index rules. */
  reasons?: readonly string[];
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const published = changeBps !== null;

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className="mx-5 flex w-[calc(100%-40px)] flex-col gap-1 rounded-[14px] bg-[#F2F4F6] px-4 py-3.5 text-left disabled:opacity-100"
    >
      <span className="text-[13px] font-medium text-[#8B95A1]">
        {t('Grocery prices in {{country}}', { country })}
      </span>

      {published ? (
        <>
          <span className="flex items-baseline gap-2">
            <span
              className={`text-[22px] font-extrabold tracking-[-.04em] ${
                changeBps > 0 ? 'text-[#F04452]' : changeBps < 0 ? 'text-[#00A06A]' : 'text-[#191F28]'
              }`}
            >
              {formatBps(changeBps)}
            </span>
            <span className="text-[13px] font-medium text-[#8B95A1]">{t('in 30 days')}</span>
          </span>
          {/* The sample, said out loud. */}
          <span className="text-[12.5px] font-medium text-[#8B95A1]">
            {t('From {{count}} matched observations · as of {{date}}', {
              count: observations,
              date: asOf ?? '—',
            })}
          </span>
        </>
      ) : (
        <>
          <span className="text-[16px] font-bold tracking-[-.03em] text-[#B0B8C1]">
            {t('Not published yet')}
          </span>
          {/* What is missing, not that something is. */}
          {reasons.length > 0 && (
            <span className="break-keep text-[12.5px] font-medium text-[#8B95A1]">
              {reasons.join(' · ')}
            </span>
          )}
        </>
      )}
    </button>
  );
}
