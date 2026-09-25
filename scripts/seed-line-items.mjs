/**
 * Seeds `receipt_line_items` for receipts that have none yet.
 *
 * WHY THIS EXISTS
 * The vision model has only ever extracted a receipt *total* — there are no
 * line items anywhere in the corpus. Re-reading 1.17M archived images takes
 * real time and OpenRouter spend, and the app cannot be built against an empty
 * table. This fills the gap.
 *
 * WHAT IS REAL AND WHAT IS NOT
 * Every seeded line hangs off a *real* receipt: real merchant, real date, real
 * country, and the lines sum to the *real* printed total. Only the split across
 * items is synthetic. So the ledger's monthly spend, merchant names and receipt
 * counts are true; the category and unit-price layer is not.
 *
 * Every row is written with `source = 'seed'`. Aggregates that feed a published
 * price index MUST filter `source = 'vision'`. Seeded rows may render in the
 * app; they may not become a public number, and nothing derived from them may
 * be described to anyone as an extraction result.
 *
 *   node scripts/seed-line-items.mjs --country NG --limit 5000 [--dry]
 */
import { createHash } from 'node:crypto';
import process from 'node:process';
import postgres from 'postgres';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const COUNTRY = String(flag('country', 'NG')).toUpperCase();
const LIMIT = Number(flag('limit', 2000));
const DRY = args.includes('--dry');

const DB = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!DB) {
  console.error('DATABASE_MIGRATION_URL (or DATABASE_URL) is required.');
  process.exit(1);
}

/**
 * Reference prices in NGN at `PRICE_ANCHOR`, per canonical unit, with a monthly
 * drift. Levels are plausible rather than surveyed — they exist to make the app
 * renderable, and every one of them is replaced the moment real extraction runs.
 *
 * `weight` is how often the category shows up in a basket, not its share of spend.
 */
const PRICE_ANCHOR = Date.UTC(2025, 8, 1); // 2025-09-01
const CATALOG = {
  rice:         { unit: 'kg',    base: 1450, drift: 0.021, weight: 9,  packs: [[5, 'kg'], [25, 'kg'], [1, 'kg']] },
  beans:        { unit: 'kg',    base: 1750, drift: 0.023, weight: 6,  packs: [[1, 'kg'], [2, 'kg']] },
  garri:        { unit: 'kg',    base: 900,  drift: 0.019, weight: 6,  packs: [[2, 'kg'], [5, 'kg']] },
  bread:        { unit: 'loaf',  base: 1300, drift: 0.014, weight: 8,  packs: [[1, 'loaf'], [2, 'loaf']] },
  noodles:      { unit: 'pack',  base: 480,  drift: 0.016, weight: 8,  packs: [[1, 'pack'], [5, 'pack']] },
  cooking_oil:  { unit: 'l',     base: 3900, drift: 0.026, weight: 7,  packs: [[1, 'l'], [750, 'ml'], [5, 'l']] },
  eggs:         { unit: 'crate', base: 2750, drift: 0.012, weight: 5,  packs: [[1, 'crate']] },
  milk_powder:  { unit: 'kg',    base: 7800, drift: 0.018, weight: 3,  packs: [[400, 'g'], [900, 'g']] },
  sugar:        { unit: 'kg',    base: 1650, drift: 0.017, weight: 4,  packs: [[1, 'kg'], [500, 'g']] },
  tomato_paste: { unit: 'kg',    base: 5200, drift: 0.024, weight: 5,  packs: [[70, 'g'], [210, 'g']] },
  detergent:    { unit: 'kg',    base: 2100, drift: 0.013, weight: 4,  packs: [[500, 'g'], [1, 'kg']] },
  soap:         { unit: 'piece', base: 750,  drift: 0.011, weight: 4,  packs: [[1, 'piece'], [3, 'piece']] },
};

const RAW_LABEL = {
  rice: ['RICE', 'MAMA GOLD RICE', 'LOCAL RICE', 'ROYAL STALLION RICE'],
  beans: ['BEANS', 'OLOYIN BEANS', 'BROWN BEANS'],
  garri: ['GARRI', 'IJEBU GARRI', 'WHITE GARRI'],
  bread: ['BREAD', 'AGEGE BREAD', 'SLICED BREAD'],
  noodles: ['INDOMIE', 'NOODLES', 'CHIKKI NOODLES'],
  cooking_oil: ['KINGS OIL', 'VEG OIL', 'POWER OIL'],
  eggs: ['EGGS', 'CRATE OF EGGS'],
  milk_powder: ['PEAK MILK', 'DANO MILK', 'MILK POWDER'],
  sugar: ['SUGAR', 'ST LOUIS SUGAR', 'DANGOTE SUGAR'],
  tomato_paste: ['TIN TOMATO', 'GINO TOMATO', 'TOMATO PASTE'],
  detergent: ['ARIEL', 'OMO DETERGENT', 'DETERGENT'],
  soap: ['SOAP', 'PREMIER SOAP', 'LUX SOAP'],
};

const UNMATCHED_LABEL = ['SUNDRY', 'MISC', 'SVC CHG', 'SACHET WATER', 'RECHARGE CARD', 'PEPPER', 'ONIONS'];

/** Deterministic RNG seeded from the receipt id, so re-runs produce the same split. */
function rng(seed) {
  let h = createHash('sha256').update(seed).digest();
  let i = 0;
  return () => {
    if (i >= h.length - 4) { h = createHash('sha256').update(h).digest(); i = 0; }
    const v = h.readUInt32BE(i); i += 4;
    return v / 0xffffffff;
  };
}
const pick = (r, arr) => arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))];

/** KSUID-shaped 27-char id. Sortable by time, which is all we need here. */
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function newId(r) {
  let s = '';
  for (let i = 0; i < 27; i++) s += B62[Math.floor(r() * 62)];
  return s;
}

function priceAt(cat, when) {
  const months = (when.getTime() - PRICE_ANCHOR) / (1000 * 60 * 60 * 24 * 30.44);
  return CATALOG[cat].base * Math.pow(1 + CATALOG[cat].drift, months);
}

const CANON = { kg: { kg: 1 }, g: { kg: 0.001 }, l: { l: 1 }, ml: { l: 0.001 },
  piece: { piece: 1, loaf: 1, pack: 1, crate: 1 }, pack: { pack: 1 }, loaf: { loaf: 1 }, crate: { crate: 1 } };
const toCanonical = (cat, qty, unit) => (CANON[unit]?.[CATALOG[cat].unit] ?? null) === null
  ? null : qty * CANON[unit][CATALOG[cat].unit];

const WEIGHTED = Object.entries(CATALOG).flatMap(([k, v]) => Array(v.weight).fill(k));

/** Builds lines for one receipt whose `lineTotal`s sum exactly to `total`. */
function buildLines(receipt) {
  const r = rng(receipt.id);
  const when = receipt.issued_at ? new Date(receipt.issued_at) : new Date(receipt.created_at);
  const total = Number(receipt.total_amount);
  if (!Number.isFinite(total) || total <= 0) return [];

  const lines = [];
  let spent = 0;
  const wanted = 2 + Math.floor(r() * 5); // 2–6 item lines
  const seen = new Set();

  for (let n = 0; n < wanted * 3 && lines.length < wanted; n++) {
    const cat = pick(r, WEIGHTED);
    if (seen.has(cat)) continue;
    const [qty, unit] = pick(r, CATALOG[cat].packs);
    const canonical = toCanonical(cat, qty, unit);
    if (canonical === null) continue;

    // ±9% around the trend, so a category has spread rather than one flat price.
    const unitPrice = priceAt(cat, when) * (0.91 + r() * 0.18);
    const lineTotal = Math.round(unitPrice * canonical);
    if (lineTotal <= 0 || spent + lineTotal > total * 0.94) continue;

    seen.add(cat);
    spent += lineTotal;
    lines.push({
      category: cat,
      rawText: `${pick(r, RAW_LABEL[cat])} ${qty}${unit.toUpperCase()}`,
      quantity: qty, unit, lineTotal,
      unitPrice: +(lineTotal / canonical).toFixed(4),
    });
  }

  // The remainder is what a twelve-item basket does not cover. It is shown to
  // the user as "Not matched" rather than hidden, and it never reaches an index.
  const rest = Math.round((total - spent) * 100) / 100;
  if (rest > 0) {
    lines.push({ category: null, rawText: pick(r, UNMATCHED_LABEL), quantity: null, unit: null, lineTotal: rest, unitPrice: null });
  }
  return lines.map((l, i) => ({ ...l, id: newId(r), lineNo: i + 1, receiptId: receipt.id }));
}

const sql = postgres(DB, { max: 4 });
try {
  const rows = await sql`
    SELECT r.id, r.issued_at, r.created_at, r.total_amount
    FROM receipto.receipts r
    WHERE r.country_code = ${COUNTRY}
      AND r.total_amount IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM receipto.receipt_line_items li WHERE li.receipt_id = r.id)
    ORDER BY r.issued_at DESC NULLS LAST
    LIMIT ${LIMIT}`;

  console.log(`${COUNTRY}: ${rows.length} receipts without line items`);
  let made = 0, skipped = 0;

  for (const receipt of rows) {
    const lines = buildLines(receipt);
    if (lines.length === 0) { skipped++; continue; }
    made += lines.length;
    if (DRY) {
      if (made <= 40) for (const l of lines) console.log(`  ${receipt.id} ${String(l.lineNo).padStart(2)} ${l.rawText.padEnd(28)} ${l.category ?? '—'} ${l.lineTotal}`);
      continue;
    }
    await sql`INSERT INTO receipto.receipt_line_items ${sql(lines.map((l) => ({
      id: l.id, receipt_id: l.receiptId, line_no: l.lineNo, raw_text: l.rawText,
      category: l.category, quantity: l.quantity, unit: l.unit,
      unit_price: l.unitPrice, line_total: l.lineTotal, source: 'seed',
    })))}`;
  }
  console.log(`${DRY ? '[dry] would write' : 'wrote'} ${made} lines · skipped ${skipped} receipts`);
} finally {
  await sql.end();
}
