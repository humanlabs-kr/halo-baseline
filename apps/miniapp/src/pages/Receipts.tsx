import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ClaimSuccessModal from '@/components/ClaimSuccessModal';
import { Amount } from '@/components/ledger/Amount';
import { Failed } from '@/components/ledger/Failed';
import { ReceiptRow } from '@/components/ledger/ReceiptRow';
import { Button, Segments } from '@/components/ui/Button';
import { GroupHead, RowRule } from '@/components/ui/Row';
import { TopBar } from '@/components/ledger/TopBar';
import { usePointClaim } from '@/hooks/usePointClaim';
import { useReceiptPages, useRejectedReceipts } from '@/lib/api/queries';
import { useFormatters } from '@/lib/format';
import { groupByDay } from '@/lib/receipt-days';
import { ReceiptIcon } from '@/components/ui/icons';
import type { ReceiptListItem } from '@/lib/api/receipt';

type Filter = 'all' | 'saved' | 'over';

/**
 * Every purchase, newest first, grouped by the day it was scanned.
 *
 * The floor of the ledger — the layer where a figure higher up can be traced
 * back to a piece of paper. Scans that never became a purchase are not in it;
 * the exception is a rejected scan that still owes points, which sits above
 * the history as an action rather than inside it as a purchase.
 *
 * The filter is the reason this screen is not just a list. On forty-seven
 * receipts the two things a person looks for are the ones they got cheap and
 * the ones they overpaid on, and scrolling for those is the work it removes.
 */
function Receipts() {
  const { t } = useTranslation();
  const { data, isPending, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useReceiptPages();
  const fmt = useFormatters();
  const claim = usePointClaim();
  const { data: unclaimed } = useRejectedReceipts(claim.mode === 'per-receipt');
  const [claimed, setClaimed] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const all = useMemo(() => data?.pages.flatMap((page) => page.list) ?? [], [data]);
  const shown = all.filter((receipt) => matches(receipt, filter));
  const days = groupByDay(shown);

  // All three count the same thing: what has been loaded. Using `totalCount`
  // for "all" put the server's figure beside two counted from the current
  // page, so the tabs silently described different populations — 18 / 9 / 9
  // where the first number covers receipts the other two have never seen.
  const counts = {
    all: all.length,
    saved: all.filter((receipt) => matches(receipt, 'saved')).length,
    over: all.filter((receipt) => matches(receipt, 'over')).length,
  };

  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      <TopBar title={t('Receipts')} back />

      {isError ? (
        // Without this a failed request fell through to the empty branch, and
        // someone with 1,204 receipts was told they had none.
        <Failed />
      ) : isPending ? (
        <p className="px-5 py-10 text-[15px] font-medium text-[#8B95A1]">{t('Loading your receipts…')}</p>
      ) : all.length === 0 && (unclaimed?.list.length ?? 0) === 0 ? (
        <Empty />
      ) : (
        <>
          <div className="px-5 pt-1">
            <Segments<Filter>
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: t('All {{count}}', { count: counts.all }) },
                { value: 'saved', label: t('Cheaper {{count}}', { count: counts.saved }) },
                { value: 'over', label: t('Dearer {{count}}', { count: counts.over }) },
              ]}
            />
          </div>

          {/* Rejected scans only, and only where points are claimed one at a
              time. Claimable purchases keep their button down in the history
              where the purchase is — putting them up here as well listed the
              same shop on the same day twice. */}
          {unclaimed && unclaimed.list.length > 0 && filter === 'all' && (
            <>
              <GroupHead title={t('Waiting to be claimed')} />
              {unclaimed.list.map((receipt, index) => (
                <div key={receipt.id}>
                  {index > 0 && <RowRule />}
                  <ReceiptRow receipt={receipt} when="date" claim={claim} onClaimed={setClaimed} />
                </div>
              ))}
            </>
          )}

          {days.map(([day, items]) => (
            <section key={day}>
              <GroupHead
                title={fmt.receiptDay(day)}
                trailing={
                  <Amount
                    value={items.reduce((sum, item) => sum + Number(item.totalAmount ?? 0), 0)}
                    currency={items[0]?.currency ?? 'USD'}
                  />
                }
              />
              {items.map((receipt, index) => (
                <div key={receipt.id}>
                  {index > 0 && <RowRule />}
                  <ReceiptRow receipt={receipt} when="time" claim={claim} onClaimed={setClaimed} />
                </div>
              ))}
            </section>
          ))}

          {days.length === 0 && (
            <p className="px-5 py-14 text-center text-[15px] font-medium text-[#8B95A1]">
              {filter === 'saved' ? t('Nothing came in under yet') : t('Nothing came in over yet')}
            </p>
          )}

          {hasNextPage && filter === 'all' && (
            <div className="px-5 pt-5 pb-[30px]">
              <Button variant="ghost" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                {isFetchingNextPage ? t('Loading…') : t('Show older receipts')}
              </Button>
            </div>
          )}
        </>
      )}

      {claimed !== null && <ClaimSuccessModal points={claimed} onClose={() => setClaimed(null)} />}
    </div>
  );
}

/**
 * Which side of the market a receipt came down on.
 *
 * Read from `comparison` rather than recomputed: the number on the row and the
 * number this filters by have to be the same one, or a receipt shows a green
 * chip and then fails to appear under "cheaper".
 */
function matches(receipt: ReceiptListItem, filter: Filter): boolean {
  if (filter === 'all') return true;
  const amount = receipt.comparison?.amount ?? null;
  if (amount === null || Math.round(amount) === 0) return false;
  return filter === 'saved' ? amount > 0 : amount < 0;
}

function Empty() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center px-10 pt-24 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-[#F2F4F6] text-[#B0B8C1]">
        <ReceiptIcon />
      </span>
      <p className="mt-5 text-[19px] font-bold tracking-[-.03em]">{t('No receipts yet')}</p>
    </div>
  );
}

export default Receipts;
