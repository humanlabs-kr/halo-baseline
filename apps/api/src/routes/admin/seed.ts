/**
 * A realistic wallet, made to order, in a non-production database.
 *
 * Screens are checked against a drawing, and a drawing has data in it. The
 * only way to tell whether the ledger matches the one that was approved is to
 * look at a ledger with a month of shopping in it — an empty one tells you
 * the empty state is right and nothing else.
 *
 * Refused in production for the same reason `impersonate` is: it writes
 * receipts and points under an address it was merely handed, and a leaked
 * admin token must not be able to mint a balance.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { eq, inArray, pointLogs, receiptLineItems, receipts, users } from '@halo/database';
import KSUID from 'ksuid';

import { adminAuth } from '../../middleware/auth';
import {
  CANONICAL_UNIT,
  ITEM_CATEGORIES,
  type ItemCategory,
} from '../../lib/receipt-processor/categories';
import type { AppEnv } from '../../types';
import { adminValidationHook, jsonData, jsonError } from './shared';

/**
 * Shops and what they sell, per country.
 *
 * Invented names on purpose. A seeded database that says E-Mart is one
 * screenshot away from being mistaken for real data about a real shop.
 */
interface Shop {
  currency: string;
  names: string[];
  prices: Partial<Record<ItemCategory, number>>;
  /**
   * How a line prints on that country's paper.
   *
   * Seeded receipts exist to be looked at, and a Korean screenshot reading
   * "COOKING OIL 1.8l" is a screenshot of a bug we do not have. `{q}` is the
   * quantity; a line with no entry falls back to the category slug.
   */
  lines: Partial<Record<ItemCategory, string>>;
  /** What the till printed in the payment field. */
  paidWith: string;
}

const SHOPS: Record<string, Shop> = {
  KR: {
    currency: 'KRW',
    names: ['동네 마트 수원점', '행복슈퍼 광교', '한마음상회', '우리마트 영통'],
    prices: { rice: 3800, eggs: 7600, cooking_oil: 5200, bread: 2980, sugar: 2410, noodles: 980, detergent: 4900, soap: 1800 },
    lines: {
      rice: '햇반 백미 {q}KG',
      eggs: '계란 한 판 30구',
      cooking_oil: '해표 식용유 {q}L',
      bread: '삼립 식빵 1봉',
      sugar: '백설탕 {q}KG',
      noodles: '신라면 {q}봉',
      detergent: '액체세제 {q}KG',
      soap: '비누 {q}개',
    },
    paidWith: '카드',
  },
  NG: {
    currency: 'NGN',
    names: ['Corner Provisions', 'Mama Blessing Store', 'Unity Mart', 'Ade & Sons'],
    prices: { rice: 840, eggs: 4500, cooking_oil: 3900, bread: 1300, sugar: 1600, garri: 700, beans: 1500, detergent: 2300 },
    lines: {
      rice: 'RICE {q}KG',
      eggs: 'CRATE OF EGGS',
      cooking_oil: 'KINGS OIL {q}L',
      bread: 'AGEGE BREAD',
      sugar: 'ST LOUIS SUGAR {q}KG',
      garri: 'GARRI IJEBU {q}KG',
      beans: 'OLOYIN BEANS {q}KG',
      detergent: 'OMO DETERGENT {q}KG',
    },
    paidWith: 'CASH',
  },
  GB: {
    currency: 'GBP',
    names: ['The Corner Shop', 'High Street Grocer', 'Green Lane Market'],
    prices: { rice: 2, eggs: 3, cooking_oil: 3, bread: 1.4, sugar: 1.2, noodles: 0.9 },
    lines: {
      rice: 'BASMATI RICE {q}KG',
      eggs: 'FREE RANGE EGGS X12',
      cooking_oil: 'SUNFLOWER OIL {q}L',
      bread: 'WHITE LOAF 800G',
      sugar: 'CASTER SUGAR {q}KG',
      noodles: 'INSTANT NOODLES X{q}',
    },
    paidWith: 'CARD',
  },
};

/** Roughly what a household buys of each, in the category's canonical unit. */
const TYPICAL_QUANTITY: Partial<Record<ItemCategory, number>> = {
  rice: 5, beans: 2, garri: 3, bread: 1, noodles: 5, cooking_oil: 1.8,
  eggs: 1, milk_powder: 0.4, sugar: 1, tomato_paste: 0.2, detergent: 0.9, soap: 3,
};

const seedRoute = createRoute({
  method: 'post',
  path: '/admin/test/seed',
  tags: ['Admin'],
  summary: 'Fill a wallet with plausible receipts (non-production only)',
  middleware: [adminAuth] as const,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            address: z
              .string()
              .regex(/^0x[0-9a-fA-F]{40}$/, 'address must be a 0x-prefixed wallet address'),
            country: z.enum(['KR', 'NG', 'GB']).default('KR'),
            /** Receipts to write, spread back over `months`. */
            receipts: z.number().int().min(1).max(120).default(24),
            months: z.number().int().min(1).max(12).default(6),
            /**
             * Delete this wallet's existing receipts first.
             *
             * On by default: the point is a wallet in a known state, and
             * running the seeder twice should not leave a ledger showing twice
             * the shopping.
             */
            reset: z.boolean().default(true),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonData('Seeded', z.object({ address: z.string(), receipts: z.number(), lines: z.number() })),
    401: jsonError('Authentication required'),
    403: jsonError('Refused in production'),
  },
});

export const adminSeedRoutes = new OpenAPIHono<AppEnv>({ defaultHook: adminValidationHook }).openapi(
  seedRoute,
  async (c) => {
    if (c.env.PROJECT_ENV === 'production') {
      return c.json(
        { error: { code: 'FORBIDDEN' as const, message: 'Seeding is disabled in production' } },
        403,
      );
    }

    const db = c.get('db');
    const body = c.req.valid('json');
    const address = body.address.toLowerCase() as `0x${string}`;
    const shop = SHOPS[body.country]!;

    await db
      .insert(users)
      .values({ address, username: `seed-${address.slice(2, 8)}`, checksumAddress: body.address as `0x${string}` })
      .onConflictDoNothing();

    if (body.reset) {
      // Line items go with the receipt by cascade; the explicit delete is for
      // readability rather than necessity.
      const mine = await db.select({ id: receipts.id }).from(receipts).where(eq(receipts.userAddress, address));
      if (mine.length > 0) {
        await db.delete(receiptLineItems).where(inArray(receiptLineItems.receiptId, mine.map((row) => row.id)));
        await db.delete(receipts).where(eq(receipts.userAddress, address));
      }
      // And the point movements, or a re-seed stacks a second history on the
      // first and the balance is twice what the receipts add up to.
      await db.delete(pointLogs).where(eq(pointLogs.userAddress, address));
    }

    const now = Date.now();
    const span = body.months * 30 * 86_400_000;
    let lines = 0;

    // The loop walks newest first, and a balance has to grow with time — so
    // each receipt's `afterBalance` is the points of every *older* claimed
    // receipt plus its own, which is the suffix sum. Running a counter forward
    // through the loop would have given the newest receipt the smallest
    // balance and the oldest one the largest.
    const points = Array.from({ length: body.receipts }, (_, index) =>
      index % 9 === 0 ? 0 : 22 + (index % 4),
    );
    const balanceAt = points.reduceRight<number[]>((totals, value, index) => {
      totals[index] = (totals[index + 1] ?? 0) + value;
      return totals;
    }, []);

    for (let index = 0; index < body.receipts; index += 1) {
      // Spread back through the window, newest first, with the gaps uneven —
      // a perfectly regular shopping history looks like what it is.
      const age = Math.round((index / body.receipts) * span + (index % 5) * 86_400_000);
      // Shopping happens at a time of day. Every seeded receipt inheriting the
      // moment the seeder ran made a six-month list where every row read
      // "오전 03:24" — a list nobody would believe, and one I spent an
      // afternoon reading as if it were the product.
      const issuedAt = new Date(now - age);
      issuedAt.setUTCHours(9 + ((index * 3) % 12), (index * 17) % 60, 0, 0);
      const id = KSUID.randomSync().string;

      const basket = pickBasket(shop, index);
      const total = basket.reduce((sum, item) => sum + item.lineTotal, 0);
      const claimed = points[index]! > 0;

      await db.insert(receipts).values({
        id,
        userAddress: address,
        merchantName: shop.names[index % shop.names.length]!,
        issuedAt,
        countryCode: body.country,
        currency: shop.currency,
        totalAmount: total.toFixed(2),
        paymentMethod: shop.paidWith,
        qualityRate: 88 + (index % 10),
        status: claimed ? 'claimed' : 'claimable',
        // An unclaimed receipt still has points waiting on it; `points[]` is
        // zero there only because nothing has moved into the balance yet.
        assignedPoint: claimed ? points[index]! : 22 + (index % 4),
        analysisCompletedAt: issuedAt,
      });

      // A claimed receipt that left no point movement is a wallet with a
      // history and a balance of zero, which is the one thing the rewards
      // screen cannot render honestly — it read "내 포인트 0P" above a button
      // offering 45P. The log is the balance: `getUserPoint` reads the newest
      // row's `afterBalance` rather than re-summing.
      if (claimed) {
        await db.insert(pointLogs).values({
          id: KSUID.randomSync().string,
          userAddress: address,
          diff: points[index]!,
          afterBalance: balanceAt[index]!,
          accumulatedBalance: balanceAt[index]!,
          sourceType: 'receipt-upload',
          sourceId: id,
          createdAt: issuedAt,
        });
      }

      await db.insert(receiptLineItems).values(
        basket.map((item, lineNo) => ({
          id: KSUID.randomSync().string,
          receiptId: id,
          lineNo: lineNo + 1,
          rawText: item.rawText,
          category: item.category,
          quantity: item.quantity.toFixed(3),
          unit: CANONICAL_UNIT[item.category],
          unitPrice: item.unitPrice.toFixed(4),
          lineTotal: item.lineTotal.toFixed(2),
          // `vision`, not `seed`, and that is a deliberate contradiction of
          // the rule on the column — which says anything claimed about other
          // people must filter these out. The market board, the price change
          // and "shoppers paid X" are the screens this seeder exists to put
          // data behind, and `seed` would leave every one of them empty.
          //
          // What makes it safe is the production guard at the top of this
          // handler, not the column: these rows cannot be written anywhere a
          // real user will be compared against them.
          source: 'vision' as const,
        })),
      );

      lines += basket.length;
    }

    return c.json({ data: { address, receipts: body.receipts, lines } }, 200);
  },
);

/**
 * Three or four items, with prices that wobble around the shop's.
 *
 * The wobble matters: a corpus where every receipt carries the same number has
 * a median but no spread, so every shopper is exactly average and the one
 * sentence this product exists to say never fires.
 */
function pickBasket(shop: Shop, seed: number) {
  const { prices } = shop;
  const available = ITEM_CATEGORIES.filter((category) => prices[category] !== undefined);
  const size = 3 + (seed % 2);

  return Array.from({ length: size }, (_, offset) => {
    const category = available[(seed * 3 + offset) % available.length]!;
    const base = prices[category]!;
    // ±12%, deterministic per receipt so a re-seed reproduces the same ledger.
    const drift = 1 + (((seed * 7 + offset * 13) % 25) - 12) / 100;
    const unitPrice = base * drift;
    const quantity = TYPICAL_QUANTITY[category] ?? 1;

    return {
      category,
      rawText:
        shop.lines[category]?.replace('{q}', String(quantity)) ??
        `${category.replace(/_/g, ' ').toUpperCase()} ${quantity}${CANONICAL_UNIT[category]}`,
      quantity,
      unitPrice,
      lineTotal: unitPrice * quantity,
    };
  });
}

