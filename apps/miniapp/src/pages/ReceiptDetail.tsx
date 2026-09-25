import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Amount, useMoneyText } from '@/components/ledger/Amount';
import { TopBar } from '@/components/ledger/TopBar';
import { GroupHead, Row, RowRule } from '@/components/ui/Row';
import { Slip, SlipLine, SlipTotal } from '@/components/ui/Slip';
import { Chip } from '@/components/ui/Chip';
import { unitEach } from '@/lib/basket';
import { useReceipt } from '@/lib/api/queries';
import { useFormatters } from '@/lib/format';
import { receiptApi, type ReceiptDetail as Detail, type ReceiptLine } from '@/lib/api/receipt';
import { rejectionCopy } from '@/lib/rejection';

/**
 * One receipt, as paper and as data, on the same screen.
 *
 * This is where a number anywhere else in the app can be checked. The slip at
 * the top is what we read; the photo below it is what we read from. Somebody
 * who thinks the ledger is wrong about their rice can get here in two taps and
 * see both, and that is the only reason to believe the rest of the app.
 *
 * Built from the same pieces as the scan result, deliberately. The two screens
 * show the same receipt minutes and weeks apart, and this one had been left on
 * the old chrome — beige paper, a monospaced TOTAL, a rotated CLAIMED stamp
 * and a drawn barcode — so a shopper who scanned on Tuesday and came back on
 * Friday found the same receipt in a different app.
 */
function ReceiptDetail() {
  const { t } = useTranslation();
  const { receiptId } = useParams<{ receiptId: string }>();
  const { data: receipt, isPending, isError } = useReceipt(receiptId);
  const fmt = useFormatters();
  const money = useMoneyText();

  if (isPending || isError || !receipt) {
    return (
      <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
        <TopBar title={t('Receipt')} back fallback="/receipts" />
        <p className="px-5 py-10 text-[15px] font-medium text-[#8B95A1]">
          {isError ? t('We could not open that one.') : t('Loading…')}
        </p>
      </div>
    );
  }

  const currency = receipt.currency ?? 'USD';
  const scan = receipt.images[0];
  const matched = receipt.lineItems.filter((line) => line.category !== null).length;

  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      <TopBar title={t('Receipt')} back fallback="/receipts" />

      {receipt.lineItems.length > 0 ? (
        <>
          <GroupHead
            title={receipt.merchantName ?? t('Unnamed shop')}
            trailing={receipt.issuedAt ? fmt.receiptStamp(receipt.issuedAt) : undefined}
          />
          <div className="px-5 pb-3.5">
            <Slip>
              {receipt.lineItems.map((line, index) => (
                <SlipLine
                  key={`${line.rawText}-${index}`}
                  name={line.rawText}
                  price={
                    line.lineTotal === null ? (
                      '—'
                    ) : (
                      <Amount value={line.lineTotal} currency={currency} />
                    )
                  }
                  unit={
                    line.unitPrice === null || line.priceUnit === null
                      ? undefined
                      : `${unitEach(line.priceUnit, t)} ${money(line.unitPrice, currency)}`
                  }
                  verdict={lineVerdict(line, currency, t, money)}
                  tone={lineTone(line)}
                />
              ))}
              {receipt.totalAmount !== null && (
                <SlipTotal
                  label={t('TOTAL')}
                  amount={<Amount value={Number(receipt.totalAmount)} currency={currency} />}
                />
              )}
            </Slip>
          </div>
        </>
      ) : (
        <Summary receipt={receipt} currency={currency} />
      )}

      <GroupHead title={t('What we did with it')} />

      {receipt.lineItems.length > 0 && (
        <>
          <Row
            title={t('Lines placed in your basket')}
            right={
              <b className="text-[16px] font-bold tabular-nums tracking-[-.03em]">
                {t('{{matched}} of {{total}}', { matched, total: receipt.lineItems.length })}
              </b>
            }
          />
          <RowRule inset={false} />
        </>
      )}

      <Row
        title={t('Points')}
        right={
          receipt.assignedPoint > 0 ? (
            <b className="text-[16px] font-bold tabular-nums text-[#00A06A]">
              +{t('{{points}}P', { points: receipt.assignedPoint })}
            </b>
          ) : (
            <span className="text-[16px] font-bold text-[#B0B8C1]">—</span>
          )
        }
      />

      {receipt.paymentMethod && (
        <>
          <RowRule inset={false} />
          <Row
            title={t('Paid with')}
            right={
              <span className="text-[15px] font-medium text-[#8B95A1]">
                {receipt.paymentMethod}
              </span>
            }
          />
        </>
      )}

      <RowRule inset={false} />
      <Row
        title={t('Scanned')}
        right={
          <span className="text-[15px] font-medium tabular-nums text-[#8B95A1]">
            {fmt.dateTime(receipt.createdAt)}
          </span>
        }
      />

      {scan && (
        <>
          <GroupHead title={t('The photo you sent')} />
          <div className="px-5">
            {/* Capped and cropped from the top. A receipt photographed
                end to end is several screens tall at full width, and the part
                that identifies it — shop, date, first lines — is at the top.
                Everything we read off the rest is already printed above. */}
            <img
              src={receiptApi.imageUrl(receipt.id, scan.id)}
              alt=""
              className="max-h-[380px] w-full rounded-[18px] bg-[#F2F4F6] object-cover object-top"
            />
          </div>
        </>
      )}

      <div className="h-6" />
    </div>
  );
}

/**
 * What one line came to against the going rate.
 *
 * The same sentence the scan result prints, because it is the same fact about
 * the same line — a shopper who reads "남들보다 320원 싸요" on Tuesday should
 * find it unchanged when they come back for it.
 */
function lineVerdict(
  line: ReceiptLine,
  currency: string,
  t: ReturnType<typeof useTranslation>['t'],
  money: (value: number, currency: string) => string,
) {
  if (line.unitPrice === null || line.marketUnitPrice === null) return undefined;

  const gap = line.marketUnitPrice - line.unitPrice;
  if (Math.round(gap) === 0) return t('About what others pay');

  return gap > 0
    ? t('{{amount}} cheaper than most', { amount: money(Math.abs(gap), currency) })
    : t('{{amount}} dearer than most', { amount: money(Math.abs(gap), currency) });
}

function lineTone(line: ReceiptLine) {
  if (line.unitPrice === null || line.marketUnitPrice === null) return 'neutral' as const;
  const gap = line.marketUnitPrice - line.unitPrice;
  if (Math.round(gap) === 0) return 'neutral' as const;
  return gap > 0 ? ('saved' as const) : ('over' as const);
}

/**
 * The header for a receipt with no lines.
 *
 * Two kinds land here: one scanned before we started reading items, and one we
 * could not read at all. Neither gets a printed slip, because an empty slip
 * with a TOTAL line looks like a receipt for nothing.
 */
function Summary({ receipt, currency }: { receipt: Detail; currency: string }) {
  const { t } = useTranslation();
  // Three states reach here, and a receipt still in the queue is one of them.
  // It has no merchant, no total and no lines yet, and the previous version
  // rendered that as the bare words "Unnamed shop" — while the list two taps
  // away described the same receipt as "Reading it now".
  if (receipt.status === 'pending') {
    return (
      <div className="px-5 pt-3">
        <p className="text-[19px] font-bold tracking-[-.03em]">{t('Reading it now')}</p>
        <p className="mt-2 break-keep text-[15px] leading-[1.5] font-medium text-[#8B95A1]">
          {t('The items will appear here in a moment.')}
        </p>
      </div>
    );
  }

  const unread = receipt.status === 'rejected' || receipt.status === 'rejected-claimed';
  const reason = rejectionCopy(receipt.rejectionReason, t);

  return (
    <div className="px-5 pt-3">
      {unread ? (
        <>
          <Chip tone="over">{t('Not counted')}</Chip>
          <p className="mt-2.5 break-keep text-[19px] leading-[1.3] font-bold tracking-[-.03em]">
            {reason.title}
          </p>
          <p className="mt-2 break-keep text-[15px] leading-[1.5] font-medium text-[#8B95A1]">
            {reason.advice}
          </p>
        </>
      ) : (
        <>
          <p className="text-[19px] leading-[1.3] font-bold tracking-[-.03em]">
            {receipt.merchantName ?? t('Unnamed shop')}
          </p>
          {receipt.totalAmount !== null && (
            <Amount
              value={Number(receipt.totalAmount)}
              currency={currency}
              className="mt-1 block text-[34px] font-extrabold leading-[1.1] tracking-[-.045em]"
            />
          )}
        </>
      )}
    </div>
  );
}

export default ReceiptDetail;
