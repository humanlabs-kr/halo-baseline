import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Amount, useMoneyText } from './Amount';
import { Chip } from '@/components/ui/Chip';
import { Row } from '@/components/ui/Row';
import { ReceiptIcon } from '@/components/ui/icons';
import { rejectionCopy } from '@/lib/rejection';
import { useClaimFeedback, type PointClaim } from '@/hooks/usePointClaim';
import { useFormatters } from '@/lib/format';
import type { TFunction } from 'i18next';
import type { ReceiptListItem } from '@/lib/api/receipt';

function rejected(receipt: ReceiptListItem): boolean {
  return receipt.status === 'rejected' || receipt.status === 'rejected-claimed';
}

/**
 * One receipt in a list, wherever the list is.
 *
 * Shared because the ledger shows the most recent few and the receipts page
 * shows all of them, and the two were describing the same rows differently —
 * a rejected scan was "Unread receipt" on one screen and "Could not read it"
 * on the other. Two names for one thing in one app reads as two things.
 */
export function ReceiptRow({
  receipt,
  when,
  claim,
  onClaimed,
}: {
  receipt: ReceiptListItem;
  when: 'date' | 'time';
  /**
   * Passed only where claiming happens one receipt at a time — Celo signs a
   * transaction per receipt, so there is no "claim everything" to put on the
   * rewards tab, and this row is the only place the action can live.
   */
  claim?: PointClaim;
  onClaimed?: (points: number) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fmt = useFormatters();
  const report = useClaimFeedback((points) => onClaimed?.(points));

  // The clock on the paper, not the clock on our server. `issuedAt` is a wall
  // reading stored as UTC, so it is read back as one; a receipt with no
  // readable date falls back to when it arrived, which is a real instant and
  // belongs in the reader's own zone.
  const stamp =
    receipt.issuedAt === null
      ? when === 'time'
        ? fmt.time(receipt.createdAt)
        : fmt.date(receipt.createdAt)
      : when === 'time'
        ? fmt.receiptTime(receipt.issuedAt)
        : fmt.receiptDay(receipt.issuedAt);
  const claimable =
    claim?.mode === 'per-receipt' &&
    (receipt.status === 'claimable' || receipt.status === 'rejected');

  return (
    <Row
      icon={<ReceiptIcon />}
      dim={rejected(receipt)}
      title={title(receipt, t)}
      caption={subtitle(receipt, stamp, t)}
      onClick={() => navigate(`/receipts/${receipt.id}`)}
      right={
        <>
          {receipt.totalAmount !== null && (
            <b className="block text-[16px] font-bold tracking-[-.03em]">
              <Amount value={Number(receipt.totalAmount)} currency={receipt.currency ?? 'USD'} />
            </b>
          )}
          {/* The verdict, not the points. A receipts list is a list of
              purchases and the thing a shopper scans it for is which ones
              they got cheap — the points are on the rewards tab. */}
          {!claimable && !rejected(receipt) && (
            <div className="mt-[5px]">
              <Verdict comparison={receipt.comparison} currency={receipt.currency ?? 'USD'} />
            </div>
          )}
        </>
      }
      action={
        claimable ? (
          <button
            type="button"
            disabled={claim.isPending}
            onClick={() => void claim.claimReceipt(receipt.id).then(report)}
            className="shrink-0 rounded-full bg-[#191F28] px-3.5 py-1.5 text-[12px] font-bold text-white transition-transform active:scale-95 disabled:opacity-50"
          >
            {claim.isPending ? '…' : t('Claim {{points}}P', { points: receipt.assignedPoint })}
          </button>
        ) : undefined
      }
    />
  );
}

/**
 * What this receipt came to, against everybody else's prices.
 *
 * "No comparison yet" is a first-class answer rather than a blank. Most
 * receipts outside the seeded corpus land there, and a row that simply omits
 * the chip reads as a bug — the shopper cannot tell "we checked and you were
 * average" from "we could not check".
 */
function Verdict({
  comparison,
  currency,
}: {
  comparison: { amount: number; lines: number } | null;
  currency: string;
}) {
  const { t } = useTranslation();
  const money = useMoneyText();

  if (comparison === null) return <Chip size="sm">{t('Nothing to compare')}</Chip>;

  const amount = Math.round(comparison.amount);
  if (amount === 0) return <Chip size="sm">{t('About average')}</Chip>;

  return (
    <Chip size="sm" tone={amount > 0 ? 'saved' : 'over'}>
      {amount > 0
        ? t('Saved {{amount}}', { amount: money(amount, currency) })
        : t('Paid {{amount}} more', { amount: money(-amount, currency) })}
    </Chip>
  );
}

function title(receipt: ReceiptListItem, t: TFunction): string {
  if (receipt.status === 'pending') return t('Reading it now');
  // The reason, not the verdict. Both lines of this row used to say "Not
  // counted", which told the user twice what they could already see and never
  // once told them what to do about it.
  if (rejected(receipt)) return rejectionCopy(receipt.rejectionReason, t).title;
  return receipt.merchantName ?? t('Unnamed shop');
}

function subtitle(receipt: ReceiptListItem, stamp: string, t: TFunction): string {
  if (receipt.status === 'pending' || rejected(receipt)) return stamp;
  if (receipt.lineCount === 0) return stamp;
  return `${stamp} · ${t('{{count}} items', { count: receipt.lineCount })}`;
}
