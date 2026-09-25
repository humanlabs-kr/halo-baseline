import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import { Amount, countryName, useMoneyText } from '@/components/ledger/Amount';
import { ChartLegend, PriceChart } from '@/components/ledger/PriceChart';
import { Chip } from '@/components/ui/Chip';
import { Segments } from '@/components/ui/Button';
import { GroupHead, Row, RowRule } from '@/components/ui/Row';
import { TopBar } from '@/components/ledger/TopBar';
import { Failed } from '@/components/ledger/Failed';
import { ReceiptIcon } from '@/components/ui/icons';
import { categoryName, monthLabel, unitEach } from '@/lib/basket';
import { useLedgerItem } from '@/lib/api/queries';
import type { ChartSpan } from '@/lib/api/ledger';
import { useFormatters } from '@/lib/format';

/**
 * One basket item: what it costs you, what it costs everyone else, and the
 * six months of both.
 *
 * The chart is the screen. This product's claim is that a shopper's prices
 * move against the market over time, and the version of this page that
 * printed six numbers in a column could not show the one thing that claim is
 * about — whether the two lines converged. The purchase list underneath is the
 * evidence for the figure above it, which is the only reason the figure is
 * believable.
 */
function LedgerItem() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const money = useMoneyText();
  const { category } = useParams<{ category: string }>();
  const [span, setSpan] = useState<ChartSpan>('6m');
  const { data, isPending, isError } = useLedgerItem(category, span);
  const fmt = useFormatters();

  const currency = data?.currency ?? 'USD';
  const yours = data?.yours ?? null;
  const market = data?.market ?? null;
  const gap =
    yours !== null && market?.unitPrice != null ? market.unitPrice - yours.unitPrice : null;

  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      <TopBar title={categoryName(data?.category ?? null, t)} back />

      {isError ? (
        <Failed />
      ) : isPending ? (
        <p className="px-5 py-10 text-[15px] font-medium text-[#8B95A1]">{t('Loading…')}</p>
      ) : (
        <>
          <section className="px-5 pt-1.5">
            <p className="text-[14px] font-medium tracking-[-.02em] text-[#8B95A1]">
              {t('What you pay · {{unit}}', { unit: unitEach(data.unit, t) })}
            </p>
            {yours === null ? (
              <p className="mt-1 text-[22px] font-bold tracking-[-.03em] text-[#B0B8C1]">
                {t('You have not bought this yet')}
              </p>
            ) : (
              <>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-[9px] gap-y-2">
                  <Amount
                    value={yours.unitPrice}
                    currency={currency}
                    className="text-[34px] font-extrabold leading-[1.1] tracking-[-.045em]"
                  />
                  {gap !== null && Math.round(gap) !== 0 && (
                    <Chip tone={gap > 0 ? 'saved' : 'over'}>
                      {gap > 0
                        ? t('{{amount}} cheaper', { amount: money(Math.abs(gap), currency) })
                        : t('{{amount}} dearer', { amount: money(Math.abs(gap), currency) })}
                    </Chip>
                  )}
                </div>

                {/* Three different absences, and they are not the same
                    sentence: nobody here has bought this, not enough people
                    have, or they have and here is the number. */}
                {/* One key, not a label joined to a number. Korean puts the
                    verb after the price — "…보통 4,100원에 사요" — so a
                    prefix plus an <Amount> leaves the sentence unfinished on
                    the screens that need it most. */}
                <p className="mt-1.5 text-[13px] font-medium text-[#8B95A1]">
                  {market === null ? (
                    t('Nobody here has bought this yet')
                  ) : market.unitPrice === null ? (
                    t('A price needs {{count}} more receipts', { count: market.needed })
                  ) : (
                    <Trans
                      i18nKey="People in {{country}} usually pay <0>{{price}}</0>."
                      values={{
                        country: countryName(market.country, fmt.lang),
                        price: money(market.unitPrice, currency),
                      }}
                      components={[<b key="0" className="font-bold text-[#4E5968]" />]}
                    />
                  )}
                </p>
              </>
            )}
          </section>

          <section className="px-5 pt-5">
            <Segments
              value={span}
              onChange={setSpan}
              options={[
                { value: '6m', label: t('6 months') },
                { value: '1y', label: t('1 year') },
                { value: 'all', label: t('All') },
              ]}
            />
          </section>

          {data.history.length >= 2 ? (
            <section className="px-5 pt-6">
              <PriceChart
                mine={data.history.map((row) => row.unitPrice)}
                market={data.history.map((row) => row.marketUnitPrice)}
                labels={data.history.map((row) => monthLabel(row.month, fmt.lang, 'short'))}
              />
              <ChartLegend
                mine={t('Your price')}
                market={
                  market === null
                    ? t('Around you')
                    : t('{{country}} average', {
                        country: countryName(market.country, fmt.lang),
                      })
                }
              />
            </section>
          ) : (
            // One point is not a line, and an empty box under three buttons
            // reads as a chart that failed rather than as a span with nothing
            // in it.
            <p className="px-5 pt-8 pb-2 text-[14px] font-medium text-[#8B95A1]">
              {t('Two months of buying it draws the line.')}
            </p>
          )}

          {data.purchases.length > 0 && (
            <>
              <GroupHead
                title={t('When you bought it')}
                trailing={t('{{count}} times', { count: yours?.buys ?? data.purchases.length })}
              />
              {data.purchases.map((purchase, index) => (
                <div key={`${purchase.receiptId}-${index}`}>
                  {index > 0 && <RowRule />}
                  <Row
                    icon={<ReceiptIcon />}
                    title={purchase.merchantName ?? t('Unnamed shop')}
                    caption={`${fmt.receiptDay(purchase.issuedAt)} · ${purchase.rawText}`}
                    chevron={false}
                    onClick={() => navigate(`/receipts/${purchase.receiptId}`)}
                    right={
                      <>
                        {purchase.lineTotal !== null && (
                          <b className="block text-[16px] font-bold tracking-[-.03em]">
                            <Amount value={purchase.lineTotal} currency={currency} />
                          </b>
                        )}
                        <div className="mt-[5px]">
                          <Chip
                            size="sm"
                            tone={
                              market?.unitPrice == null
                                ? 'neutral'
                                : purchase.unitPrice < market.unitPrice
                                  ? 'saved'
                                  : purchase.unitPrice > market.unitPrice
                                    ? 'over'
                                    : 'neutral'
                            }
                          >
                            {unitEach(data.unit, t)}{' '}
                            <Amount value={purchase.unitPrice} currency={currency} />
                          </Chip>
                        </div>
                      </>
                    }
                  />
                </div>
              ))}
              <div className="h-6" />
            </>
          )}
        </>
      )}
    </div>
  );
}

export default LedgerItem;
