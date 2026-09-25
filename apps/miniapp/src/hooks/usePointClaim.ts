import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useConnection, useWriteContract } from 'wagmi';
import { POINT_CLAIM_ABI } from '@halo/contracts';
import { MiniKit, VerificationLevel } from '@worldcoin/minikit-js';
import { ApiRequestError } from '@/lib/api/client';
import { pointApi } from '@/lib/api/point';
import { pointStatQueryKey, receiptsQueryKey } from '@/lib/api/queries';
import { sendSuccessNotificationHaptic } from '@/lib/haptic';
import { PLATFORM_CHAIN } from '@/lib/wagmi';
import { useAuthStore } from '@/stores/auth';

/**
 * Claiming points is the one flow that genuinely differs per chain.
 *
 * - `celo`  — points are minted on-chain. The server signs a per-receipt claim
 *             and the wallet sends the transaction, so claims are one receipt
 *             at a time and the user pays for each.
 * - `world` — the server needs a World ID proof, obtained from MiniKit, and
 *             settles every claimable receipt in one call.
 * - `kaia`  — the server settles everything claimable off-chain; nothing to
 *             sign.
 *
 * `mode` tells the screen where to put the button: next to each receipt, or
 * once at the top of the list.
 */
export type ClaimMode = 'per-receipt' | 'all-at-once';

/**
 * What happened, rather than whether it worked.
 *
 * Every failure here used to collapse to `null`, and the screen's only
 * reaction to `null` was to do nothing. So a World user pressed Claim, the
 * World ID sheet opened, and then the app sat there — for a cancelled
 * verification, a rejected proof, a network failure and a server error alike.
 * Nothing was written anywhere either: the client swallowed the exception and
 * the production Worker had logging switched off, so there was no record on
 * either side of the request.
 *
 * `cancelled` is separated from the rest because it is not a failure. Somebody
 * who closed the sheet does not need to be told they closed the sheet.
 */
export type ClaimOutcome =
  | { status: 'claimed'; points: number }
  | { status: 'cancelled' }
  | { status: 'failed'; code: string; message: string };

export interface PointClaim {
  mode: ClaimMode;
  isPending: boolean;
  claimReceipt: (receiptId: string) => Promise<ClaimOutcome>;
  claimAll: () => Promise<ClaimOutcome>;
}

/** World's own word for "the user closed the sheet". */
const USER_REJECTED = 'user_rejected';

/**
 * Whether a wallet threw because the person declined, rather than because
 * something broke. viem wraps the provider's rejection, so the code is nested
 * somewhere in the cause chain and the name is the reliable part.
 */
function isWalletRejection(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /UserRejected|User rejected|denied transaction|4001/i.test(text);
}

/**
 * Turns whatever was thrown into something with a code.
 *
 * The code is what gets shown and what gets logged, so an unlabelled failure
 * is worse than an ugly one — `unknown` at least tells the next person that
 * the throw site is not one we anticipated.
 */
function asFailure(error: unknown): ClaimOutcome {
  if (error instanceof ApiRequestError) {
    return { status: 'failed', code: error.code ?? `http_${error.status}`, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 'failed', code: slug(message), message };
}

/**
 * A short, stable handle for a thrown message.
 *
 * `unknown` is what the first version printed, and it is no more use to the
 * person reading it than silence was. The throws that reach here are mostly
 * other people's — MiniKit's "Failed to send verify command", a fetch
 * failure — and none of them carry a code, so one is made from the words.
 *
 * Known shapes get a name; anything else gets the first few words, which is
 * enough for someone to read down the phone and for the next person to grep.
 */
function slug(message: string): string {
  if (/MiniKit|verify command/i.test(message)) return 'minikit_unavailable';
  if (/NetworkError|Failed to fetch|Load failed/i.test(message)) return 'offline';
  if (/timeout|timed out/i.test(message)) return 'timeout';

  return (
    message
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .split('_')
      .slice(0, 4)
      .join('_') || 'unknown'
  );
}

const WORLD_CLAIM_ACTION = 'claim-points';

export function usePointClaim(): PointClaim {
  const platform = useAuthStore((s) => s.platform);
  const queryClient = useQueryClient();
  const { address } = useConnection();
  const { mutateAsync: writeContract } = useWriteContract();
  const [isPending, setIsPending] = useState(false);

  const refresh = useCallback(() => {
    void queryClient.refetchQueries({ queryKey: receiptsQueryKey() });
    void queryClient.refetchQueries({ queryKey: pointStatQueryKey() });
  }, [queryClient]);

  const claimReceipt = useCallback(
    async (receiptId: string): Promise<ClaimOutcome> => {
      if (isPending || platform !== 'celo') {
        return { status: 'failed', code: 'not_ready', message: 'Claiming is not available here.' };
      }
      setIsPending(true);
      try {
        if (!address) {
          return { status: 'failed', code: 'no_wallet', message: 'No wallet is connected.' };
        }

        const claim = await pointApi.claimSingleCelo({ receiptId });
        await writeContract({
          address: claim.contractAddress as `0x${string}`,
          abi: POINT_CLAIM_ABI,
          functionName: 'claimPoints',
          args: [
            BigInt(claim.claimedPoint),
            claim.claimIdBytes32 as `0x${string}`,
            BigInt(claim.deadline),
            claim.signature as `0x${string}`,
          ],
          chain: PLATFORM_CHAIN.celo,
          account: address,
        });

        sendSuccessNotificationHaptic();
        return { status: 'claimed', points: claim.claimedPoint };
      } catch (error) {
        // The wallet rejected the transaction, or the call failed. Either way
        // the server may already have marked the claim spent, so the balance
        // is re-read in `finally` rather than guessed at.
        if (isWalletRejection(error)) return { status: 'cancelled' };
        console.error('[claim] celo', error);
        return asFailure(error);
      } finally {
        refresh();
        setIsPending(false);
      }
    },
    [address, isPending, platform, refresh, writeContract],
  );

  const claimAll = useCallback(async (): Promise<ClaimOutcome> => {
    if (isPending || !platform || platform === 'celo') {
      return { status: 'failed', code: 'not_ready', message: 'Claiming is not available here.' };
    }
    setIsPending(true);
    try {
      if (platform === 'world') {
        const { finalPayload } = await MiniKit.commandsAsync.verify({
          action: WORLD_CLAIM_ACTION,
          signal: WORLD_CLAIM_ACTION,
          verification_level: VerificationLevel.Device,
        });

        // World's own error code, passed through rather than translated into
        // one of ours. It is the only thing that says why the sheet closed —
        // `max_verifications_reached`, `credential_unavailable`,
        // `verification_rejected` are all different problems with different
        // answers, and collapsing them into "something went wrong" is what
        // left this unfixable from the outside.
        if (finalPayload.status === 'error') {
          const code = finalPayload.error_code ?? 'verify_failed';
          if (code === USER_REJECTED) return { status: 'cancelled' };
          console.error('[claim] world verify', code, finalPayload);
          return { status: 'failed', code, message: `World ID: ${code}` };
        }

        // MiniKit 1.11 added a second success shape. Asking for several
        // verification levels at once answers with `verifications[]` instead of
        // one proof inline, and both shapes carry `status: 'success'`, so ruling
        // out the error case no longer leaves a single type. We only ever ask
        // for one level, so the array shape should not come back — but read it
        // rather than assert, because the alternative is a cast that would go
        // on compiling if that ever stopped being true.
        const verification = 'verifications' in finalPayload ? finalPayload.verifications[0] : finalPayload;
        if (!verification) {
          console.error('[claim] world verify returned no proof', finalPayload);
          return { status: 'failed', code: 'no_proof', message: 'World ID returned no proof.' };
        }

        const { claimedPoint } = await pointApi.claim({
          platform: 'world',
          proof: verification.proof,
          // MiniKit types this as its own enum; the API takes the literal.
          verification_level:
            verification.verification_level === VerificationLevel.Orb ? 'orb' : 'device',
          merkle_root: verification.merkle_root,
          nullifier_hash: verification.nullifier_hash,
          signal: WORLD_CLAIM_ACTION,
          action: WORLD_CLAIM_ACTION,
        });
        sendSuccessNotificationHaptic();
        return { status: 'claimed', points: claimedPoint };
      }

      const { claimedPoint } = await pointApi.claim({ platform: 'kaia' });
      sendSuccessNotificationHaptic();
      return { status: 'claimed', points: claimedPoint };
    } catch (error) {
      console.error('[claim] claimAll', platform, error);
      return asFailure(error);
    } finally {
      refresh();
      setIsPending(false);
    }
  }, [isPending, platform, refresh]);

  return {
    mode: platform === 'celo' ? 'per-receipt' : 'all-at-once',
    isPending,
    claimReceipt,
    claimAll,
  };
}

/**
 * The one place a claim outcome turns into something on screen.
 *
 * Shared so the two screens that claim cannot drift: the rewards tab used to
 * show a toast on a daily-claim failure and nothing at all on a receipt-claim
 * failure, which is how "press the button, watch nothing happen" survived in
 * one half of the app while the other half was fine.
 *
 * The code is in the message on purpose. A user cannot act on
 * `max_verifications_reached`, but they can read it out, and until this
 * existed there was nothing to read out — no toast, and no server log either.
 */
export function useClaimFeedback(onClaimed: (points: number) => void) {
  const { t } = useTranslation();

  return (outcome: ClaimOutcome) => {
    if (outcome.status === 'claimed') {
      onClaimed(outcome.points);
      return;
    }
    // Closing the sheet is a decision, not an error.
    if (outcome.status === 'cancelled') return;

    // The code identifies it; the message says what happened. The first
    // version printed only the code, so a 500 whose body already carried the
    // reason arrived on screen as the word INTERNAL_ERROR and the reason was
    // thrown away a second time.
    const detail = outcome.message && outcome.message !== outcome.code ? outcome.message : null;

    toast.error(
      detail
        ? `${t('Could not claim. ({{code}})', { code: outcome.code })} ${detail}`
        : t('Could not claim. ({{code}})', { code: outcome.code }),
      { duration: 8000 },
    );
  };
}
