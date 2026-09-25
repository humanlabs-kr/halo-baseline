import { useMemo, useState } from 'react';
import { Drawer } from 'vaul';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useConnection, useWriteContract } from 'wagmi';
import { POINT_CLAIM_ABI } from '@halo/contracts';
import { ApiRequestError } from '@/lib/api/client';
import {
  applyForRaffle,
  type RafflePool,
  type RaffleApplyErrorCode,
} from '@/lib/api/raffle';
import { Button } from '@/components/ui/Button';
import { CloseIcon, MinusIcon, PlusIcon } from '@/components/ui/icons';
import { pointStatQueryKey, rafflePoolsQueryKey, usePointStat } from '@/lib/api/queries';
import { REWARD_CURRENCY } from '@/lib/constants';
import { getSafeAreaInsetBottom } from '@/lib/safe-area';
import { PLATFORM_CHAIN } from '@/lib/wagmi';
import { useAuthStore } from '@/stores/auth';
import { useFormatters } from '@/lib/format';

/**
 * Keyed by the full code union so a new server code fails the build here
 * rather than falling through to the generic message at runtime.
 *
 * The values are i18n keys as well as the English copy — natural-language keys
 * (see `lib/i18n`), so they are looked up with `t()` at the toast call site and
 * fall back to exactly this English when a locale has not translated them.
 */
const ENTRY_ERRORS: Record<RaffleApplyErrorCode, string> = {
  RAFFLE_POOL_NOT_FOUND: 'Raffle pool not found',
  MAX_ENTRIES_PER_USER_REACHED: 'Maximum entries per user reached',
  INSUFFICIENT_POINT: 'Insufficient points',
  CHAIN_MISMATCH: 'This wallet belongs to a different chain',
  EMAIL_NOT_VERIFIED: 'Please verify your email first',
  INTERNAL_ERROR: 'Something went wrong. Please try again',
};

/** Looked up by `code`, never by message text — copy is free to change. */
function entryErrorMessage(error: Error): string {
  const codes: Partial<Record<string, string>> = ENTRY_ERRORS;
  const code = error instanceof ApiRequestError ? error.code : null;
  return (code === null ? undefined : codes[code]) ?? 'Failed to enter raffle';
}

/**
 * Buy entries into one raffle pool.
 *
 * Entry is recorded off-chain on every chain. Where the API also returns a
 * spend signature, the same points are burned on-chain and the user signs a
 * second time — the off-chain entry already counts at that point, so a
 * rejected transaction is reported as "will retry", not as a failure.
 */
export default function RaffleEntrySheet({
  open,
  onClose,
  pool,
}: {
  open: boolean;
  onClose: () => void;
  pool: RafflePool;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const platform = useAuthStore((s) => s.platform);
  const queryClient = useQueryClient();
  const { address } = useConnection();
  const { data: pointStat } = usePointStat();
  const { writeContractAsync } = useWriteContract();

  const currentPoints = pointStat?.currentPoint ?? 0;
  const currency = platform ? REWARD_CURRENCY[platform] : '';
  // The sheet is anchored to the bottom edge, so its own padding is all that
  // keeps the confirm button clear of the home indicator.
  const bottomInset = getSafeAreaInsetBottom();

  const [entryCount, setEntryCount] = useState('0');
  const [isSettling, setIsSettling] = useState(false);

  const maxEntriesByPoints =
    pool.pointPerEntry > 0 ? Math.floor(currentPoints / pool.pointPerEntry) : 0;
  const maxEntries =
    pool.maxEntriesPerUser === -1
      ? maxEntriesByPoints
      : Math.min(pool.maxEntriesPerUser - pool.userEntryCount, maxEntriesByPoints);
  const remainingEntriesToday =
    pool.maxEntriesPerUser === -1
      ? Infinity
      : Math.max(0, pool.maxEntriesPerUser - pool.userEntryCount);

  const entryCountNum = Number.parseInt(entryCount, 10) || 0;
  const totalPointsToUse = useMemo(
    () => entryCountNum * pool.pointPerEntry,
    [entryCountNum, pool.pointPerEntry],
  );

  const isValidEntryCount =
    entryCountNum > 0 &&
    entryCountNum <= maxEntries &&
    entryCountNum <= remainingEntriesToday &&
    totalPointsToUse <= currentPoints;

  const applyMutation = useMutation({
    mutationFn: (entry: { rafflePoolId: string; entryCount: number }) => {
      if (!platform) throw new Error('No platform');
      return applyForRaffle(platform, entry);
    },
    onSuccess: async ({ spendSignature }) => {
      void queryClient.refetchQueries({ queryKey: pointStatQueryKey() });
      void queryClient.refetchQueries({ queryKey: rafflePoolsQueryKey() });

      if (spendSignature && address && platform) {
        setIsSettling(true);
        try {
          await writeContractAsync({
            address: spendSignature.contractAddress as `0x${string}`,
            abi: POINT_CLAIM_ABI,
            functionName: 'spendPoints',
            args: [
              BigInt(spendSignature.amount),
              spendSignature.spendIdBytes32 as `0x${string}`,
              BigInt(spendSignature.deadline),
              spendSignature.signature as `0x${string}`,
            ],
            chain: PLATFORM_CHAIN[platform],
            account: address,
          });
          toast.success(t('Successfully entered the raffle!'));
        } catch {
          toast.success(t('Raffle entry recorded. On-chain sync will retry later.'));
        } finally {
          setIsSettling(false);
        }
      } else {
        toast.success(t('Successfully entered the raffle!'));
      }

      setEntryCount('0');
      onClose();
    },
    onError: (error) => {
      toast.error(t(entryErrorMessage(error)));
    },
  });

  const isProcessing = applyMutation.isPending || isSettling;

  const validationMessage = (() => {
    if (isValidEntryCount || entryCountNum === 0) return null;
    if (entryCountNum > maxEntries)
      return t('Maximum {{max}} entries allowed', { max: maxEntries });
    if (entryCountNum > remainingEntriesToday)
      return t('Only {{remaining}} entries remaining today', {
        remaining: remainingEntriesToday,
      });
    if (totalPointsToUse > currentPoints) return t('Insufficient points');
    return null;
  })();

  const setCount = (value: number) => setEntryCount(String(Math.max(0, value)));

  return (
    <Drawer.Root open={open} onOpenChange={onClose} modal>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-[#191F28]/60" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-[20px] bg-white text-[#191F28] shadow-[0_-8px_40px_rgba(25,31,40,.22)]"
          style={{ paddingBottom: `calc(1.5rem + ${bottomInset}px)` }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-[#E5E8EB]" />
          <div className="px-5 py-5">
            <div className="mb-6 flex items-start justify-between">
              <div>
                <h2 className="text-[20px] font-extrabold tracking-[-.035em]">
                  {t('Enter Raffle')}
                </h2>
                <p className="mt-1 text-[13px] font-medium text-[#8B95A1]">
                  {fmt.amount(pool.amount)} {currency}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="pressed -mt-1 -mr-2 p-2 text-[#8B95A1]"
                aria-label={t('Close')}
              >
                <CloseIcon />
              </button>
            </div>

            <div className="space-y-6">
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-[14px] font-bold tracking-[-.02em]">
                    {t('Entry Count')}
                  </label>
                  <button
                    type="button"
                    onClick={() => setCount(maxEntries)}
                    className="pressed text-[13px] font-bold text-[#4E5968] underline underline-offset-2"
                  >
                    {t('Max ({{max}})', { max: maxEntries })}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCount(entryCountNum - 1)}
                    disabled={entryCountNum <= 1}
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] bg-[#F2F4F6] text-[#4E5968] transition-transform active:scale-[.95] disabled:opacity-40"
                    aria-label={t('Decrease entry count')}
                  >
                    <MinusIcon />
                  </button>

                  <div className="relative flex-1">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={entryCount}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value === '' || /^\d+$/.test(value)) setEntryCount(value);
                      }}
                      className="w-full rounded-[14px] border border-[#E5E8EB] bg-white px-4 py-3.5 text-center text-[17px] font-bold tabular-nums tracking-[-.03em] transition-colors focus:border-[#191F28] focus:outline-none"
                      placeholder="0"
                    />
                    <div className="absolute top-1/2 right-4 -translate-y-1/2 text-[13px] font-medium text-[#8B95A1]">
                      {t('entries')}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setCount(Math.min(entryCountNum + 1, maxEntries))}
                    disabled={entryCountNum >= maxEntries}
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] bg-[#F2F4F6] text-[#4E5968] transition-transform active:scale-[.95] disabled:opacity-40"
                    aria-label={t('Increase entry count')}
                  >
                    <PlusIcon />
                  </button>
                </div>
                {validationMessage && (
                  <p className="mt-2 text-[13px] font-medium text-[#F04452]">
                    {validationMessage}
                  </p>
                )}
              </div>

              <div className="rounded-[14px] bg-[#F2F4F6] p-4">
                <div className="space-y-2 text-[14px]">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-[#8B95A1]">{t('Current entries')}</span>
                    <span className="font-bold tabular-nums">{pool.userEntryCount}</span>
                  </div>
                  {pool.maxEntriesPerUser !== -1 && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-[#8B95A1]">
                          {t('Max entries per day')}
                        </span>
                        <span className="font-bold tabular-nums">{pool.maxEntriesPerUser}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-[#8B95A1]">
                          {t('Remaining entries today')}
                        </span>
                        <span className="font-bold tabular-nums">{remainingEntriesToday}</span>
                      </div>
                    </>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-[#8B95A1]">{t('Points per entry')}</span>
                    <span className="font-bold tabular-nums">
                      {t('{{points}} pts', { points: pool.pointPerEntry })}
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-medium text-[#8B95A1]">
                    {t('Total points to use')}
                  </span>
                  <span className="text-[17px] font-bold tabular-nums tracking-[-.03em]">
                    {t('{{points}} pts', { points: fmt.number(totalPointsToUse) })}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-medium text-[#8B95A1]">
                    {t('Current points available')}
                  </span>
                  <span className="text-[17px] font-bold tabular-nums tracking-[-.03em]">
                    {t('{{points}} pts', { points: fmt.number(currentPoints) })}
                  </span>
                </div>
                {totalPointsToUse > 0 && (
                  <div className="flex items-center justify-between border-t border-[#E5E8EB] pt-3">
                    <span className="text-[14px] font-bold tracking-[-.02em]">
                      {t('Points after purchase')}
                    </span>
                    <span className="text-[17px] font-bold tabular-nums tracking-[-.03em]">
                      {t('{{points}} pts', {
                        points: fmt.number(currentPoints - totalPointsToUse),
                      })}
                    </span>
                  </div>
                )}
              </div>

              <Button
                disabled={!isValidEntryCount || isProcessing}
                onClick={() => {
                  applyMutation.mutate({ rafflePoolId: pool.id, entryCount: entryCountNum });
                }}
              >
                {isSettling
                  ? t('Confirming on-chain…')
                  : isProcessing
                    ? t('Processing…')
                    : t('Buy Raffle')}
              </Button>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
