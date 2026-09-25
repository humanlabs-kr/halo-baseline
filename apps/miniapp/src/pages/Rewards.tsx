import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  BASE_POINT_PER_RECEIPT,
  DAILY_CHECK_IN_POINTS,
  DAILY_ONCHAIN_BONUS_POINTS,
} from '@halo/contracts';
import ClaimSuccessModal from '@/components/ClaimSuccessModal';
import { Button } from '@/components/ui/Button';
import { GroupHead, Row, RowRule } from '@/components/ui/Row';
import { CalendarCheckIcon, CameraIcon, HistoryIcon, TicketIcon } from '@/components/ui/icons';
import { useClaimFeedback, usePointClaim } from '@/hooks/usePointClaim';
import { useDailyClaim } from '@/hooks/useDailyClaim';
import { usePointStat, useReceiptStat } from '@/lib/api/queries';
import { useFormatters } from '@/lib/format';
import { SCAN_LIMIT } from '@/lib/constants';

/**
 * Points: what you have, what is waiting, and the two ways to earn more.
 *
 * One card is reversed out in the product's near-black, and it is the balance
 * — the only thing on this screen that is money. An inversion does the work a
 * colour would have had to, which keeps green and red meaning what they mean
 * everywhere else in the app.
 */
function Rewards() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fmt = useFormatters();
  const { data: pointStat } = usePointStat();
  const { data: receiptStat } = useReceiptStat();
  const [claimed, setClaimed] = useState<number | null>(null);
  const claim = usePointClaim();
  const report = useClaimFeedback(setClaimed);
  const daily = useDailyClaim({
    onClaimed: setClaimed,
    onError: () => toast.error(t('Claim failed. Try logging out and back in.')),
  });

  const claimable = pointStat?.claimablePoint ?? 0;
  // A range, because the claim draws one. The row advertised "+10", which is
  // not an amount this has ever paid — the same mistake, in the same place,
  // that put `BASE_POINT_PER_RECEIPT` in `@halo/contracts`. On Celo the
  // second claim of the day is the richer on-chain one.
  const bonus = daily.state === 'bonus' ? DAILY_ONCHAIN_BONUS_POINTS : DAILY_CHECK_IN_POINTS;

  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      <header className="px-5 pt-[max(10px,env(safe-area-inset-top))] pb-4">
        <h1 className="text-[24px] font-extrabold tracking-[-.035em]">{t('L-42p9Zgx7')}</h1>
      </header>

      <section className="px-5">
        <div className="rounded-[18px] bg-[#191F28] px-5 py-[22px] text-white">
          <p className="text-[13.5px] font-semibold tracking-[-.02em] text-[#8B95A1]">
            {/* The balance, which is not the same thing as what is waiting to
                be claimed. Shown together they read as a contradiction — 0P
                over a button offering 45P — so the label says which is which. */}
            {t('Points you have')}
          </p>
          <p className="mt-1 text-[38px] font-extrabold tabular-nums tracking-[-.045em]">
            {t('{{points}}P', { points: fmt.number(pointStat?.currentPoint ?? 0) })}
          </p>
          {claimable > 0 && (
            <Button
              className="mt-4 !bg-white !text-[#191F28]"
              disabled={claim.isPending}
              onClick={() => {
                // Celo signs a transaction per receipt, so there is no "claim
                // everything" to offer — the button has to send them where the
                // per-receipt buttons are.
                if (claim.mode === 'per-receipt') {
                  navigate('/receipts');
                  return;
                }
                void claim.claimAll().then(report);
              }}
            >
              {claim.isPending ? t('Claiming…') : t('Claim {{points}}P', { points: claimable })}
            </Button>
          )}
        </div>
      </section>

      <GroupHead title={t('Earn points')} />
      <Row
        icon={<CameraIcon />}
        tone="saved"
        title={t('Scan a receipt')}
        caption={t('{{done}} of {{limit}} today', {
          // Clamped. A seeded wallet — and a day the limit moved — produced
          // "18 of 5 today", which reads as a broken counter rather than a
          // full quota.
          done: Math.min(receiptStat?.dailyScanCount ?? 0, SCAN_LIMIT.daily),
          limit: SCAN_LIMIT.daily,
        })}
        onClick={() => navigate('/camera-scan')}
        chevron={false}
        right={
          <b className="text-[16px] font-bold tabular-nums text-[#00A06A]">
            +{t('{{points}}P', { points: BASE_POINT_PER_RECEIPT })}
          </b>
        }
      />
      <RowRule />
      <Row
        icon={<CalendarCheckIcon />}
        tone="warm"
        title={t('Daily check-in')}
        caption={daily.state === 'done' ? t('Taken today') : t('Tap to take it')}
        onClick={daily.state === 'done' || daily.isPending ? undefined : daily.claim}
        chevron={false}
        right={
          <b className="text-[16px] font-bold tabular-nums text-[#00A06A]">
            {daily.isPending ? '…' : `+${t('{{min}}–{{max}}P', bonus)}`}
          </b>
        }
      />

      <GroupHead title={t('Use your points')} />
      <Row icon={<TicketIcon />} title={t('Daily draw')} caption={t('Spend points on entries')} onClick={() => navigate('/raffle')} />
      <RowRule />
      <Row icon={<HistoryIcon />} title={t('Point history')} onClick={() => navigate('/point-logs')} />

      {claimed !== null && <ClaimSuccessModal points={claimed} onClose={() => setClaimed(null)} />}
    </div>
  );
}

export default Rewards;
