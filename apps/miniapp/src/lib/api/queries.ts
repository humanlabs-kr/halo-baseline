import type { Platform } from '@halo/contracts';
import {
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  pointApi,
  type ClaimedPoint,
  type OnchainClaim,
  type PointLogList,
  type PointLogsQuery,
  type PointStat,
} from './point';
import {
  fetchRaffleHistory,
  fetchRafflePools,
  raffleApi,
  type HaloRaffleChain,
  type HaloRafflePayouts,
  type RaffleHistoryView,
  type RafflePayoutsQuery,
  type RafflePool,
  type RaffleStats,
} from './raffle';
import {
  ledgerApi,
  type ChartSpan,
  type GroupDetail,
  type ItemDetail,
  type MarketBoard,
  type MonthSummary,
  type SpendGroup,
} from './ledger';
import {
  receiptApi,
  type ReceiptDetail,
  type ReceiptList,
  type ReceiptStat,
  type ReceiptTotalCount,
} from './receipt';

/**
 * React Query bindings for the domain clients in this folder.
 *
 * Every key is exported as a function so a caller can invalidate a query it
 * does not itself run — `usePointClaim` refetches the point stat and the
 * receipt list after a claim, and a literal `['point', 'stat']` typed out at
 * that call site would silently stop matching the day this file renames it.
 *
 * Errors arrive as whatever the transport threw: `ApiRequestError` for a
 * response the server produced, a plain `TypeError` for a connection that
 * never got one. Branch with `hasApiErrorCode`, which handles both.
 */

/** The query options screens actually vary. Anything broader invites drift. */
export interface QueryTuning {
  enabled?: boolean;
  refetchInterval?: number;
  staleTime?: number;
}

/** Mutation callbacks, kept narrow for the same reason as `QueryTuning`. */
export interface MutationCallbacks<TData> {
  onSuccess?: (data: TData) => void | Promise<void>;
  onError?: (error: Error) => void;
}

// ── Point ───────────────────────────────────────────────────────────────────

export const pointStatQueryKey = () => ['point', 'stat'] as const;

export function usePointStat(tuning: QueryTuning = {}): UseQueryResult<PointStat, Error> {
  return useQuery({
    queryKey: pointStatQueryKey(),
    queryFn: () => pointApi.stat(),
    ...tuning,
  });
}

export const pointLogsQueryKey = (query: PointLogsQuery) => ['point', 'logs', query] as const;

export function usePointLogs(query: PointLogsQuery): UseQueryResult<PointLogList, Error> {
  return useQuery({
    queryKey: pointLogsQueryKey(query),
    queryFn: () => pointApi.logs(query),
  });
}

export function useClaimDailyPoint(
  callbacks: MutationCallbacks<ClaimedPoint> = {},
): UseMutationResult<ClaimedPoint, Error, void> {
  return useMutation({ mutationFn: () => pointApi.claimDaily(), ...callbacks });
}

export function useClaimDailyPointCelo(
  callbacks: MutationCallbacks<OnchainClaim> = {},
): UseMutationResult<OnchainClaim, Error, void> {
  return useMutation({ mutationFn: () => pointApi.claimDailyCelo(), ...callbacks });
}

// ── Receipt ─────────────────────────────────────────────────────────────────

export const receiptsQueryKey = () => ['receipt', 'list'] as const;

export function useReceipts(tuning: QueryTuning = {}): UseQueryResult<ReceiptList, Error> {
  return useQuery({
    queryKey: receiptsQueryKey(),
    queryFn: () => receiptApi.list(),
    ...tuning,
  });
}

/**
 * The receipts list, a page at a time.
 *
 * Separate from `useReceipts`, which the ledger uses for the five most recent
 * and wants kept small. Invalidated by the same key prefix, so a new scan
 * refreshes both.
 */
export function useReceiptPages() {
  return useInfiniteQuery({
    queryKey: [...receiptsQueryKey(), 'paged'] as const,
    initialPageParam: 0,
    queryFn: ({ pageParam }: { pageParam: number }) => receiptApi.list({ offset: pageParam }),
    getNextPageParam: (last: ReceiptList, pages: ReceiptList[]) => {
      const seen = pages.reduce((total, page) => total + page.list.length, 0);
      return seen < last.totalCount ? seen : undefined;
    },
  });
}

/**
 * Scans that never became a purchase but still owe points.
 *
 * Its own list because the ledger stopped carrying rejected scans, and a
 * rejection still pays the participation reward. Only fetched where claiming
 * happens one receipt at a time: everywhere else a single button settles the
 * lot, so there is nothing for a per-receipt list to do.
 */
export function useRejectedReceipts(enabled: boolean): UseQueryResult<ReceiptList, Error> {
  return useQuery({
    queryKey: [...receiptsQueryKey(), 'rejected'] as const,
    queryFn: () => receiptApi.list({ kind: 'rejected', limit: 200 }),
    enabled,
  });
}

export const receiptQueryKey = (receiptId: string) => ['receipt', 'detail', receiptId] as const;

export function useReceipt(receiptId: string | undefined): UseQueryResult<ReceiptDetail, Error> {
  return useQuery({
    queryKey: receiptQueryKey(receiptId ?? ''),
    // `skipToken` rather than `enabled` plus a non-null assertion: it is the
    // absence of an id that makes the request impossible, and this way the
    // type system agrees instead of being told to look away.
    queryFn: receiptId ? () => receiptApi.byId(receiptId) : skipToken,
    // Analysis runs in a queue, so a receipt arrives here `pending` and becomes
    // itself a few seconds later. Polling stops the moment it settles, and also
    // stops after about two minutes: past that the queue is stuck rather than
    // slow, and a screen that keeps asking forever is a screen that never tells
    // the user anything went wrong.
    refetchInterval: (query) =>
      query.state.data?.status === 'pending' && query.state.dataUpdateCount < POLL_LIMIT ? 2_000 : false,
  });
}

/**
 * Polls before a screen gives up on a `pending` receipt.
 *
 * Two minutes at two seconds. Exported because the screen has to know when
 * polling stopped: otherwise the spinner it is showing becomes permanent and
 * says nothing went wrong.
 */
export const POLL_LIMIT = 60;

/** How long a screen should wait before saying the read is taking too long. */
export const POLL_GIVES_UP_AFTER_MS = POLL_LIMIT * 2_000;


export const receiptStatQueryKey = () => ['receipt', 'stat'] as const;

export function useReceiptStat(tuning: QueryTuning = {}): UseQueryResult<ReceiptStat, Error> {
  return useQuery({
    queryKey: receiptStatQueryKey(),
    queryFn: () => receiptApi.stat(),
    ...tuning,
  });
}

export const receiptTotalCountQueryKey = () => ['receipt', 'total-count'] as const;

export function useReceiptTotalCount(
  tuning: QueryTuning = {},
): UseQueryResult<ReceiptTotalCount, Error> {
  return useQuery({
    queryKey: receiptTotalCountQueryKey(),
    queryFn: () => receiptApi.totalCount(),
    ...tuning,
  });
}

// ── Raffle ──────────────────────────────────────────────────────────────────

/**
 * Pools are keyed per platform; calling this with no platform yields the
 * prefix, which invalidates every platform's pools at once.
 */
export function rafflePoolsQueryKey(platform?: Platform | null): readonly unknown[] {
  return platform ? ['raffle', 'pools', platform] : ['raffle', 'pools'];
}

export function useRafflePools(
  platform: Platform | null,
): UseQueryResult<RafflePool[], Error> {
  return useQuery({
    queryKey: rafflePoolsQueryKey(platform),
    queryFn: platform ? () => fetchRafflePools(platform) : skipToken,
    refetchInterval: 30_000,
  });
}

export const raffleHistoryQueryKey = (platform: Platform | null, date: string) =>
  ['raffle', 'history', platform, date] as const;

export function useRaffleHistory(
  platform: Platform | null,
  date: string,
  tuning: QueryTuning = {},
): UseQueryResult<RaffleHistoryView, Error> {
  return useQuery({
    queryKey: raffleHistoryQueryKey(platform, date),
    queryFn: platform ? () => fetchRaffleHistory(platform, date) : skipToken,
    ...tuning,
  });
}

export const raffleStatsQueryKey = () => ['raffle', 'stats'] as const;

export function useRaffleStats(): UseQueryResult<RaffleStats, Error> {
  return useQuery({
    queryKey: raffleStatsQueryKey(),
    queryFn: () => raffleApi.stats(),
    staleTime: 60_000,
  });
}

export const rafflePayoutsQueryKey = (
  chain: HaloRaffleChain | null,
  query: RafflePayoutsQuery,
) => ['raffle', 'payouts', chain, query] as const;

export function useRafflePayouts(
  chain: HaloRaffleChain | null,
  query: RafflePayoutsQuery,
): UseQueryResult<HaloRafflePayouts, Error> {
  return useQuery({
    queryKey: rafflePayoutsQueryKey(chain, query),
    queryFn: chain ? () => raffleApi.payouts(chain, query) : skipToken,
  });
}

/**
 * Everything the ledger derives from receipts.
 *
 * Invalidated as a prefix after a scan settles. Without it the month summary,
 * the group breakdown and the item history all kept serving the answer they
 * had before the receipt existed — the ledger was the one screen a new scan
 * did not reach.
 */
export const ledgerQueryKey = () => ['ledger'] as const;

export const monthQueryKey = (month?: string) => ['ledger', 'month', month ?? 'current'] as const;

export function useMonth(month?: string): UseQueryResult<MonthSummary, Error> {
  return useQuery({
    queryKey: monthQueryKey(month),
    queryFn: () => ledgerApi.month(month),
  });
}

export const marketQueryKey = (country?: string) => ['ledger', 'market', country ?? 'mine'] as const;

/**
 * The country's prices.
 *
 * Kept fresh for an hour: it is a 180-day median over a corpus of millions, so
 * it does not move between two taps, and refetching it on every mount would
 * put a sequential scan behind the home screen.
 */
export function useMarketBoard(country?: string): UseQueryResult<MarketBoard, Error> {
  return useQuery({
    queryKey: marketQueryKey(country),
    queryFn: () => ledgerApi.market(country),
    staleTime: 60 * 60 * 1000,
  });
}

export const groupQueryKey = (group: SpendGroup, month?: string) =>
  ['ledger', 'group', group, month ?? 'current'] as const;

export function useSpendGroup(group: SpendGroup, month?: string): UseQueryResult<GroupDetail, Error> {
  return useQuery({
    queryKey: groupQueryKey(group, month),
    queryFn: () => ledgerApi.group(group, month),
  });
}

export const ledgerItemQueryKey = (category: string, span: ChartSpan = '6m') =>
  ['ledger', 'item', category, span] as const;

export function useLedgerItem(
  category: string | undefined,
  span: ChartSpan = '6m',
): UseQueryResult<ItemDetail, Error> {
  return useQuery({
    queryKey: ledgerItemQueryKey(category ?? '', span),
    queryFn: category ? () => ledgerApi.item(category, span) : skipToken,
    // The span buttons swap one chart for another, and dropping to a spinner
    // between them makes the screen flash on every tap.
    placeholderData: (previous) => previous,
  });
}
