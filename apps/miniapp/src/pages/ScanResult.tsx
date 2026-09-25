import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { Amount, countryName, useMoneyText } from '@/components/ledger/Amount';
import { TopBar } from '@/components/ledger/TopBar';
import { Button } from '@/components/ui/Button';
import { GroupHead, Row } from '@/components/ui/Row';
import { Slip as AppSlip, SlipLine, SlipTotal } from '@/components/ui/Slip';
import { DownIcon, EqualIcon, GiftIcon, UpIcon } from '@/components/ui/icons';
import { unitEach } from '@/lib/basket';
import {
  POLL_GIVES_UP_AFTER_MS,
  ledgerQueryKey,
  receiptsQueryKey,
  useMonth,
  useReceipt,
} from '@/lib/api/queries';
import { useFormatters } from '@/lib/format';
import { rejectionCopy } from '@/lib/rejection';
import {
  receiptApi,
  type ReceiptComparison,
  type ReceiptDetail,
  type ReceiptLine,
} from '@/lib/api/receipt';

/**
 * What happened to the receipt you just took a photo of.
 *
 * The screen the whole pivot is aimed at. Someone who has just scanned their
 * first receipt is holding the app open waiting for an answer, and the answer
 * has to be about their shopping — not about our processing. So the headline is
 * what they paid against what everyone else paid, and the points, which used to
 * be the entire product, are one line near the bottom.
 *
 * Analysis is asynchronous and takes a few seconds, so this screen exists in
 * three states and arrives in the first one.
 */
function ScanResult() {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const { receiptId } = useParams<{ receiptId: string }>();
  const navigate = useNavigate();
  const money = useMoneyText();
  const queryClient = useQueryClient();
  const { data: receipt, isPending, isError } = useReceipt(receiptId);
  const { data: month } = useMonth();

  // The ledger is built from receipts, so it is stale the moment one settles.
  // Keyed on the status rather than on mount: this screen opens while the
  // receipt is still `pending`, and refreshing then would re-read the same
  // pre-scan answer.
  const settled = receipt !== undefined && receipt.status !== 'pending';

  useEffect(() => {
    if (!settled) return;
    void queryClient.invalidateQueries({ queryKey: ledgerQueryKey() });
    void queryClient.invalidateQueries({ queryKey: receiptsQueryKey() });
  }, [settled, queryClient]);

  if (isError) {
    return (
      <div className="flex min-h-full flex-col bg-white px-5 pb-4 text-[#191F28]">
        <TopBar title={t('We lost track of that one')} back fallback="/ledger" />
        <p className="pt-2 text-[15px] font-medium leading-[1.5] text-[#8B95A1]">
          {t('It is still in your ledger. Open it from there.')}
        </p>
        <div className="mt-auto pb-[max(20px,env(safe-area-inset-bottom))]">
          <Button onClick={() => navigate('/ledger')}>{t('See my ledger')}</Button>
        </div>
      </div>
    );
  }

  if (isPending || receipt.status === 'pending') {
    return <Reading receipt={receipt} />;
  }

  const currency = receipt.currency ?? month?.spent.currency ?? 'USD';
  const rejected = receipt.status === 'rejected' || receipt.status === 'rejected-claimed';

  if (rejected) {
    const reason = rejectionCopy(receipt.rejectionReason, t);
    const scan = receipt.images[0];

    return (
      <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
        {/* Not "could not read it": three of the five reasons are about a
            receipt we read perfectly well. The list says "Not counted" for the
            same receipts, and the two screens should agree. */}
        <TopBar title={t('Not counted')} back fallback="/ledger" />
        <div className="flex gap-4 px-5 pt-2">
          {scan && (
            <img
              src={receiptApi.imageUrl(receipt.id, scan.id)}
              alt=""
              className="h-[150px] w-[95px] shrink-0 rounded-[14px] bg-[#F2F4F6] object-cover object-top"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="break-keep text-[19px] leading-[1.3] font-bold tracking-[-.03em]">
              {reason.title}
            </p>
            <p className="mt-2 break-keep text-[15px] leading-[1.5] font-medium text-[#8B95A1]">
              {reason.advice}
            </p>
          </div>
        </div>
        {receipt.assignedPoint > 0 && (
          <div className="px-5 pt-6">
            <Row
              icon={<GiftIcon />}
              tone="warm"
              title={t('{{points}} points added', { points: receipt.assignedPoint })}
              caption={t('Not added to your ledger.')}
            />
          </div>
        )}
        {/* Scanning again is the action; the ledger is where they already
            were. A rejected receipt is the one case where "do it over" is
            the useful primary. */}
        <div className="mt-auto px-5 pt-5 pb-[max(20px,env(safe-area-inset-bottom))]">
          <Button onClick={() => navigate('/camera-scan')}>{t('Scan another')}</Button>
          <div className="h-2.5" />
          <Button variant="ghost" onClick={() => navigate('/ledger')}>
            {t('See my ledger')}
          </Button>
        </div>
      </div>
    );
  }

  // First receipt ever reads differently from the forty-eighth: there is no
  // month to add to yet, so the screen leads with the thing that does exist.
  // Counted over the wallet's whole history, not the current month — the month
  // is by purchase date, and a receipt dated last month left it at zero.
  const first = receipt.receiptsEver <= 1;

  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      <TopBar title={first ? t('Your first receipt') : t('All read')} back fallback="/ledger" />

      {/* The verdict first and in one tinted card. It is the answer they are
          holding the phone open for; the paper below is the working. */}
      <div className="px-5 pt-1">
        <Verdict
          comparison={receipt.comparison}
          lines={receipt.lineItems.length}
          currency={currency}
          country={receipt.countryCode}
        />
      </div>

      <GroupHead
        title={receipt.merchantName ?? t('Unnamed shop')}
        trailing={receipt.issuedAt ? fmt.receiptStamp(receipt.issuedAt) : undefined}
      />

      <div className="px-5 pb-3.5">
        <AppSlip>
          {receipt.lineItems.map((line, index) => (
            <SlipLine
              key={`${line.rawText}-${index}`}
              name={line.rawText}
              price={line.lineTotal === null ? '—' : <Amount value={line.lineTotal} currency={currency} />}
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
        </AppSlip>
      </div>

      {receipt.assignedPoint > 0 && (
        <div className="px-5 pt-3">
          <Row
            icon={<GiftIcon />}
            tone="warm"
            title={t('{{points}} points added', { points: receipt.assignedPoint })}
            caption={t("That's {{count}} receipts so far", { count: receipt.receiptsEver })}
            chevron={false}
          />
        </div>
      )}

      <div className="mt-auto px-5 pt-5 pb-[max(20px,env(safe-area-inset-bottom))]">
        <Button onClick={() => navigate('/ledger')}>{t('See my ledger')}</Button>
        <div className="h-2.5" />
        <Button variant="ghost" onClick={() => navigate('/camera-scan')}>
          {t('Scan another')}
        </Button>
      </div>
    </div>
  );
}

/**
 * What one line came to against the going rate.
 *
 * On the line rather than only in the total, because a basket that nets to
 * nothing is not a basket where nothing happened — it is usually one item
 * well bought and one badly, and those are the two the shopper wants.
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
 * The sentence someone screenshots.
 *
 * Said in money, in one sentence, about them. A percentage against an index
 * would be the same fact and would not survive being read once on a phone.
 */
function Verdict({
  comparison,
  lines,
  currency,
  country,
}: {
  comparison: ReceiptComparison | null;
  lines: number;
  currency: string;
  country: string | null;
}) {
  const { t } = useTranslation();
  const money = useMoneyText();
  const fmt = useFormatters();

  const where = country ? countryName(country, fmt.lang) : '';

  const body =
    comparison === null ? (
      // Nothing on this receipt could be compared: no line cleared the three
      // bars, or the country has too few receipts to hold a price yet.
      <>{t('Nothing here to compare yet. Keep scanning and this fills in.')}</>
    ) : (
      <>
        <VerdictSentence
          amount={money(Math.abs(Math.round(comparison.amount)), currency)}
          country={where}
          cheaper={Math.round(comparison.amount) > 0}
          matched={Math.round(comparison.amount) !== 0}
        />
        {/* "Altogether" over two of eighteen lines is a claim about a
            basket we mostly did not price. The count is in the response and
            was going unused. */}
        {comparison.lines < lines && (
          <span className="mt-1 block text-[12.5px] text-[#B0B8C1]">
            {t('Based on {{matched}} of {{total}} items.', {
              matched: comparison.lines,
              total: lines,
            })}
          </span>
        )}
      </>
    );

  const cheaper = comparison !== null && Math.round(comparison.amount) > 0;
  const flat = comparison === null || Math.round(comparison.amount) === 0;

  return (
    <div
      className={`flex items-center gap-3.5 rounded-[18px] px-[18px] py-4 ${
        flat ? 'bg-[#F9FAFB]' : cheaper ? 'bg-[#F0FAF6]' : 'bg-[#FFF4F5]'
      }`}
    >
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] ${
          flat ? 'bg-[#F2F4F6] text-[#8B95A1]' : cheaper ? 'bg-[#E7F8F1] text-[#00A06A]' : 'bg-[#FFEBEE] text-[#F04452]'
        }`}
      >
        {flat ? <EqualIcon /> : cheaper ? <DownIcon /> : <UpIcon />}
      </span>
      <p className="min-w-0 flex-1 break-keep text-[17px] font-semibold leading-[1.4] tracking-[-.03em]">
        {body}
      </p>
    </div>
  );
}

/**
 * The verdict, as four literal keys.
 *
 * `i18nKey` has to be a plain string in the JSX. `check-locales` finds keys by
 * scanning for the attribute followed immediately by a quote, so a key
 * assembled in a ternary is invisible to it. These four were built that way
 * and slipped past the check into production, untranslated in every locale
 * while the checker reported OK.
 */
function VerdictSentence({
  amount,
  country,
  cheaper,
  matched,
}: {
  amount: string;
  country: string;
  cheaper: boolean;
  /** False when the basket came out exactly at the going rate. */
  matched: boolean;
}) {
  if (!matched) {
    return (
      <Trans
        i18nKey="You paid <0>the going rate</0> for this basket."
        components={[<b key="0" className="font-bold" />]}
      />
    );
  }

  const emphasis = [
    <b key="0" className={`font-bold ${cheaper ? 'text-[#00A06A]' : 'text-[#F04452]'}`} />,
  ];
  const values = { amount, country };

  if (cheaper) {
    return country === '' ? (
      <Trans i18nKey="Altogether you paid <0>{{amount}} less</0> than most people." values={values} components={emphasis} />
    ) : (
      <Trans i18nKey="Altogether you paid <0>{{amount}} less</0> than most people in {{country}}." values={values} components={emphasis} />
    );
  }

  return country === '' ? (
    <Trans i18nKey="Altogether you paid <0>{{amount}} more</0> than most people." values={values} components={emphasis} />
  ) : (
    <Trans i18nKey="Altogether you paid <0>{{amount}} more</0> than most people in {{country}}." values={values} components={emphasis} />
  );
}

/**
 * The wait, shown as the wait.
 *
 * The old flow put up a modal saying the receipt was queued for review and sent
 * the user away. Review is not what is happening — a machine is reading their
 * shopping — and the difference is worth a few seconds of their attention,
 * because what comes next is worth looking at.
 */
function Reading({ receipt }: { receipt: ReceiptDetail | undefined }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // The image row is written before the receipt is queued, so the photo is
  // available on the very first poll — there is no point in showing a spinner
  // over a blank screen when we can show them the thing they just took.
  const scan = receipt?.images[0];

  // `useReceipt` stops polling after two minutes on the grounds that a queue
  // which has not answered by then is stuck rather than slow. Without this the
  // screen never found out: it kept saying "takes a few seconds" at a receipt
  // nothing was still asking about, forever.
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setGaveUp(true), POLL_GIVES_UP_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      <TopBar back fallback="/ledger" />
      <div className="flex flex-1 flex-col items-center justify-center px-[22px] pb-10">
        {scan && receipt && (
          <div className="relative mb-7 h-[300px] w-[190px] overflow-hidden rounded-[18px] bg-[#F2F4F6]">
            <img
              src={receiptApi.imageUrl(receipt.id, scan.id)}
              alt=""
              className="h-full w-full object-cover object-top"
            />
            <div
              aria-hidden
              className="animate-sweep absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-transparent via-white/70 to-transparent"
            />
          </div>
        )}
        <p className="text-[21px] font-bold tracking-[-.03em]">
          {gaveUp ? t('Still working on it') : t('Reading your receipt')}
        </p>
        <p className="mt-[7px] break-keep text-center text-[15px] leading-[1.5] font-medium text-[#8B95A1]">
          {gaveUp
            ? t('It is safe in your ledger. Check back in a few minutes.')
            : t('Takes a few seconds.')}
        </p>
      </div>
      <div className="px-5 pb-[max(20px,env(safe-area-inset-bottom))]">
        <Button variant="ghost" onClick={() => navigate('/ledger')}>
          {t('See my ledger')}
        </Button>
      </div>
    </div>
  );
}

export default ScanResult;
