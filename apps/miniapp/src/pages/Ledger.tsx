import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import { Amount, useMoneyText } from '@/components/ledger/Amount';
import { MonthPicker, thisMonth } from '@/components/ledger/MonthPicker';
import { Chip } from '@/components/ui/Chip';
import { Row, RowRule, GroupHead } from '@/components/ui/Row';
import { Button } from '@/components/ui/Button';
import { Failed } from '@/components/ledger/Failed';
import { BestWorst } from '@/components/ledger/BestWorst';
import { MarketBoard } from '@/components/ledger/MarketBoard';
import { categoryName, groupName } from '@/lib/basket';
import { useMonth, useReceipts } from '@/lib/api/queries';
import { useFormatters } from '@/lib/format';
import { groupByDay } from '@/lib/receipt-days';
import { BasketIcon, BoxIcon, CameraIcon, QuestionIcon, ReceiptIcon } from '@/components/ui/icons';

/**
 * What this month cost, and how it sits against everyone else.
 *
 * Ordered the way a Korean ledger app orders it, because that order is not
 * arbitrary: how much, then against what, then on what, then when. The
 * comparison sits second rather than last — it is the reason this app is not
 * a spreadsheet, and it was previously nowhere on the home screen at all.
 */
function Ledger() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [month, setMonth] = useState<string | undefined>(undefined);
  const { data, isPending, isError } = useMonth(month);
  const { data: receipts } = useReceipts();
  const fmt = useFormatters();
  const money = useMoneyText();

  const currency = data?.spent.currency ?? 'USD';
  const previous = data?.previous ?? null;
  const spent = data?.spent.amount ?? 0;
  const empty = (data?.receiptCount ?? 0) === 0;

  // The days under a month header have to be days in that month. The list
  // showed the three most recent days regardless, so switching the picker to
  // March left August receipts sitting under "2026년 3월" — and, with the
  // month summary counting two receipts, three days of them.
  const days = groupByDay(
    (receipts?.list ?? []).filter(
      (receipt) => data !== undefined && monthOf(receipt) === data.month,
    ),
  ).slice(0, 3);

  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      <header className="px-5 pt-[max(6px,env(safe-area-inset-top))]">
        <MonthPicker month={data?.month} lang={fmt.lang} onChange={setMonth} />
      </header>

      {isError ? (
        <Failed />
      ) : isPending ? (
        <p className="px-5 py-10 text-[15px] font-medium text-[#8B95A1]">{t('Loading your month…')}</p>
      ) : (
        <>
          <section className="px-5 pt-2">
            <p className="text-[14px] font-medium tracking-[-.02em] text-[#8B95A1]">
              {t('Spent {{range}}', { range: dayRange(data, fmt) })}
            </p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-[9px] gap-y-2">
              <Amount
                value={spent}
                currency={currency}
                className={`text-[34px] font-extrabold leading-[1.1] tracking-[-.045em] ${empty ? 'text-[#B0B8C1]' : ''}`}
              />
              {/* Money, not a bare number. `fmt.number` printed "25,734 덜"
                  next to a total reading "48,311원" — the one figure on the
                  screen with no unit on it, and the one a reader is most
                  likely to quote. */}
              {previous && previous.difference !== 0 && (
                <Chip tone={previous.difference > 0 ? 'over' : 'saved'}>
                  {previous.difference > 0 ? (
                    <Trans
                      i18nKey="{{amount}} more than last month"
                      values={{ amount: money(Math.abs(Math.round(previous.difference)), currency) }}
                    />
                  ) : (
                    <Trans
                      i18nKey="{{amount}} less than last month"
                      values={{ amount: money(Math.abs(Math.round(previous.difference)), currency) }}
                    />
                  )}
                </Chip>
              )}
            </div>

            {previous ? (
              <div className="mt-3.5 flex justify-between text-[12.5px] font-medium text-[#8B95A1]">
                <span>
                  {t('Same span last month')}{' '}
                  <b className="font-bold text-[#4E5968]">
                    <Amount value={previous.spent.amount} currency={currency} />
                  </b>
                </span>
                <span>
                  {t('{{count}} receipts', { count: fmt.number(data?.receiptCount ?? 0) })}
                </span>
              </div>
            ) : (
              <Button className="mt-[18px]" onClick={() => navigate('/camera-scan')}>
                <CameraIcon /> {t('Photograph your first receipt')}
              </Button>
            )}
          </section>

          {/* The whole reason this is not a spreadsheet. Shown before the
              breakdown, and shown even when there is nothing of the user's to
              compare — the prices exist whether or not they have scanned. */}
          {data?.comparison ? (
            <BestWorst comparison={data.comparison} currency={currency} />
          ) : (
            <MarketBoard hasReceipts={!empty} currency={currency} />
          )}

          {data?.itemised && (
            <>
              <GroupHead title={t('What you bought')} />
              <div className="px-5">
                <ShareBar groups={data.itemised.groups} unmatched={data.itemised.unmatched} total={spent} />
              </div>
              <div className="h-2" />
              {data.itemised.groups.map((group, index) => (
                <div key={group.group}>
                  {index > 0 && <RowRule />}
                  <Row
                    icon={group.group === 'groceries' ? <BasketIcon /> : <BoxIcon />}
                    title={groupName(group.group, t)}
                    caption={groupItems(group.categories, t)}
                    right={
                      <>
                        <b className="block text-[16px] font-bold tracking-[-.03em]">
                          <Amount value={group.amount} currency={currency} />
                        </b>
                        {/* Which way the prices inside went. The amount alone
                            says a group cost less and not whether that is
                            because things got cheaper or because less was
                            bought. */}
                        {(group.dearer > 0 || group.cheaper > 0) && (
                          <span className="mt-[5px] flex justify-end gap-1">
                            {group.dearer > 0 && (
                              <Chip size="sm" tone="over">{`${group.dearer} ↑`}</Chip>
                            )}
                            {group.cheaper > 0 && (
                              <Chip size="sm" tone="saved">{`${group.cheaper} ↓`}</Chip>
                            )}
                          </span>
                        )}
                      </>
                    }
                    onClick={() => navigate(`/ledger/${group.group}${month ? `?month=${month}` : ''}`)}
                  />
                </div>
              ))}
              {data.itemised.unmatched > 0 && (
                <>
                  <RowRule />
                  <Row
                    icon={<QuestionIcon />}
                    title={t('Not in the basket yet')}
                    dim
                    right={
                      <b className="text-[16px] font-bold tracking-[-.03em] text-[#8B95A1]">
                        <Amount value={data.itemised.unmatched} currency={currency} />
                      </b>
                    }
                  />
                </>
              )}
            </>
          )}

          {days.length > 0 && (
            <>
              <div className="mt-2 h-2.5 bg-[#F2F4F6]" />
              {days.map(([day, items]) => (
                <section key={day}>
                  <GroupHead
                    title={fmt.receiptDay(day)}
                    trailing={
                      <Amount
                        value={items.reduce((sum, item) => sum + Number(item.totalAmount ?? 0), 0)}
                        currency={currency}
                      />
                    }
                  />
                  {items.map((receipt, index) => (
                    <div key={receipt.id}>
                      {index > 0 && <RowRule />}
                      <Row
                        icon={<ReceiptIcon />}
                        title={receipt.merchantName ?? t('Unnamed shop')}
                        caption={`${receipt.issuedAt === null ? fmt.time(receipt.createdAt) : fmt.receiptTime(receipt.issuedAt)}${receipt.lineCount > 0 ? ` · ${t('{{count}} items', { count: receipt.lineCount })}` : ''}`}
                        right={
                          <b className="text-[16px] font-bold tracking-[-.03em]">
                            {receipt.totalAmount === null ? (
                              '—'
                            ) : (
                              <Amount value={Number(receipt.totalAmount)} currency={currency} />
                            )}
                          </b>
                        }
                        onClick={() => navigate(`/receipts/${receipt.id}`)}
                      />
                    </div>
                  ))}
                </section>
              ))}
              <div className="px-5 pt-[18px] pb-[30px]">
                <Button variant="ghost" onClick={() => navigate('/receipts')}>
                  {t('See all {{count}} receipts', { count: fmt.number(receipts?.totalCount ?? 0) })}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One bar for the whole month rather than one per category.
 *
 * A bar per row answers "how long is this one", which nobody asked. Stacked,
 * it answers "what is most of the money", which is the only question a
 * breakdown is for.
 */
function ShareBar({
  groups,
  unmatched,
  total,
}: {
  groups: { group: string; amount: number }[];
  unmatched: number;
  total: number;
}) {
  const shades = ['#191F28', '#8B95A1', '#D1D6DB'];
  const parts = [...groups.map((group) => group.amount), unmatched].filter((amount) => amount > 0);
  const sum = Math.max(total, parts.reduce((running, amount) => running + amount, 0), 1);

  return (
    <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">
      {parts.map((amount, index) => (
        <i
          key={index}
          className="block h-full rounded-sm"
          style={{ width: `${(amount / sum) * 100}%`, background: shades[index] ?? shades[2] }}
        />
      ))}
    </div>
  );
}

function dayRange(data: { month: string; throughDay: number } | undefined, fmt: ReturnType<typeof useFormatters>) {
  if (!data) return '';
  const [year, index] = data.month.split('-').map(Number) as [number, number];
  return fmt.dayRange(new Date(year, index - 1, 1), new Date(year, index - 1, data.throughDay));
}

/** The `YYYY-MM` a receipt belongs to — by purchase date, in UTC, as the server buckets it. */
function monthOf(receipt: { issuedAt: string | null; createdAt: string }): string {
  const at = new Date(receipt.issuedAt ?? receipt.createdAt);
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * "Rice · eggs · cooking oil and 9 more" — what is actually in the group.
 *
 * Three, because a fourth pushes the row to two lines on a 360px screen and
 * the fourth item is never the one that explains the total.
 */
function groupItems(categories: string[], t: ReturnType<typeof useTranslation>['t']): string {
  if (categories.length === 0) return '';

  const shown = categories.slice(0, 3).map((category) => categoryName(category, t)).join(' · ');
  const rest = categories.length - 3;

  return rest > 0 ? t('{{items}} and {{count}} more', { items: shown, count: rest }) : shown;
}

export { thisMonth };
export default Ledger;
