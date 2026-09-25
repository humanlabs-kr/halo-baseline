import { useNavigate, useSearchParams } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import { Amount, UnitChange, useMoneyText } from '@/components/ledger/Amount';
import { categoryName, groupName } from '@/lib/basket';
import { Chip } from '@/components/ui/Chip';
import { GroupHead, Row, RowRule } from '@/components/ui/Row';
import { TopBar } from '@/components/ledger/TopBar';
import { Failed } from '@/components/ledger/Failed';
import { categoryIcon, categoryTone } from '@/components/ledger/category-icon';
import { QuestionIcon } from '@/components/ui/icons';
import { useSpendGroup } from '@/lib/api/queries';
import type { SpendGroup as Group } from '@/lib/api/ledger';

/**
 * One spend group, item by item.
 *
 * Every row leads with the unit price change in money, because that is the
 * number a shopper can act on. The percentage rides along as a chip rather
 * than as the headline.
 *
 * The summary at the top is the ledger's summary at a smaller scope — same
 * eyebrow, same weight of figure, same chip. This screen had kept the torn
 * paper card and the dashed perforation after the home screen stopped using
 * them, so the drill-down looked like a different app to the screen it opened
 * from.
 */
function SpendGroup({ group }: { group: Group }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const money = useMoneyText();
  // The month travels in the URL so the drill-down stays in the month the user
  // was looking at. Without it, opening Groceries from March showed September
  // under a heading reading "Groceries this month".
  const [searchParams] = useSearchParams();
  const month = searchParams.get('month') ?? undefined;
  const { data, isPending, isError } = useSpendGroup(group, month);

  const currency = data?.spent.currency ?? 'USD';
  const label = groupName(group, t);
  const spent = data?.spent.amount ?? 0;
  const previous = data?.previousSpent ?? null;
  const difference = previous === null ? null : Math.round(spent - previous);

  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      <TopBar title={label} back />

      {isError ? (
        <Failed />
      ) : isPending ? (
        <p className="px-5 py-10 text-[15px] font-medium text-[#8B95A1]">{t('Loading…')}</p>
      ) : (
        <>
          <section className="px-5 pt-1.5">
            <p className="text-[14px] font-medium tracking-[-.02em] text-[#8B95A1]">
              {t('{{group}} this month', { group: label })}
            </p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-[9px] gap-y-2">
              <Amount
                value={spent}
                currency={currency}
                className="text-[34px] font-extrabold leading-[1.1] tracking-[-.045em]"
              />
              {difference !== null && difference !== 0 && (
                <Chip tone={difference > 0 ? 'over' : 'saved'}>
                  {difference > 0 ? (
                    <Trans
                      i18nKey="{{amount}} more than last month"
                      values={{ amount: money(Math.abs(difference), currency) }}
                    />
                  ) : (
                    <Trans
                      i18nKey="{{amount}} less than last month"
                      values={{ amount: money(Math.abs(difference), currency) }}
                    />
                  )}
                </Chip>
              )}
            </div>
            {previous !== null && (
              <p className="mt-3.5 text-[12.5px] font-medium text-[#8B95A1]">
                {t('Last month')}{' '}
                <b className="font-bold text-[#4E5968]">
                  <Amount value={previous} currency={currency} />
                </b>
              </p>
            )}
          </section>

          <GroupHead title={t('Compared with last month')} />

          {data?.items.map((item, index) => (
            <div key={item.category}>
              {index > 0 && <RowRule />}
              <Row
                icon={categoryIcon(item.category)}
                tone={categoryTone(item.category)}
                title={categoryName(item.category, t)}
                caption={
                  <UnitChange
                    change={item.unitPriceChange}
                    unit={item.unit}
                    currency={currency}
                    priced={item.unitPrice !== null}
                  />
                }
                chevron={false}
                onClick={() => navigate(`/ledger/item/${item.category}`)}
                right={
                  <>
                    <b className="block text-[16px] font-bold tracking-[-.03em]">
                      <Amount value={item.spent} currency={currency} />
                    </b>
                    <span className="mt-[5px] block text-[13px] font-medium text-[#8B95A1]">
                      {t('{{count}} buys', { count: item.buys })}
                    </span>
                  </>
                }
              />
            </div>
          ))}

          {/* Shown rather than hidden. A ledger that quietly drops rows stops
              being a ledger, and the gap between the basket and the receipt
              total is the user's money too. */}
          {data && data.unmatched.lines > 0 && (
            <>
              <RowRule />
              <Row
                icon={<QuestionIcon />}
                dim
                title={t('Not in the basket yet')}
                caption={t('{{count}} lines', { count: data.unmatched.lines })}
                right={
                  <b className="text-[16px] font-bold tracking-[-.03em] text-[#8B95A1]">
                    <Amount value={data.unmatched.amount} currency={currency} />
                  </b>
                }
              />
            </>
          )}
          <div className="h-6" />
        </>
      )}
    </div>
  );
}

export default SpendGroup;
