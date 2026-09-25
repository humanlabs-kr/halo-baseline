import { apiFetch, type ApiRequestInit } from './client';

/**
 * Point endpoints — `apps/api/src/routes/client/point.ts`.
 *
 * Two shapes of claim live here and they are not interchangeable:
 *
 * - **Offchain** (`claim`, `claimDaily`) credits the balance server-side and
 *   answers with the number of points granted. Nothing to sign.
 * - **Onchain** (`claimSingleCelo`, `claimDailyCelo`) additionally returns an
 *   EIP-712 voucher the wallet redeems against the Celo point contract. The
 *   server has already spent the claim by the time the client sees it, so a
 *   rejected transaction means "re-read the balance", not "retry the call".
 */

/** Module-private: every client route is mounted under `/v1`. */
function call<T>(path: string, init?: ApiRequestInit): Promise<T> {
  return apiFetch<T>(`/v1${path}`, init);
}

export interface PointStat {
  accumulatedPoint: number;
  currentPoint: number;
  claimablePoint: number;
}

export type PointLogSourceType =
  | 'airdrop'
  | 'receipt-upload'
  | 'raffle'
  | 'manual'
  | 'daily-claim'
  | 'daily-claim-onchain';

export interface PointLog {
  id: string;
  diff: number;
  afterBalance: number;
  accumulatedBalance: number;
  sourceType: PointLogSourceType;
  sourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PointLogList {
  totalCount: number;
  list: PointLog[];
}

export interface PointLogsQuery {
  limit?: number;
  offset?: number;
}

/**
 * Claim every claimable receipt at once.
 *
 * World is the only platform that carries a World ID proof; the server
 * discriminates on `platform`, so the union has to stay exact.
 */
export type ClaimPointRequest =
  | {
      platform: 'world';
      proof: string;
      verification_level: 'orb' | 'device';
      merkle_root: string;
      nullifier_hash: string;
      signal: string;
      action: string;
    }
  | { platform: 'celo' }
  | { platform: 'kaia' };

export interface ClaimedPoint {
  claimedPoint: number;
}

/** Server-signed voucher redeemed against the Celo point-claim contract. */
export interface OnchainClaim {
  claimedPoint: number;
  claimIdBytes32: string;
  deadline: number;
  signature: string;
  contractAddress: string;
  chainId: number;
}

export const pointApi = {
  stat(): Promise<PointStat> {
    return call('/point/stat');
  },

  logs(query: PointLogsQuery = {}): Promise<PointLogList> {
    return call('/point/logs', { query: { ...query } });
  },

  claim(request: ClaimPointRequest): Promise<ClaimedPoint> {
    return call('/point/claim', { method: 'POST', body: request });
  },

  claimSingleCelo(request: { receiptId: string }): Promise<OnchainClaim> {
    return call('/point/claim-single-celo', { method: 'POST', body: request });
  },

  /** Once per UTC day. Answers `409 ALREADY_CLAIMED` on the second attempt. */
  claimDaily(): Promise<ClaimedPoint> {
    return call('/daily-point-claim/claim', { method: 'POST' });
  },

  /** The richer Celo-only bonus, paid as an onchain voucher. Also once per UTC day. */
  claimDailyCelo(): Promise<OnchainClaim> {
    return call('/daily-point-claim/claim-celo', { method: 'POST' });
  },
};
