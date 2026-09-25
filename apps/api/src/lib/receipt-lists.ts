import { and, eq, inArray, receipts } from '@halo/database';

/**
 * Which receipts a list is asking for.
 *
 * One endpoint served two lists that want opposite things, and the losing one
 * was the ledger. `ledger` is the household history: purchases, and the scan
 * currently being read. A photo of a bank statement is not a purchase, and
 * filing it between two grocery runs is the same mistake as filing a blurry
 * one — the paper never became a line in the book either way.
 *
 * `rejected` is the remainder, and only the remainder: scans that never became
 * a purchase but still owe the user points, because a rejection pays the
 * participation reward and on Celo each one is claimed individually. Without
 * this list those points would be stranded on a screen that no longer exists.
 *
 * Deliberately not "everything unclaimed". A claimable purchase is in the
 * ledger already, and listing it here as well put the same shop on the screen
 * twice — once with a claim button and once with its points — which reads as
 * two visits to the same shop on the same day.
 *
 * In its own module so a test can import it. The route it is used from pulls
 * in the image pipeline, and that pulls in a wasm binary that only loads
 * inside workerd.
 */
export const RECEIPT_LIST_KINDS = ['ledger', 'rejected'] as const;

export type ReceiptListKind = (typeof RECEIPT_LIST_KINDS)[number];

const LEDGER_STATUSES = ['pending', 'claimable', 'claimed'] as const;

/**
 * Only the unsettled ones. `rejected-claimed` has already paid out, so it is
 * neither a purchase nor an action — it is nothing, and it belongs on no list.
 */
const REJECTED_STATUSES = ['rejected'] as const;

export function receiptScope(userAddress: string, kind: ReceiptListKind) {
  const statuses = kind === 'rejected' ? REJECTED_STATUSES : LEDGER_STATUSES;

  return and(eq(receipts.userAddress, userAddress), inArray(receipts.status, [...statuses]));
}
