import type { TFunction } from 'i18next';
import { MAX_RECEIPT_AGE_DAYS, type RejectionReason } from '@halo/contracts';

/**
 * Why this one did not go through.
 *
 * Read from the field the analyser writes, not inferred. Two of the five
 * rejections leave a sharp, complete receipt behind — too old, and
 * photographed twice — and guessing from the returned fields told both of
 * those users to take the photo again, which is the one action that cannot
 * help them.
 *
 * The fallback is for receipts settled before the reason was recorded. It says
 * less rather than guessing more.
 */
export function rejectionCopy(
  reason: RejectionReason | null,
  t: TFunction,
): { title: string; advice: string } {
  switch (reason) {
    case 'not-a-receipt':
      return {
        title: t('That is not a receipt'),
        advice: t('Photograph the paper slip the shop gave you.'),
      };
    case 'unreadable':
      return {
        title: t('The photo came out too blurry'),
        advice: t('Lay the receipt flat, fill the frame, and keep your shadow off it.'),
      };
    case 'no-total':
      return {
        title: t('We could not find a total'),
        advice: t('The bottom of the receipt has to be in the shot.'),
      };
    case 'no-merchant':
      return {
        title: t('We could not tell which shop this is'),
        advice: t('The name is usually at the very top. Get that part in the shot.'),
      };
    case 'no-date':
      return {
        title: t('We could not read the date'),
        advice: t('The date is usually near the top. Get that part in the shot.'),
      };
    case 'too-old':
      return {
        title: t('This one is over a week old'),
        advice: t('We can only count purchases from the last {{days}} days.', {
          days: MAX_RECEIPT_AGE_DAYS,
        }),
      };
    case 'duplicate':
      return {
        title: t('You already scanned this one'),
        advice: t('It is in your ledger from the first time.'),
      };
    default:
      return {
        title: t('This one did not count'),
        advice: t('Scan your next receipt and it will go straight in.'),
      };
  }
}
