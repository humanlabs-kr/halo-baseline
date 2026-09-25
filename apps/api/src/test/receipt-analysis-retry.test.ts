import type { Database } from '@halo/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What happens to a receipt whose analysis keeps failing.
 *
 * The queue drops a message once its retries are spent, and for most of this
 * system's life nothing picked up after it: the row kept `status = 'pending'`,
 * no error was recorded, and the receipt showed "analysing" in the user's
 * history indefinitely. Production accumulated 174,534 rows in that state.
 *
 * So the assertion that matters here is not "a failure is retried" — that part
 * always worked. It is that **the last failure writes something**. A test that
 * only checked the retry path would have passed against the code that produced
 * the backlog.
 */

const settled: Array<Record<string, unknown>> = [];

const mockDb = {
  query: {
    // Missing receipt: makes `analyseReceipt` throw before it touches anything
    // else, which is the shape of a message that can never succeed.
    receipts: { findFirst: async () => undefined },
    receiptImages: { findMany: async () => [] },
  },
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        settled.push(values);
      },
    }),
  }),
} as unknown as Database;

// The processor pulls in a WASM image codec that only loads inside workerd.
// Nothing in these tests reaches the model call — the receipt lookup fails
// first — so a stub keeps the module graph importable under Node.
vi.mock('../lib/receipt-processor', () => ({
  ReceiptProcessor: {
    process: async () => {
      throw new Error('ReceiptProcessor.process should not be reached in this suite');
    },
    normalizeImage: (image: Uint8Array) => image,
  },
}));

vi.mock('@halo/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@halo/database')>();
  return { ...actual, createDb: () => mockDb };
});

const { ReceiptAnalysisQueue } = await import('../queues/receipt-analysis');

const ENV = { HYPERDRIVE: { connectionString: 'postgres://stub' } } as unknown as Env;

function messageAfter(attempts: number) {
  return {
    id: `msg-${attempts}`,
    timestamp: new Date(),
    body: { receiptId: 'receipt-1', country: 'KR' },
    attempts,
    retry: vi.fn(),
    ack: vi.fn(),
  };
}

/** A message whose body is deliberately untyped: one case sends a bad payload. */
type StubMessage = Omit<ReturnType<typeof messageAfter>, 'body'> & { body: unknown };

function batchOf(message: StubMessage) {
  return { queue: 'receipt-analysis', messages: [message] } as unknown as MessageBatch;
}

describe('receipt analysis retries', () => {
  beforeEach(() => {
    settled.length = 0;
  });

  it('retries a failure that still has attempts left, without settling the receipt', async () => {
    const message = messageAfter(1);

    await ReceiptAnalysisQueue.run(batchOf(message), ENV);

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    // Settling here would resolve a receipt that is still going to be analysed.
    expect(settled).toHaveLength(0);
  });

  it('still retries on the third attempt — `max_retries: 3` buys four deliveries', async () => {
    const message = messageAfter(3);

    await ReceiptAnalysisQueue.run(batchOf(message), ENV);

    // The boundary this pins down: `attempts` is 1-based and the queue keeps
    // going while failed attempts are below `max_retries + 1`. Settling at 3
    // discards a delivery that is still coming, which turns a provider blip
    // into a permanent zero-point rejection.
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(settled).toHaveLength(0);
  });

  it('settles the receipt on the final attempt instead of letting the queue drop it', async () => {
    const message = messageAfter(4);

    await ReceiptAnalysisQueue.run(batchOf(message), ENV);

    expect(message.retry).not.toHaveBeenCalled();
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ status: 'rejected', assignedPoint: 0 });
    expect(settled[0]?.analysisCompletedAt).toBeInstanceOf(Date);
    // The reason has to survive: it is what tells support a model outage from
    // an image that was never uploaded.
    expect(String(settled[0]?.analysisError)).toContain('Receipt not found');
  });

  it('does not throw when the final attempt carries a message it cannot parse', async () => {
    const message = { ...messageAfter(4), body: { nonsense: true } };

    await expect(ReceiptAnalysisQueue.run(batchOf(message), ENV)).resolves.toBeUndefined();
    expect(settled).toHaveLength(0);
  });
});
