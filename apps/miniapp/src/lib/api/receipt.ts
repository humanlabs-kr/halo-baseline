import type { ReceiptStatus } from '@halo/contracts';
import type { RejectionReason } from '@halo/contracts';
import { apiFetch, apiUrl, type ApiRequestInit } from './client';

/**
 * Receipt endpoints — `apps/api/src/routes/client/receipt.ts`.
 *
 * `status` is `ReceiptStatus` from `@halo/contracts`, the same enum the server
 * validates with. Re-declaring the five states here would let the two drift,
 * and the screens index status→label maps by it: a missing member is a runtime
 * `undefined.label`, not a type error, unless the union is shared.
 *
 * Date columns are `z.coerce.date()` server-side, which serialises to an ISO
 * string over JSON — so they are `string` here, not `Date`.
 */

/** Module-private: every client route is mounted under `/v1`. */
function call<T>(path: string, init?: ApiRequestInit): Promise<T> {
  return apiFetch<T>(`/v1${path}`, init);
}

export interface UploadReceiptRequest {
  file: File;
  turnstileToken: string;
}

export interface ReceiptUploaded {
  result: 'success';
  /** Analysis is asynchronous; poll `byId` with this to find out what it said. */
  receiptId: string;
}

export interface ReceiptListItem {
  id: string;
  merchantName: string | null;
  status: ReceiptStatus;
  currency: string | null;
  totalAmount: string | null;
  assignedPoint: number;
  qualityRate: number | null;
  /** Why it did not count. Null on every receipt that did. */
  rejectionReason: RejectionReason | null;
  /**
   * How it came out against everyone else's prices. Positive is money saved,
   * null when nothing on it could be compared.
   *
   * Computed on the server so the chip a row shows and the filter it answers
   * to are the same number.
   */
  comparison: { amount: number; lines: number } | null;
  /**
   * When the shopping happened. Null where the date could not be read.
   *
   * A ledger groups by this, not by `createdAt` — a receipt from April
   * photographed this morning is April's spending. Grouping by upload time put
   * six months of shopping under one heading reading "today" and gave that day
   * a total ten times the month it sat inside.
   */
  issuedAt: string | null;
  createdAt: string;
  /**
   * Lines read off it. Zero on every receipt scanned before we started reading
   * them, which is why the list says "6 items" or says nothing rather than
   * saying "0 items" — those are different facts.
   */
  lineCount: number;
}

export interface ReceiptList {
  totalCount: number;
  list: ReceiptListItem[];
}

/** One stored scan. */
export interface ReceiptImage {
  id: string;
  numOrder: number;
  createdAt: string;
}

/**
 * One line off the receipt, as we read it.
 *
 * Every field but `rawText` is nullable and the nulls carry meaning the screen
 * has to respect. `category === null` is a line we could not place — we still
 * show the printed text, because pretending we did not see it is worse than
 * admitting we did not understand it. `unitPrice === null` is a line with no
 * derivable size, so it can be listed but never compared. `marketUnitPrice`
 * is null when nobody else's receipts have said enough about that category
 * yet, which is normal in a country we just started reading.
 */
export interface ReceiptLine {
  lineNo: number;
  rawText: string;
  category: string | null;
  label: string | null;
  quantity: number | null;
  /** As printed on the receipt. */
  unit: string | null;
  /**
   * The unit `unitPrice` is quoted in — the category's canonical one, which is
   * often not the printed one. A 70 g tin is priced per kilo.
   */
  priceUnit: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
  marketUnitPrice: number | null;
}

/**
 * The basket against everyone else's median, in money.
 *
 * `null` means no line on this receipt could be compared at all — not that the
 * user broke even. The two produce different screens.
 */
export interface ReceiptComparison {
  /** Positive when they paid less than the going rate. */
  amount: number;
  lines: number;
}

export interface ReceiptDetail {
  id: string;
  merchantName: string | null;
  status: ReceiptStatus;
  currency: string | null;
  totalAmount: string | null;
  issuedAt: string | null;
  countryCode: string | null;
  paymentMethod: string | null;
  qualityRate: number | null;
  assignedPoint: number;
  createdAt: string;
  /**
   * Why it did not count. Null when it did — and also on every receipt settled
   * before we started recording this, so a screen reading it needs a fallback
   * rather than a lookup that can return undefined.
   */
  rejectionReason: RejectionReason | null;
  /**
   * Receipts this wallet has ever scanned, including this one.
   *
   * Not the same as the month summary's count, which is by purchase date: a
   * wallet with forty scans uploading a receipt dated last month has a
   * current-month count of zero, and "your first receipt" is a lie to exactly
   * the user least likely to forgive it.
   */
  receiptsEver: number;
  images: ReceiptImage[];
  lineItems: ReceiptLine[];
  comparison: ReceiptComparison | null;
}

export interface ReceiptStat {
  weeklyScanCount: number;
  dailyScanCount: number;
}

export interface ReceiptTotalCount {
  totalCount: number;
}

export const receiptApi = {
  upload({ file, turnstileToken }: UploadReceiptRequest): Promise<ReceiptUploaded> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('turnstileToken', turnstileToken);

    return call('/receipts', { method: 'POST', formData });
  },

  /**
   * `kind` decides which list this is. `ledger` — the default — is the
   * household history and holds purchases only; `rejected` is the scans that
   * never became one and still owe points.
   */
  list(
    query: { limit?: number; offset?: number; kind?: 'ledger' | 'rejected' } = {},
  ): Promise<ReceiptList> {
    return call('/receipts', { query: { ...query } });
  },

  byId(receiptId: string): Promise<ReceiptDetail> {
    return call(`/receipts/${encodeURIComponent(receiptId)}`);
  },

  /**
   * Scans are served by the API, not from public storage, so this is a URL for
   * an `<img src>` rather than a request — the browser fetches it, not us.
   */
  imageUrl(receiptId: string, receiptImageId: string): string {
    return apiUrl(
      `/v1/receipts/${encodeURIComponent(receiptId)}/image/${encodeURIComponent(receiptImageId)}`,
    );
  },

  stat(): Promise<ReceiptStat> {
    return call('/receipt/stat');
  },

  /** Public counter for the landing card — no session required. */
  totalCount(): Promise<ReceiptTotalCount> {
    return call('/receipt/total-count');
  },
};
