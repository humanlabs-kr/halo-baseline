import type { TFunction } from 'i18next';
import type { PointLog, PointLogSourceType } from '@/lib/api/point';

/**
 * What a point movement is called on screen.
 *
 * Shared because two screens list the same rows — the recent three on the
 * rewards tab and the full history — and a movement that reads "Receipt" in
 * one place and "Scan reward" in the other looks like two different events.
 *
 * The map is exhaustive over `PointLogSourceType` on purpose: a new source
 * added server-side then fails to compile here rather than rendering an
 * `undefined` label into a list of money.
 */
export function pointLogLabel(log: PointLog, t: TFunction): string {
  const labels: Record<PointLogSourceType, string> = {
    airdrop: t('L-60sEhS90'),
    'receipt-upload': t('L-SmZlO3bs'),
    raffle: t('L-EbJnZmoR'),
    manual: t('L-dPqbUD7r'),
    'daily-claim': t('L-hLxj0K2z'),
    'daily-claim-onchain': t('L-hLxj0K2z'),
  };

  return labels[log.sourceType];
}
