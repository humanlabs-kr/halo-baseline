import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import dayjs from 'dayjs';
import { useFormatters } from '@/lib/format';
import utc from 'dayjs/plugin/utc';
import { TopBar } from '@/components/ledger/TopBar';
import RaffleCountdownCard from '@/components/RaffleCountdownCard';
import RaffleEntrySheet from '@/components/RaffleEntrySheet';
import { Chip } from '@/components/ui/Chip';
import { GroupHead, Row, RowRule } from '@/components/ui/Row';
import { RefreshIcon, TicketIcon } from '@/components/ui/icons';
import { useRafflePools, useRaffleStats } from '@/lib/api/queries';
import { type RafflePool } from '@/lib/api/raffle';
import { platformFeatures, REWARD_CURRENCY } from '@/lib/constants';
import { sendLightImpactHaptic } from '@/lib/haptic';
import { useAuthStore } from '@/stores/auth';
import { useEmailVerificationStore } from '@/stores/emailVerification';

// Retained for UTC arithmetic only — the round closes at UTC midnight and the
// countdown below is a difference, not a formatted date.
dayjs.extend(utc);

function Raffle() {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const platform = useAuthStore((s) => s.platform);
  const { isVerified, checkStatus } = useEmailVerificationStore();
  const needsVerifiedEmail = platformFeatures(platform).raffleNeedsVerifiedEmail;

  const [remainingMs, setRemainingMs] = useState(0);
  const [selectedPool, setSelectedPool] = useState<RafflePool | null>(null);

  const {
    data: pools,
    isLoading: isPoolsLoading,
    isFetching: isPoolsFetching,
    refetch: refetchPools,
  } = useRafflePools(platform);

  // Lifetime payout totals across all chains. Public endpoint, no auth.
  const { data: stats } = useRaffleStats();

  useEffect(() => {
    if (platform && needsVerifiedEmail) void checkStatus(platform);
  }, [checkStatus, needsVerifiedEmail, platform]);

  // Rounds close at UTC midnight.
  useEffect(() => {
    const tick = () => {
      const nowUTC = dayjs().utc();
      setRemainingMs(nowUTC.add(1, 'day').startOf('day').diff(nowUTC));
    };
    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const countdown = useMemo(() => {
    const pad = (value: number) => String(value).padStart(2, '0');
    return {
      hours: pad(Math.floor(remainingMs / 3_600_000)),
      minutes: pad(Math.floor((remainingMs % 3_600_000) / 60_000)),
      seconds: pad(Math.floor((remainingMs % 60_000) / 1000)),
    };
  }, [remainingMs]);

  // No haptic here: `Row` fires one for a tap on the row body, and the entry
  // pill fires its own, so firing a third from the shared handler would buzz
  // twice on every path into this function.
  const handleRaffleEnter = (pool: RafflePool) => {
    if (pool.isClosed) return;

    // Chains we pay out ourselves need a reachable address, and their entry
    // endpoint rejects an unverified one with EMAIL_NOT_VERIFIED. World's does
    // not — winners there claim through a Drop link — so asking for an email
    // first would block an entry the server would have accepted.
    if (needsVerifiedEmail && !isVerified) {
      navigate('/verify-email?returnTo=/rewards');
      return;
    }
    setSelectedPool(pool);
  };

  const handleEntrySheetClose = () => {
    setSelectedPool(null);
    void queryClient.invalidateQueries({ queryKey: ['raffle', 'pools', platform] });
  };

  return (
    <div className="flex min-h-full flex-col bg-white pb-4 text-[#191F28]">
      {/* Titled for what it is. It used to carry the same "Rewards" title as
          the tab that links to it, so tapping through from rewards landed the
          user on
          a second screen with the first one's name and no way back. */}
      <TopBar title={t('Daily draw')} back fallback="/rewards" />

      <section className="px-5 pt-2">
        <RaffleCountdownCard {...countdown} />
      </section>

      {stats && stats.totalPrizesAwarded > 0 && (
        <section className="px-5 pt-2.5">
          <button
            type="button"
            className="pressed w-full rounded-[18px] bg-[#F0FAF6] px-[18px] py-4 text-left"
            onClick={() => {
              sendLightImpactHaptic();
              navigate('/payouts');
            }}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[13px] font-medium text-[#8B95A1]">
                  {t('Total prizes awarded')}
                </p>
                <p className="mt-0.5 text-[22px] font-extrabold tabular-nums tracking-[-.04em] text-[#00A06A]">
                  ${fmt.number(stats.totalPrizesAwarded, { maximumFractionDigits: 0 })}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[13px] font-medium text-[#8B95A1]">{t('Winners')}</p>
                <p className="mt-0.5 text-[22px] font-extrabold tabular-nums tracking-[-.04em] text-[#00A06A]">
                  {fmt.number(stats.totalPrizesAwardedCount)}
                </p>
              </div>
            </div>
            <div className="mt-2.5 flex items-center justify-center gap-1 text-[13px] font-medium text-[#00A06A]">
              <span>{t('View all payouts')}</span>
              <svg
                viewBox="0 0 20 20"
                aria-hidden
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-3 w-3"
              >
                <path d="M8 5l5 5-5 5" />
              </svg>
            </div>
          </button>
        </section>
      )}

      <GroupHead
        title={t('L-65bazsbh')}
        trailing={
          <span className="flex items-center gap-3">
            {/* Was the whole heading, with a chevron image. A heading that is
                secretly a link is not discoverable, and the arrow pointed at
                the refresh control sitting next to it. */}
            <button
              type="button"
              className="pressed font-medium"
              onClick={() => {
                sendLightImpactHaptic();
                navigate('/raffle-history');
              }}
            >
              {t('More')}
            </button>
            <button
              type="button"
              onClick={() => {
                sendLightImpactHaptic();
                void refetchPools();
              }}
              disabled={isPoolsFetching}
              className={`-my-1 flex h-7 w-7 items-center justify-center rounded-[10px] bg-[#F2F4F6] text-[#4E5968] transition-colors active:bg-[#E5E8EB] ${
                isPoolsFetching ? 'animate-spin' : ''
              }`}
              aria-label={t('Refresh raffles')}
            >
              <RefreshIcon />
            </button>
          </span>
        }
      />
      <p className="-mt-1.5 px-5 pb-2.5 break-keep text-[13px] font-medium text-[#8B95A1]">
        {t('A new set of pools opens every day.')}
      </p>

      {isPoolsLoading ? (
        <div className="space-y-2.5 px-5 pt-1">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-[72px] animate-pulse rounded-[18px] bg-[#F2F4F6]" />
          ))}
        </div>
      ) : pools && pools.length > 0 ? (
        pools.map((pool, index) => (
          <div key={pool.id}>
            {index > 0 && <RowRule />}
            <RafflePoolRow
              pool={pool}
              currency={platform ? REWARD_CURRENCY[platform] : ''}
              onEnter={() => handleRaffleEnter(pool)}
            />
          </div>
        ))
      ) : (
        <p className="px-5 py-10 text-[15px] font-medium text-[#8B95A1]">
          {t('No raffle pools available today')}
        </p>
      )}

      {selectedPool && (
        <RaffleEntrySheet open onClose={handleEntrySheetClose} pool={selectedPool} />
      )}
    </div>
  );
}

function RafflePoolRow({
  pool,
  currency,
  onEnter,
}: {
  pool: RafflePool;
  currency: string;
  onEnter: () => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();

  return (
    <Row
      icon={<TicketIcon />}
      dim={pool.isClosed}
      title={`${fmt.amount(pool.amount)} ${currency}`}
      caption={
        <>
          <span className="block">
            {t('Use {{count}} pts', { count: pool.pointPerEntry })}
            {' · '}
            {pool.maxEntriesPerUser === -1
              ? t('Unlimited entries')
              : t('Max {{count}} a day', { count: pool.maxEntriesPerUser })}
          </span>
          <span className="block">
            {t('Mine:')}{' '}
            <b className="font-bold tabular-nums text-[#4E5968]">
              {fmt.number(pool.userEntryCount)}
            </b>
            {' · '}
            {t('Total:')}{' '}
            <b className="font-bold tabular-nums text-[#4E5968]">
              {fmt.number(pool.totalEntryCount)}
            </b>
          </span>
        </>
      }
      right={pool.isClosed ? <Chip size="sm">{t('L-Qz7oUkLD')}</Chip> : undefined}
      onClick={pool.isClosed ? undefined : onEnter}
      action={
        pool.isClosed ? undefined : (
          <button
            type="button"
            className="shrink-0 rounded-full bg-[#191F28] px-3.5 py-1.5 text-[12px] font-bold text-white transition-transform active:scale-95"
            onClick={() => {
              sendLightImpactHaptic();
              onEnter();
            }}
          >
            {t('L-TBJ2APz1')}
          </button>
        )
      }
    />
  );
}

export default Raffle;
