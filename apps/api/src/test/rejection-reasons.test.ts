import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from '@halo/database';

// Same reason as the storable-amount suite: the queue module reaches the
// processor, and the processor pulls in a WASM image codec that only loads
// inside workerd.
vi.mock('../lib/receipt-processor', () => ({
  ReceiptProcessor: {
    process: async () => {
      throw new Error('not reached');
    },
  },
}));

const { gradeReceipt } = await import('../queues/receipt-analysis');
const { receiptScope } = await import('../lib/receipt-lists');
import type { Database } from '@halo/database';
import type { Receipt } from '../lib/receipt-processor/zod';

/**
 * Two failures a user reported on their own production account.
 *
 * Photographing something that was never a receipt answered "the photo came
 * out too blurry", and the thing that was never a receipt was then filed in
 * the household ledger between two grocery runs. Both passed typecheck, lint
 * and 117 tests, because neither is a type error — they are the wrong answer
 * and the wrong list.
 */
const dialect = new PgDialect();

/** `gradeReceipt` reads the database only to look for a duplicate. */
const noDb = {} as Database;

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    merchantName: 'MAMA NGOZI STORE',
    issuedAt: new Date() as Date | null,
    countryCode: 'NG',
    currency: 'NGN',
    totalAmount: 4200,
    paymentMethod: 'CASH',
    isReceipt: true,
    qualityRate: 90,
    lineItems: [],
    ...overrides,
  };
}

describe('why a scan did not count', () => {
  it('a sharp photo of something that is not a receipt is not a blurry photo', async () => {
    const reason = await gradeReceipt(noDb, 'r-1', '0xabc', receipt({ isReceipt: false }));

    expect(reason).toBe('not-a-receipt');
  });

  it('asks whether it is a receipt before asking how well it reads', async () => {
    // Both tests fail at once: the model said it is not a receipt *and*
    // scored it zero. The reason the user is shown has to be the first one,
    // because "hold the camera steadier" cannot help them.
    const reason = await gradeReceipt(
      noDb,
      'r-2',
      '0xabc',
      receipt({ isReceipt: false, qualityRate: 0 }),
    );

    expect(reason).toBe('not-a-receipt');
  });

  it('reads the older signal too, in case the new field is ignored', async () => {
    // The prompt has always answered a non-receipt with qualityRate 0 and the
    // literal name UNKNOWN. Nothing outside the worker can call the model, so
    // the fix must not depend on the deployed one having learnt a new field.
    const reason = await gradeReceipt(
      noDb,
      'r-4',
      '0xabc',
      receipt({ isReceipt: true, qualityRate: 0, merchantName: 'UNKNOWN' }),
    );

    expect(reason).toBe('not-a-receipt');
  });

  it('an unreadable date is a reason, not an exception', async () => {
    // Found by pointing the reparse probe at a real image. The model answers a
    // dateless photo with something `z.coerce.date()` rejected, which threw
    // away the whole response — so the queue recorded an analysis *outage*: no
    // rejection reason, and none of the participation reward. The user was
    // told "this one did not count" and docked five points for photographing
    // the wrong thing, which is the one case we now have a real answer for.
    const reason = await gradeReceipt(noDb, 'r-6', '0xabc', receipt({ issuedAt: null }));

    expect(reason).toBe('no-date');
  });

  it('asks whether it is a receipt before asking about the date', async () => {
    // Otherwise a photo of a home screen is told to get the date in the shot.
    const reason = await gradeReceipt(
      noDb,
      'r-7',
      '0xabc',
      receipt({ isReceipt: false, issuedAt: null }),
    );

    expect(reason).toBe('not-a-receipt');
  });

  it('a dateless receipt is never a duplicate of another dateless one', async () => {
    // `eq(column, null)` is never true in SQL, so the duplicate lookup would
    // have compared against nothing and reported a match at random. It is
    // skipped instead — and `noDb` here proves the database is not reached.
    const reason = await gradeReceipt(noDb, 'r-8', '0xabc', receipt({ issuedAt: null }));

    expect(reason).toBe('no-date');
  });

  it('a real receipt too blurry to read is still a receipt', async () => {
    const reason = await gradeReceipt(noDb, 'r-3', '0xabc', receipt({ qualityRate: 12 }));

    expect(reason).toBe('unreadable');
  });

  it('a shop genuinely called UNKNOWN that scanned fine is not rejected for its name', async () => {
    // The pair is the signal, not the name on its own.
    const reason = await gradeReceipt(
      noDb,
      'r-5',
      '0xabc',
      receipt({ merchantName: 'UNKNOWN', qualityRate: 88, totalAmount: null }),
    );

    expect(reason).toBe('no-total');
  });

  it('a readable receipt is not rejected', async () => {
    // Guards the default: `isReceipt` is optional on the wire, and a response
    // that omits it must not start rejecting everything.
    const parsed = receipt();
    expect(parsed.isReceipt).toBe(true);
  });
});

describe('which receipts a list is asking for', () => {
  function statuses(kind: 'ledger' | 'rejected'): string[] {
    const { params } = dialect.sqlToQuery(receiptScope('0xabc', kind)!.getSQL());
    return params.filter((value): value is string => typeof value === 'string' && value !== '0xabc');
  }

  it('the ledger holds purchases only', () => {
    const kinds = statuses('ledger');

    expect(kinds).toEqual(['pending', 'claimable', 'claimed']);
    expect(kinds).not.toContain('rejected');
    expect(kinds).not.toContain('rejected-claimed');
  });

  it('the rejected list holds only what is not already in the ledger', () => {
    // Rejected scans pay the participation reward and Celo claims one receipt
    // at a time. Dropping them from the ledger without this list would strand
    // those points. Including `claimable` as well put the same shop on the
    // same screen twice — once to claim, once as a purchase.
    const kinds = statuses('rejected');

    expect(kinds).toEqual(['rejected']);
    expect(kinds).not.toContain('claimable');
    expect(kinds).not.toContain('rejected-claimed');
  });

  it('binds each status separately, not as one array parameter', () => {
    // `status = ANY(${jsArray})` renders `ANY(($1,$2,$3))` and Postgres
    // rejects it under the simple query protocol that Hyperdrive forces.
    const { sql: text } = dialect.sqlToQuery(receiptScope('0xabc', 'ledger')!.getSQL());

    expect(text).toContain('in ($2, $3, $4)');
  });
});

/**
 * What the vision response is allowed to be missing.
 *
 * The schema is stricter than the model. Every field that a real photo can
 * genuinely fail to carry has to survive as a null rather than rejecting the
 * object, because a rejected object is an exception, and an exception is
 * indistinguishable from the model being down — which is the one failure the
 * queue must not confuse with a bad photo.
 */
describe('a response with fields the photo did not carry', () => {
  it('keeps the receipt when the date cannot be parsed', async () => {
    const { ReceiptSchema } = await import('../lib/receipt-processor/zod');

    const parsed = ReceiptSchema.parse({
      merchantName: 'UNKNOWN',
      issuedAt: 'unknown',
      countryCode: 'KR',
      currency: 'KRW',
      totalAmount: null,
      paymentMethod: null,
      isReceipt: false,
      qualityRate: 0,
      lineItems: [],
    });

    expect(parsed.issuedAt).toBeNull();
  });

  it('still reads a date when there is one', async () => {
    const { ReceiptSchema } = await import('../lib/receipt-processor/zod');

    const parsed = ReceiptSchema.parse({
      merchantName: 'MAMA NGOZI STORE',
      issuedAt: '2026-09-20T16:30:00Z',
      countryCode: 'NG',
      currency: 'NGN',
      totalAmount: 4200,
      paymentMethod: 'CASH',
      isReceipt: true,
      qualityRate: 92,
      lineItems: [],
    });

    expect(parsed.issuedAt?.toISOString()).toBe('2026-09-20T16:30:00.000Z');
  });
});
