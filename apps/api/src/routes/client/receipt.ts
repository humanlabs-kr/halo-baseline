import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { dataSchema, errorSchema, receiptStatusSchema, REJECTION_REASONS } from '@halo/contracts';
import {
  and,
  blacklistedAddresses,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  receiptImages,
  receiptLineItems,
  receipts,
  sql,
} from '@halo/database';
import { addDays, endOfDay, startOfDay, startOfWeek } from 'date-fns';
import { cache } from 'hono/cache';
import KSUID from 'ksuid';
import { R2 } from '../../lib/r2';
import { compareWithMarket, marketUnitPrices } from '../../lib/market';
import { ReceiptProcessor } from '../../lib/receipt-processor';
import { RECEIPT_LIST_KINDS, receiptScope } from '../../lib/receipt-lists';
import {
  CANONICAL_UNIT,
  CATEGORY_LABEL,
  RAW_UNITS,
  toCategory,
  type ItemCategory,
  type RawUnit,
} from '../../lib/receipt-processor/categories';
import { userAuth } from '../../middleware/auth';
import { tryCatch } from '../../lib/try-catch';
import { ReceiptAnalysisQueue } from '../../queues';
import type { AppEnv } from '../../types';

/** Hard cap on uploads per wallet per UTC day. */
const DAILY_UPLOAD_LIMIT = 5;

/** Past this many uploads in a week a receipt still gets stored, but is worth no points. */
const WEEKLY_POINT_ELIGIBLE_LIMIT = 35;

const app = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: 'BAD_REQUEST' as const,
            message: result.error.issues[0]?.message ?? 'Invalid request',
          },
        },
        400,
      );
    }
  },
});

// ── POST /receipts ──────────────────────────────────────────────────────────

const uploadReceiptRoute = createRoute({
  method: 'post',
  path: '/receipts',
  tags: ['Receipt'],
  summary: 'Upload receipt image',
  middleware: [userAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z
              .custom<File>((v) => v instanceof File, { message: 'file must be a file' })
              .openapi({ type: 'string', format: 'binary' }),
            turnstileToken: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Receipt accepted and queued for analysis',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              result: z.literal('success'),
              receiptId: z.string().openapi({ description: 'Poll the detail endpoint with this' }),
            }),
          ),
        },
      },
    },
    400: {
      description: 'BAD_REQUEST (CAPTCHA) / DAILY_LIMIT_REACHED',
      content: { 'application/json': { schema: errorSchema } },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    403: {
      description: 'ADDRESS_BLACKLISTED',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

app.openapi(uploadReceiptRoute, async (c) => {
  // `request.cf` is not in the type surface here, but Cloudflare sets the same ISO 3166-1
  // alpha-2 value on this header, and the analysis prompt only needs the country hint.
  const country = c.req.header('CF-IPCountry') ?? '';
  const userAddress = c.get('address')!;
  const db = c.get('db');

  const { file, turnstileToken } = c.req.valid('form');

  const turnstileRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: c.env.TURNSTILE_SECRET_KEY, response: turnstileToken }),
  });
  const turnstileData = (await turnstileRes.json()) as { success: boolean };

  if (!turnstileData.success) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST' as const,
          message: 'CAPTCHA verification failed. Please try again.',
        },
      },
      400,
    );
  }

  const blacklisted = await db.query.blacklistedAddresses.findFirst({
    where: eq(blacklistedAddresses.address, userAddress),
  });

  if (blacklisted) {
    return c.json(
      {
        error: {
          code: 'ADDRESS_BLACKLISTED' as const,
          message: 'This address has been restricted.',
        },
      },
      403,
    );
  }

  const now = new Date();

  // Checked before the transaction so a rejected upload never takes a write lock.
  const dailyScanCount = await db
    .select({ count: sql<number>`count(*)`.as('count') })
    .from(receipts)
    .where(
      and(
        eq(receipts.userAddress, userAddress),
        gte(receipts.createdAt, startOfDay(now)),
        lt(receipts.createdAt, endOfDay(now)),
      ),
    )
    .then((result) => result[0]?.count ?? 0);

  if (dailyScanCount >= DAILY_UPLOAD_LIMIT) {
    return c.json(
      {
        error: {
          code: 'DAILY_LIMIT_REACHED' as const,
          message: `You have reached the daily receipt upload limit (${DAILY_UPLOAD_LIMIT} per day).`,
        },
      },
      400,
    );
  }

  // The image lands in R2 *before* any row exists. The previous order — insert
  // the rows, then upload — left a `pending` receipt behind every time the
  // upload failed: a row whose image the consumer could never read, so it was
  // never analysed and never settled. An orphaned R2 object costs storage; an
  // orphaned row costs the user a receipt that says "analysing" forever.
  const receiptImageId = crypto.randomUUID();
  const arrayBuffer = await file.arrayBuffer();
  const normalizedImage = ReceiptProcessor.normalizeImage(new Uint8Array(arrayBuffer));

  await R2.saveReceiptImage(c.env.RECEIPT_BUCKET, normalizedImage, receiptImageId);

  const receiptId = await db.transaction(async (tx) => {
    const weeklyScanCount = await tx
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(receipts)
      .where(
        and(
          eq(receipts.userAddress, userAddress),
          gte(receipts.createdAt, startOfWeek(now)),
          lt(receipts.createdAt, startOfWeek(addDays(now, 7))),
        ),
      )
      .then((result) => result[0]?.count ?? 0);

    const newReceiptId = KSUID.randomSync().string;

    await tx.insert(receipts).values({
      id: newReceiptId,
      userAddress,
      assignedPoint: weeklyScanCount >= WEEKLY_POINT_ELIGIBLE_LIMIT ? -1 : undefined,
    });

    // TODO create many receipt image rows once a receipt can carry multiple images
    await tx.insert(receiptImages).values([
      { id: receiptImageId, receiptId: newReceiptId, numOrder: 0 },
    ]);

    return newReceiptId;
  });

  // Enqueued with `await` rather than `waitUntil`. A send that fails inside
  // `waitUntil` is invisible: nothing logs it, nothing retries it, and the
  // receipt stays `pending` for good. The upload itself still succeeds — row
  // and image are both durable — and `ReceiptSweeper` re-queues whatever never
  // reached the consumer.
  const enqueued = await tryCatch(
    ReceiptAnalysisQueue.send(c.env.RECEIPT_ANALYSIS_QUEUE, { receiptId, country }),
  );

  if (enqueued.error) {
    console.error(`Failed to enqueue receipt analysis for ${receiptId}:`, enqueued.error);
  }

  // The id comes back so the client can follow the receipt it just sent.
  // Analysis is asynchronous, and without an id the only way to find out what
  // happened to this particular scan is to list every receipt and guess which
  // one is new.
  return c.json({ data: { result: 'success' as const, receiptId } }, 200);
});


// ── GET /receipts ───────────────────────────────────────────────────────────

const listReceiptsRoute = createRoute({
  method: 'get',
  path: '/receipts',
  tags: ['Receipt'],
  summary: 'List receipts',
  middleware: [userAuth] as const,
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      kind: z.enum(RECEIPT_LIST_KINDS).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              totalCount: z.number(),
              list: z.array(
                z.object({
                  id: z.string(),
                  merchantName: z.string().nullable(),
                  status: receiptStatusSchema,
                  currency: z.string().nullable(),
                  totalAmount: z.string().nullable(),
                  assignedPoint: z.number(),
                  qualityRate: z.number().nullable(),
                  rejectionReason: z.enum(REJECTION_REASONS).nullable(),
                  /**
                   * How this receipt came out against everyone else's prices,
                   * or null when nothing on it could be compared.
                   *
                   * Positive is money saved. Computed here rather than on the
                   * row, so the chip a receipt shows and the filter it answers
                   * to are the same number — otherwise a receipt shows a green
                   * chip and then fails to appear under "cheaper".
                   */
                  comparison: z
                    .object({ amount: z.number(), lines: z.number() })
                    .nullable(),
                  /**
                   * When the shopping happened, not when the photo arrived.
                   *
                   * The ledger groups the list into days and totals each one,
                   * and those days have to be the days money was spent — a
                   * receipt from April uploaded this morning belongs to April.
                   * Null on receipts whose date we could not read.
                   */
                  issuedAt: z.coerce.date().nullable(),
                  createdAt: z.coerce.date(),
                  lineCount: z.number().openapi({ description: 'Lines read off it, 0 if none' }),
                }),
              ),
            }),
          ),
        },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
});

/**
 * Rows per page.
 *
 * The screen shows a scrollable history, not an archive — a wallet with four
 * years of scans does not need all of them serialised into a phone every time
 * the list refreshes, and this endpoint is polled. `totalCount` is counted
 * separately so the header stays truthful past the page.
 *
 * Paged rather than merely capped. A cap on its own is worse than no cap: the
 * count says 1,200 and the list stops at 200, and the receipts a long-standing
 * user most wants — the old ones — are the ones that cannot be reached.
 */
const RECEIPT_PAGE_SIZE = 50;

/**
 * Narrows the stored unit text to a unit the converter knows.
 *
 * The column is plain text, so a unit the model invented reaches
 * `toCanonicalQuantity` as a string it cannot convert. Narrowed here it
 * becomes null and the line is simply not compared — one lost observation
 * rather than a comparison against a unit nobody defined.
 */
function toRawUnit(unit: string | null): RawUnit | null {
  return unit !== null && (RAW_UNITS as readonly string[]).includes(unit) ? (unit as RawUnit) : null;
}


app.openapi(listReceiptsRoute, async (c) => {
  const userAddress = c.get('address')!;
  const db = c.get('db');
  const { limit = RECEIPT_PAGE_SIZE, offset = 0, kind = 'ledger' } = c.req.valid('query');
  const scope = receiptScope(userAddress, kind);

  const [receiptRecords, totalCount] = await Promise.all([
    db.query.receipts.findMany({
      columns: {
        id: true,
        merchantName: true,
        status: true,
        assignedPoint: true,
        currency: true,
        totalAmount: true,
        qualityRate: true,
        rejectionReason: true,
        // Needed to keep a wallet's foreign receipts out of the home
        // country's median rather than silently compared against it.
        countryCode: true,
        issuedAt: true,
        createdAt: true,
      },
      where: scope,
      // By purchase date, falling back to upload time for the receipts whose
      // date could not be read. Ordering by upload time put a receipt bought
      // in April at the top of a list headed "today", because the list is
      // grouped by the date the shopping happened.
      orderBy: [desc(sql`coalesce(${receipts.issuedAt}, ${receipts.createdAt})`), desc(receipts.createdAt)],
      limit,
      offset,
    }),
    db
      .select({ value: count() })
      .from(receipts)
      .where(scope)
      .then((rows) => rows[0]?.value ?? 0),
  ]);

  // A second grouped query rather than a correlated subquery in `extras`.
  //
  // Drizzle renders a column reference inside a raw `sql` template as a bare
  // quoted name with no table qualifier, so
  // `${receiptLineItems.receiptId} = ${receipts.id}` came out as
  // `"receipt_id" = "id"` — and inside the subquery both of those resolve
  // against `receipt_line_items`, whose own primary key is `id`. The
  // comparison is never true, the count is zero on every row, and nothing
  // errors: the screen simply stops saying how many items are on a receipt.
  const lineCounts = new Map<string, number>();
  const comparisons = new Map<string, { amount: number; lines: number } | null>();

  if (receiptRecords.length > 0) {
    const ids = receiptRecords.map((receipt) => receipt.id);

    const counts = await db
      .select({ receiptId: receiptLineItems.receiptId, value: count() })
      .from(receiptLineItems)
      .where(inArray(receiptLineItems.receiptId, ids))
      .groupBy(receiptLineItems.receiptId);

    for (const row of counts) lineCounts.set(row.receiptId, row.value);

    // Every priced line on the page, in one read, and then one market lookup
    // covering every category on it. Asking per receipt would be fifty round
    // trips for a screen that scrolls.
    const priced = await db
      .select({
        receiptId: receiptLineItems.receiptId,
        category: receiptLineItems.category,
        quantity: receiptLineItems.quantity,
        unit: receiptLineItems.unit,
        unitPrice: receiptLineItems.unitPrice,
      })
      .from(receiptLineItems)
      .where(and(inArray(receiptLineItems.receiptId, ids), isNotNull(receiptLineItems.unitPrice)));

    const byReceipt = new Map<string, typeof priced>();
    for (const line of priced) {
      const bucket = byReceipt.get(line.receiptId);
      if (bucket) bucket.push(line);
      else byReceipt.set(line.receiptId, [line]);
    }

    // One country per page is the normal case and the only one worth a query.
    // A wallet that shopped abroad gets its foreign receipts left uncompared
    // rather than compared against the wrong country's median.
    const country = receiptRecords.find((receipt) => receipt.countryCode !== null)?.countryCode ?? '';
    const categories = [
      ...new Set(
        priced
          .map((line) => (line.category === null ? null : toCategory(line.category)))
          .filter((category): category is ItemCategory => category !== null),
      ),
    ];

    const market =
      categories.length === 0
        ? new Map()
        : await marketUnitPrices(db, categories, country, userAddress);

    for (const receipt of receiptRecords) {
      const lines = receipt.countryCode === country ? (byReceipt.get(receipt.id) ?? []) : [];

      comparisons.set(
        receipt.id,
        compareWithMarket(
          lines.map((line) => ({
            category: line.category === null ? null : toCategory(line.category),
            quantity: line.quantity === null ? null : Number(line.quantity),
            unit: toRawUnit(line.unit),
            unitPrice: line.unitPrice === null ? null : Number(line.unitPrice),
          })),
          market,
        ),
      );
    }
  }

  return c.json(
    {
      data: {
        totalCount,
        list: receiptRecords.map((receipt) => ({
          id: receipt.id,
          merchantName: receipt.merchantName,
          status: receipt.status,
          currency: receipt.currency,
          totalAmount: receipt.totalAmount,
          assignedPoint: receipt.assignedPoint,
          qualityRate: receipt.qualityRate,
          rejectionReason: receipt.rejectionReason,
          comparison: comparisons.get(receipt.id) ?? null,
          issuedAt: receipt.issuedAt,
          createdAt: receipt.createdAt,
          lineCount: lineCounts.get(receipt.id) ?? 0,
        })),
      },
    },
    200,
  );
});

// ── GET /receipts/{receiptId}/image/{receiptImageId} ────────────────────────

const getReceiptImageRoute = createRoute({
  method: 'get',
  path: '/receipts/{receiptId}/image/{receiptImageId}',
  tags: ['Receipt'],
  summary: 'Get receipt image',
  request: {
    params: z.object({ receiptId: z.string(), receiptImageId: z.string() }),
  },
  responses: {
    200: {
      description: 'The receipt image',
      content: { 'image/jpeg': { schema: z.string().openapi({ format: 'binary' }) } },
    },
    404: {
      description: 'NOT_FOUND',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

app.openapi(getReceiptImageRoute, async (c) => {
  const { receiptImageId } = c.req.valid('param');

  let image: Uint8Array;

  try {
    image = await R2.downloadReceiptImage(c.env.RECEIPT_BUCKET, receiptImageId);
  } catch {
    return c.json({ error: { code: 'NOT_FOUND' as const, message: 'Receipt image not found' } }, 404);
  }

  // The object key is the image id and its bytes never change, so this can be cached forever.
  return new Response(image, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});

// ── GET /receipt/stat ───────────────────────────────────────────────────────

const receiptStatRoute = createRoute({
  method: 'get',
  path: '/receipt/stat',
  tags: ['Receipt'],
  summary: 'Get receipt stat',
  middleware: [userAuth] as const,
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({ weeklyScanCount: z.number(), dailyScanCount: z.number() }),
          ),
        },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
  },
});

app.openapi(receiptStatRoute, async (c) => {
  const userAddress = c.get('address')!;
  const db = c.get('db');

  // Points are granted on a weekly budget, and the week starts Monday 00:00 UTC.
  const [weeklyScanCount, dailyScanCount] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(receipts)
      .where(
        and(
          eq(receipts.userAddress, userAddress),
          gte(receipts.createdAt, startOfWeek(new Date())),
          lt(receipts.createdAt, startOfWeek(addDays(new Date(), 7))),
        ),
      )
      .then((result) => result[0]?.count ?? 0),
    db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(receipts)
      .where(
        and(
          eq(receipts.userAddress, userAddress),
          gte(receipts.createdAt, startOfDay(new Date())),
          lt(receipts.createdAt, startOfDay(addDays(new Date(), 1))),
        ),
      )
      .then((result) => result[0]?.count ?? 0),
  ]);

  return c.json({ data: { weeklyScanCount, dailyScanCount } }, 200);
});

// ── GET /receipt/total-count ────────────────────────────────────────────────

// A one-second edge cache is enough to absorb the landing page's polling without letting the
// counter visibly lag. Registered with `app.use` rather than as route middleware: `cache()` is
// typed against a bare `Env`, and mixing it into `createRoute`'s middleware tuple widens the
// handler's context away from `AppEnv`.
app.use('/receipt/total-count', cache({ cacheName: 'receipt-total-count', cacheControl: 'max-age=1' }));

const receiptTotalCountRoute = createRoute({
  method: 'get',
  path: '/receipt/total-count',
  tags: ['Receipt'],
  summary: 'Get total receipt count (public)',
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': { schema: dataSchema(z.object({ totalCount: z.number() })) },
      },
    },
  },
});

app.openapi(receiptTotalCountRoute, async (c) => {
  const totalCount = await c
    .get('db')
    .select({ count: count() })
    .from(receipts)
    .then((result) => result[0]?.count ?? 0);

  return c.json({ data: { totalCount } }, 200);
});

// ── GET /receipts/{receiptId} ───────────────────────────────────────────────

const getReceiptByIdRoute = createRoute({
  method: 'get',
  path: '/receipts/{receiptId}',
  tags: ['Receipt'],
  summary: 'Get receipt by id',
  middleware: [userAuth] as const,
  request: { params: z.object({ receiptId: z.string() }) },
  responses: {
    200: {
      description: 'Success',
      content: {
        'application/json': {
          schema: dataSchema(
            z.object({
              id: z.string(),
              merchantName: z.string().nullable(),
              status: receiptStatusSchema,
              currency: z.string().nullable(),
              totalAmount: z.string().nullable(),
              issuedAt: z.coerce.date().nullable(),
              countryCode: z.string().nullable(),
              paymentMethod: z.string().nullable(),
              qualityRate: z.number().nullable(),
              assignedPoint: z.number(),
              createdAt: z.coerce.date(),
              /** Why it did not count, or null. Null on every receipt settled
               *  before the column existed, so the screen still needs a
               *  fallback. */
              rejectionReason: z.enum(REJECTION_REASONS).nullable(),
              /**
               * How many receipts this wallet has, counting this one.
               *
               * Answered here rather than inferred from the month summary. The
               * ledger counts by purchase date, so a wallet with forty scans
               * that uploads a receipt dated last month has a current-month
               * count of zero — and the screen called it their first ever.
               */
              receiptsEver: z.number(),
              images: z.array(
                z.object({
                  id: z.string(),
                  numOrder: z.number(),
                  createdAt: z.coerce.date(),
                }),
              ),
              lineItems: z.array(
                z.object({
                  lineNo: z.number(),
                  rawText: z.string(),
                  category: z.string().nullable(),
                  label: z.string().nullable(),
                  quantity: z.number().nullable(),
                  /** The unit as printed on the receipt — "g", "750ml". */
                  unit: z.string().nullable(),
                  /**
                   * The unit `unitPrice` is quoted in, which is the category's
                   * canonical one and is often not the printed one. A 70 g tin
                   * has `unit: 'g'` and a price per kilo; labelling that price
                   * with the printed unit said "₦5,200 a gram".
                   */
                  priceUnit: z.string().nullable(),
                  unitPrice: z.number().nullable(),
                  lineTotal: z.number().nullable(),
                  marketUnitPrice: z.number().nullable(),
                }),
              ),
              comparison: z
                .object({
                  amount: z.number().openapi({ description: 'Positive when they paid less' }),
                  lines: z.number(),
                })
                .nullable(),
            }),
          ),
        },
      },
    },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: errorSchema } } },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: errorSchema } } },
  },
});

app.openapi(getReceiptByIdRoute, async (c) => {
  const { receiptId } = c.req.valid('param');
  const db = c.get('db');
  const userAddress = c.get('address')!;

  const [receipt, receiptsEver] = await Promise.all([
    db.query.receipts.findFirst({
      columns: {
        id: true,
        merchantName: true,
        status: true,
        currency: true,
        totalAmount: true,
        issuedAt: true,
        countryCode: true,
        paymentMethod: true,
        qualityRate: true,
        assignedPoint: true,
        createdAt: true,
        rejectionReason: true,
      },
      // Scoped to the caller. Without the address in the predicate this
      // endpoint returns any receipt to any signed-in wallet, and it now
      // carries an itemised shopping list, not just a total.
      where: and(eq(receipts.id, receiptId), eq(receipts.userAddress, userAddress)),
      with: { images: true, lineItems: { orderBy: receiptLineItems.lineNo } },
    }),
    db
      .select({ value: count() })
      .from(receipts)
      .where(eq(receipts.userAddress, userAddress))
      .then((rows) => rows[0]?.value ?? 0),
  ]);

  if (!receipt) {
    return c.json({ error: { code: 'NOT_FOUND' as const, message: 'Receipt not found' } }, 404);
  }

  // Only lines we both classified and could price can be compared with anything.
  const priced = receipt.lineItems.filter(
    (line): line is typeof line & { category: ItemCategory; unitPrice: string } =>
      line.category !== null && line.unitPrice !== null && toCategory(line.category) !== null,
  );

  const market = await marketUnitPrices(
    db,
    [...new Set(priced.map((line) => line.category))],
    receipt.countryCode ?? '',
    userAddress,
  );

  const lineItems = receipt.lineItems.map((line) => {
    const category = line.category === null ? null : toCategory(line.category);

    return {
      lineNo: line.lineNo,
      rawText: line.rawText,
      category,
      label: category === null ? null : CATEGORY_LABEL[category],
      quantity: line.quantity === null ? null : Number(line.quantity),
      unit: line.unit as RawUnit | null,
      priceUnit: category === null ? null : CANONICAL_UNIT[category],
      unitPrice: line.unitPrice === null ? null : Number(line.unitPrice),
      lineTotal: line.lineTotal === null ? null : Number(line.lineTotal),
      marketUnitPrice: (category === null ? undefined : market.get(category))?.unitPrice ?? null,
    };
  });

  const comparison = compareWithMarket(lineItems, market);

  return c.json(
    {
      data: {
        id: receipt.id,
        merchantName: receipt.merchantName,
        status: receipt.status,
        currency: receipt.currency,
        totalAmount: receipt.totalAmount,
        issuedAt: receipt.issuedAt,
        countryCode: receipt.countryCode,
        paymentMethod: receipt.paymentMethod,
        qualityRate: receipt.qualityRate,
        assignedPoint: receipt.assignedPoint,
        createdAt: receipt.createdAt,
        rejectionReason: receipt.rejectionReason,
        receiptsEver,
        images: receipt.images.map((image) => ({
          id: image.id,
          numOrder: image.numOrder,
          createdAt: image.createdAt,
        })),
        lineItems,
        comparison,
      },
    },
    200,
  );
});

export const clientReceiptRoutes = app;
