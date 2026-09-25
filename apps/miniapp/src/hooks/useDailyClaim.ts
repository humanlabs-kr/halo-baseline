import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConnection, useWriteContract } from 'wagmi';
import { POINT_CLAIM_ABI } from '@halo/contracts';
import { hasApiErrorCode } from '@/lib/api/client';
import { pointStatQueryKey, useClaimDailyPoint, useClaimDailyPointCelo } from '@/lib/api/queries';
import { sendSuccessNotificationHaptic } from '@/lib/haptic';
import { PLATFORM_CHAIN } from '@/lib/wagmi';
import { useAuthStore } from '@/stores/auth';

/**
 * The once-a-day point claim.
 *
 * Lifted out of the home screen when that screen was retired. The shape of it
 * is chain-specific and was worth preserving rather than rewriting: Celo mints
 * the same points on-chain as an optional second step, so the day has two
 * claims on that platform and one everywhere else.
 *
 * Whether today's claim already happened is remembered locally, keyed on the
 * UTC date. The server is the authority and answers `ALREADY_CLAIMED`, but
 * without the local note the button would offer a claim on every cold start
 * and only fail once pressed.
 */
const KEYS = {
  offchain: 'halo.dailyClaim',
  onchain: 'halo.dailyClaim.onchain',
} as const;

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function claimedToday(key: string): boolean {
  return localStorage.getItem(key) === todayUTC();
}

export type DailyClaimState =
  /** Today's points have not been taken. */
  | 'ready'
  /** Celo only: points taken, the on-chain mint is still on the table. */
  | 'bonus'
  /** Nothing left today. */
  | 'done';

export interface DailyClaim {
  state: DailyClaimState;
  isPending: boolean;
  /** Resolves when the claim settles; failures surface through `onError`. */
  claim: () => void;
}

export function useDailyClaim({
  onClaimed,
  onError,
}: {
  onClaimed: (points: number) => void;
  onError: () => void;
}): DailyClaim {
  const queryClient = useQueryClient();
  const platform = useAuthStore((s) => s.platform);
  const { address } = useConnection();
  const { mutateAsync: writeContract } = useWriteContract();

  const [offchainDone, setOffchainDone] = useState(() => claimedToday(KEYS.offchain));
  const [onchainDone, setOnchainDone] = useState(() => claimedToday(KEYS.onchain));

  const hasOnchainBonus = platform === 'celo';

  const settle = (key: string, mark: (done: boolean) => void) => (error: unknown) => {
    // Already claimed today is the expected answer after a reinstall or a
    // cleared cache, not a failure — record it locally and move on.
    if (hasApiErrorCode(error, 'ALREADY_CLAIMED')) {
      localStorage.setItem(key, todayUTC());
      mark(true);
      return;
    }
    onError();
  };

  const offchain = useClaimDailyPoint({
    onSuccess: (data) => {
      void queryClient.refetchQueries({ queryKey: pointStatQueryKey() });
      localStorage.setItem(KEYS.offchain, todayUTC());
      setOffchainDone(true);
      sendSuccessNotificationHaptic();
      onClaimed(data.claimedPoint);
    },
    onError: settle(KEYS.offchain, setOffchainDone),
  });

  const onchain = useClaimDailyPointCelo({
    onSuccess: async (data) => {
      if (!address) return;
      try {
        await writeContract({
          address: data.contractAddress as `0x${string}`,
          abi: POINT_CLAIM_ABI,
          functionName: 'claimPoints',
          args: [
            BigInt(data.claimedPoint),
            data.claimIdBytes32 as `0x${string}`,
            BigInt(data.deadline),
            data.signature as `0x${string}`,
          ],
          chain: PLATFORM_CHAIN.celo,
          account: address,
        });
        localStorage.setItem(KEYS.onchain, todayUTC());
        setOnchainDone(true);
        sendSuccessNotificationHaptic();
        onClaimed(data.claimedPoint);
      } catch {
        // Rejected in the wallet, or the transaction failed. The off-chain
        // points are already theirs either way, so there is nothing to undo.
      } finally {
        void queryClient.refetchQueries({ queryKey: pointStatQueryKey() });
      }
    },
    onError: settle(KEYS.onchain, setOnchainDone),
  });

  const state: DailyClaimState = !offchainDone
    ? 'ready'
    : hasOnchainBonus && !onchainDone
      ? 'bonus'
      : 'done';

  return {
    state,
    isPending: offchain.isPending || onchain.isPending,
    claim: () => {
      if (state === 'ready') offchain.mutate();
      else if (state === 'bonus') onchain.mutate();
    },
  };
}
