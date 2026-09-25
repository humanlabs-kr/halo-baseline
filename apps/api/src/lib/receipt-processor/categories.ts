/**
 * The basket. Twelve categories, chosen for Nigeria, plus `null` for everything else.
 *
 * This list is the whole normalisation strategy. We do not build a product
 * master and we do not try to canonicalise `MAMA GOLD RICE 5KG` and
 * `Rice Local 5kg` into one string — we only ask which of these twelve a line
 * belongs to, and at what unit price. Brands differ in price *level* but move
 * together in *rate of change*, and the index is a rate of change, so the level
 * difference washes out.
 *
 * Statistics offices work the same way: they define a narrow basket and price
 * exactly that, rather than normalising everything a shop sells.
 *
 * Chosen from what actually appears on Nigerian grocery receipts — staples with
 * high purchase frequency and a comparable unit. Adding a category is cheap;
 * removing one after an index has published is not, because the published
 * series would change meaning underneath its consumers.
 */
export const ITEM_CATEGORIES = [
  'rice',
  'beans',
  'garri',
  'bread',
  'noodles',
  'cooking_oil',
  'eggs',
  'milk_powder',
  'sugar',
  'tomato_paste',
  'detergent',
  'soap',
] as const;

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/**
 * What the model is actually allowed to return, including the escape hatch.
 *
 * `other` exists because the model will not abstain. Measured on 320 real
 * receipts: told to return `null` when unsure, it returned a category for 78%
 * of lines and most were wrong — bottled water became `beans`, soy sauce became
 * `bread`, instant noodles became `rice`. A fixed label set makes the model
 * reach for the nearest label rather than decline, so the fix is to give it a
 * label meaning "none of these" and let it pick that instead.
 *
 * `other` is not a failure. On a real supermarket receipt most lines are
 * legitimately outside a twelve-item basket. They still count toward the user's
 * spend — they just cannot move a price series.
 */
export const EXTRACTION_LABELS = [...ITEM_CATEGORIES, 'other'] as const;
export type ExtractionLabel = (typeof EXTRACTION_LABELS)[number];

/** Narrows a model label to a basket category, or null for `other`. */
export function toCategory(label: string): ItemCategory | null {
  return (ITEM_CATEGORIES as readonly string[]).includes(label) ? (label as ItemCategory) : null;
}

/** Units a receipt may print. Normalised to the canonical unit before indexing. */
export const RAW_UNITS = [
  'kg',
  'g',
  'l',
  'ml',
  'piece',
  'pack',
  'crate',
  'loaf',
  'sachet',
  'tin',
] as const;
export type RawUnit = (typeof RAW_UNITS)[number];

/**
 * The unit each category is indexed in.
 *
 * Every observation is converted to this before it can enter the index, which
 * is what makes a 5 kg bag and a 25 kg bag comparable at all. A line we cannot
 * convert is dropped from the index — it still counts toward the user's spend,
 * but it cannot move a price series.
 */
export const CANONICAL_UNIT = {
  rice: 'kg',
  beans: 'kg',
  garri: 'kg',
  bread: 'loaf',
  noodles: 'pack',
  cooking_oil: 'l',
  eggs: 'crate',
  milk_powder: 'kg',
  sugar: 'kg',
  tomato_paste: 'kg',
  detergent: 'kg',
  soap: 'piece',
} as const satisfies Record<ItemCategory, RawUnit>;

/** Display labels. The app never shows the snake_case key. */
export const CATEGORY_LABEL = {
  rice: 'Rice',
  beans: 'Beans',
  garri: 'Garri',
  bread: 'Bread',
  noodles: 'Instant noodles',
  cooking_oil: "Cooking oil",
  eggs: 'Eggs',
  milk_powder: "Milk powder",
  sugar: 'Sugar',
  tomato_paste: "Tomato paste",
  detergent: 'Detergent',
  soap: 'Soap',
} as const satisfies Record<ItemCategory, string>;

/** Grouping used by the ledger screen. Not used by the index. */
export const CATEGORY_GROUP = {
  rice: 'groceries',
  beans: 'groceries',
  garri: 'groceries',
  bread: 'groceries',
  noodles: 'groceries',
  cooking_oil: 'groceries',
  eggs: 'groceries',
  milk_powder: 'groceries',
  sugar: 'groceries',
  tomato_paste: 'groceries',
  detergent: 'household',
  soap: 'household',
} as const satisfies Record<ItemCategory, "groceries" | "household">;

/** Multipliers into the canonical unit. `null` means the pair is not convertible. */
/**
 * Mass and volume convert. Nothing countable converts into anything but itself.
 *
 * `piece → crate` was already absent for the right reason: a crate of eggs is
 * thirty in Nigeria and twelve across much of Asia, so "6 EGGS" is not six
 * crates and no factor is right in both places. Every other cross-unit entry
 * here was the same bet, made without saying so, and each one was wrong inside
 * a single country rather than only across two:
 *
 *   `piece → pack`    Korea prints "신라면 5입" for one five-serving pack.
 *                     Read as five packs, that line priced noodles at a fifth
 *                     of what they cost — beside a "멀티팩" line on the next
 *                     receipt priced correctly, in the same country's median.
 *   `sachet → pack`   a sachet is one serving in Nigeria and Korea alike; a
 *                     pack is one serving in Nigeria and five in Korea.
 *   `piece → loaf`    "모닝빵 8개" is one bag of eight rolls, not eight loaves.
 *   `sachet → piece`  a sachet of shampoo is not a bar of soap.
 *   `tin → piece`     nor is a tin.
 *
 * Losing those costs observations, and observations are cheap — the floor is
 * twenty receipts and the corpus is over a million. A five-fold error inside a
 * published median is not cheap, and nothing downstream can detect it.
 */
const CONVERSION: Partial<Record<RawUnit, Partial<Record<RawUnit, number>>>> = {
  kg: { kg: 1 },
  g: { kg: 0.001 },
  l: { l: 1 },
  ml: { l: 0.001 },
  piece: { piece: 1 },
  pack: { pack: 1 },
  loaf: { loaf: 1 },
  crate: { crate: 1 },
  sachet: { sachet: 1 },
  tin: { tin: 1 },
};

/**
 * Numbers on a line that describe the product, not how much was bought.
 *
 * The prompt asks the model not to confuse these and the model confuses them
 * anyway — the same reason `applyExclusions` exists. A rule buried in a long
 * instruction is not reliably reached; a function is.
 *
 * `食パン 6枚切` is one loaf cut into six slices. Read as six, a ¥158 loaf
 * enters the index at ¥26. `即席麺 5食` is one multipack of five servings,
 * and five servings is what it is — the canonical unit for noodles is one
 * serving, so the five is right and only the *unit* is wrong when the model
 * answers `piece`.
 *
 * Returns the quantity and unit as they should have been printed, or the
 * originals untouched. It never invents a size for a line that has none:
 * that is the one thing the prompt is most insistent about and this must not
 * quietly undo it.
 */
export function readPrintedQuantity(
  category: ItemCategory,
  rawText: string,
  quantity: number | null,
  unit: RawUnit | null,
): { quantity: number | null; unit: RawUnit | null } {
  // "6枚切" / "8枚切" — how the loaf was sliced.
  if (category === 'bread' && /\d+\s*枚切/.test(rawText)) {
    return { quantity: 1, unit: 'loaf' };
  }

  // "5食" / "5個入" on instant noodles — servings, which is the unit the
  // category is indexed in. Only the label needs correcting.
  const servings = category === 'noodles' ? /(\d+)\s*食/.exec(rawText) : null;
  if (servings) {
    return { quantity: Number(servings[1]), unit: 'pack' };
  }

  return { quantity, unit };
}

/**
 * Converts a printed quantity to the category's canonical unit.
 *
 * Returns `null` rather than guessing. A line that cannot be converted is not a
 * failure of the receipt — it is a line we are not allowed to price, and
 * pretending otherwise would put a fabricated observation into a public index.
 */
export function toCanonicalQuantity(
  category: ItemCategory,
  quantity: number | null,
  unit: RawUnit | null,
): number | null {
  if (quantity === null || unit === null || quantity <= 0) return null;
  const target = CANONICAL_UNIT[category];
  const factor = CONVERSION[unit]?.[target];
  if (factor === undefined) return null;
  return quantity * factor;
}

/**
 * Unit price in the canonical unit, or `null` when the line cannot be priced.
 *
 * `lineTotal` is what was printed; the canonical quantity is what we derived.
 * Both must be present, which is exactly the coverage number the pilot has to
 * measure before any of this is worth building on.
 */
export function unitPrice(
  category: ItemCategory,
  lineTotal: number | null,
  quantity: number | null,
  unit: RawUnit | null,
): number | null {
  if (lineTotal === null || lineTotal <= 0) return null;
  // Two ways the quantity can be a number from somewhere else on the row.
  // Either one produces a unit price that is wrong rather than missing, and a
  // wrong one is pooled into the median everyone is compared against.
  if (!plausibleQuantity(quantity, unit)) return null;
  if (quantityLooksLikeThePrice(quantity, lineTotal)) return null;
  const canonical = toCanonicalQuantity(category, quantity, unit);
  if (canonical === null || canonical <= 0) return null;
  return lineTotal / canonical;
}

/**
 * Terms that rule a category out, whatever the model answered.
 *
 * The prompt asks for all of this and the prompt is not enough. Sampling 85
 * stored receipts found six of twenty basket lines in the wrong category;
 * naming each confusion in the prompt fixed three of them and left the rest,
 * because a rule buried in a long instruction is not reliably reached. These
 * lines are what the model kept getting wrong after being told:
 *
 *   LAVANDINA ODEX      bleach, filed as detergent — it is used on clothes,
 *                       so the model disagrees with the prompt and wins
 *   MILK WHOLE FIL 2L   fresh milk, filed as milk powder
 *   SHORTBREAD 210G     a biscuit, filed as bread
 *   多發酵乳 1795ML      a fermented milk drink, filed as milk powder
 *
 * A prompt is a request. This is the guarantee — deterministic, testable, and
 * it cannot drift between model versions. It only ever demotes a line to
 * `other`, so the worst case is a lost observation rather than a wrong price,
 * which is the trade this whole pipeline is built on.
 *
 * Every entry has to be unambiguous in its own language. `milk` is not here,
 * because milk powder is milk; `lavandina` is, because nothing else is called
 * that.
 */
/**
 * Fresh fruit and vegetables, which are sold loose by the kilo and therefore
 * land in whichever basket category is also sold by the kilo.
 *
 * Observed: `MARACUJA KG` and `GOIABA KG` — passion fruit and guava — both
 * filed as `beans` on a Brazilian receipt. Nothing about a legume price series
 * survives having guava in it.
 *
 * The list cannot be complete and does not need to be. It only demotes, so a
 * name that is missing costs one observation and a name that is present
 * prevents a wrong one.
 */
const FRESH_PRODUCE = [
  // Portuguese and Spanish, where this was measured.
  'maracuja', 'maracujá', 'goiaba', 'banana', 'laranja', 'abacaxi', 'mamao',
  'mamão', 'melancia', 'manga', 'limao', 'limão', 'cebola', 'batata',
  'cenoura', 'alface', 'tomate', 'naranja', 'manzana', 'platano', 'plátano',
  'sandia', 'sandía', 'cebolla', 'papa', 'zanahoria', 'lechuga',
  // English.
  'apple', 'orange', 'banana', 'mango', 'pineapple', 'watermelon', 'lettuce',
  'onion', 'potato', 'carrot', 'cabbage', 'cucumber', 'spinach',
  // Korean and Japanese.
  '사과', '바나나', '귤', '수박', '양파', '감자', '당근', '양배추', '상추',
  'りんご', 'バナナ', 'たまねぎ', 'じゃがいも',
] as const;

/**
 * Cooked dishes that carry a staple's name.
 *
 * Observed on one Nigerian restaurant receipt: `MSQ EGG ROLL` filed as eggs
 * and `MSQ BANGA RICE/D` filed as rice — a pastry and a stew. The prompt does
 * say restaurant items are `other`; the trouble is that the dish is named
 * after the ingredient, so the word the model is matching on is right there.
 *
 * A plate of jollof and a bag of rice do not move together, and the plate is
 * the more expensive of the two by an order of magnitude.
 */
const PREPARED_DISHES = [
  'jollof', 'fried rice', 'banga', 'biryani', 'risotto', 'paella', 'pilau',
  'rice roll', 'rice cake', 'egg roll', 'eggroll', 'egg sandwich', 'omelette',
  'omelet', 'french toast', 'bread roll', 'sandwich', 'burger', 'pizza',
  '볶음밥', '김밥', '주먹밥', 'チャーハン', '炒飯', '炒饭',
] as const;

const EXCLUDED_TERMS: Partial<Record<ItemCategory, readonly string[]>> = {
  // A dry staple in a bag. Fresh produce priced by the kilo is not one.
  beans: [...FRESH_PRODUCE, ...PREPARED_DISHES],
  rice: [...FRESH_PRODUCE, ...PREPARED_DISHES],
  garri: [...FRESH_PRODUCE, ...PREPARED_DISHES],
  sugar: FRESH_PRODUCE,
  eggs: PREPARED_DISHES,
  noodles: PREPARED_DISHES,
  // Paste in a tin or sachet. A fresh tomato is a different product on a
  // different price curve.
  tomato_paste: [...FRESH_PRODUCE, 'fresh tomato', 'tomate fresco', '방울토마토'],
  // Bleach and disinfectant. Sold beside detergent, used on clothes, and not
  // detergent: it whitens rather than washes, and its price per kilo belongs
  // to a different product.
  detergent: [
    'lavandina', 'lejia', 'lejía', 'hipoclorito', 'hypochlorite', 'javel',
    'clorox', 'bleach', '표백제', '락스', 'pemutih',
    // Paper goods, filed as detergent because they share the aisle.
    // Body wash, filed as detergent because it is also a liquid in a bottle.
    // Observed on a Japanese receipt: ボディソープ 詰替 400g priced at ¥920 a
    // kilo, beside a real laundry detergent median of about ¥420.
    'ボディソープ', 'ハンドソープ', 'シャンプー', 'body wash', 'body soap',
    'shower gel', 'hand wash', 'shampoo', '바디워시', '샴푸',
    'higienol', 'papel higien', 'toilet roll', 'toilet paper', 'kitchen roll',
    'tissue', '화장지', '휴지', 'tisu',
  ],
  soap: [
    'lavandina', 'lejia', 'lejía', 'hipoclorito', 'hypochlorite', 'javel',
    'clorox', 'bleach', '표백제', '락스', 'pemutih',
    'shampoo', 'champu', 'champú', 'toothpaste', 'dentifric', '치약', '샴푸',
  ],
  // The staple loaf. Biscuits and cake move on their own prices and would drag
  // a bread series with them.
  bread: [
    ...PREPARED_DISHES,
    'shortbread', 'biscuit', 'cookie', 'cracker', 'galleta', 'bizcocho',
    'cake', 'pastry', 'doughnut', 'donut', 'muffin', 'croissant',
    '과자', '비스킷', '쿠키', '케이크', '餅乾', 'ビスケット',
  ],
  milk_powder: [
    'uht', 'fresh milk', 'whole milk', 'milk whole', 'skimmed', 'semi skimmed',
    'evaporated', 'condensed', 'yoghurt', 'yogurt', 'yakult',
    '발효유', '우유', '牛奶', '鮮奶',
    // 発 and 發 are the same word in different scripts — Japanese shinjitai and
    // traditional Chinese. Writing one and not the other is how a Taiwanese
    // fermented-milk line walked straight past this list.
    '発酵乳', '發酵乳',
    'leche liquida', 'leche líquida', 'susu cair',
  ],
};

/**
 * Units that rule a category out.
 *
 * Milk powder is sold by weight. A line measured in litres is a drink, and the
 * prompt already says so — this is the same sentence in a form that executes.
 */
const EXCLUDED_UNITS: Partial<Record<ItemCategory, readonly RawUnit[]>> = {
  milk_powder: ['l', 'ml'],
};

/**
 * A volume printed inside the product description.
 *
 * The unit field only carries what the model decided the line was measured in,
 * and it is often null on exactly the lines that matter. The size is usually
 * sitting in the text regardless — `MILK WHOLE FIL 2L`, `多發酵乳-原味1795ML/瓶` —
 * and for a category sold by weight, a volume is conclusive. Both of those got
 * past a list of names; neither gets past this.
 */
const PRINTED_VOLUME = /\d\s*(ml|cl|l|lt|ltr|litre|liter)\b/i;

const VOLUME_IS_WRONG: readonly ItemCategory[] = ['milk_powder'];

/**
 * The category, after the exclusions.
 *
 * Returns `null` — meaning `other` — when the printed text or the printed unit
 * rules the model's answer out. Applied at the point lines are stored, so a
 * demoted line still counts toward what the shopper spent; it just cannot move
 * a price series.
 */
export function applyExclusions(
  category: ItemCategory,
  rawText: string,
  unit: RawUnit | null,
): ItemCategory | null {
  if (unit !== null && EXCLUDED_UNITS[category]?.includes(unit)) return null;
  if (VOLUME_IS_WRONG.includes(category) && PRINTED_VOLUME.test(rawText)) return null;

  const haystack = rawText.toLowerCase();
  const terms = EXCLUDED_TERMS[category];
  if (terms?.some((term) => haystack.includes(term))) return null;

  return category;
}

/**
 * How much of a thing a household buys in one go.
 *
 * A bound on the canonical quantity, not on the price — because the failure
 * this catches is the model writing a number from the wrong column into
 * `quantity`, and the giveaway is that the number is the wrong size rather
 * than that the price looks odd.
 *
 * Measured on real lines:
 *
 *   ACEITE CANUELAS   quantity 6500 ml, lineTotal 6500 — the Argentine peso
 *                     price, copied into the quantity field
 *   LIVIS             quantity 50 l of cooking oil, for one line on a
 *                     supermarket receipt
 *
 * Both would have produced a unit price several times below the real one and
 * dragged the median down for every shopper in the country. A refused price
 * costs one observation; this one costs everyone's comparison.
 *
 * The ranges are deliberately wide. They are not a view on what people should
 * buy — they exist to catch a number that came out of the wrong column, and a
 * bound that argues with a real shopper is worse than no bound at all.
 */
const PLAUSIBLE_QUANTITY: Record<RawUnit, readonly [number, number]> = {
  kg: [0.02, 60],
  g: [20, 60000],
  l: [0.05, 30],
  ml: [50, 30000],
  piece: [1, 200],
  pack: [1, 200],
  crate: [0.5, 30],
  loaf: [1, 50],
  sachet: [1, 500],
  tin: [1, 200],
};

/**
 * Whether a printed quantity is the sort of number a receipt actually carries.
 *
 * Checked against the unit as printed rather than after conversion, so the
 * bound is about the figure on the paper — which is where the mistake is.
 */
export function plausibleQuantity(quantity: number | null, unit: RawUnit | null): boolean {
  if (quantity === null || unit === null) return false;
  const [low, high] = PLAUSIBLE_QUANTITY[unit];
  return quantity >= low && quantity <= high;
}

/**
 * The same number in the quantity column and the amount column.
 *
 * On `ACEITE CANUELAS` the model returned quantity 6500 and lineTotal 6500,
 * which is the price twice. Small values are left alone — one item costing
 * exactly one unit of currency is a coincidence that really happens, and
 * refusing it would cost more than it saves.
 */
const COPIED_PRICE_FLOOR = 20;

export function quantityLooksLikeThePrice(
  quantity: number | null,
  lineTotal: number | null,
): boolean {
  if (quantity === null || lineTotal === null) return false;
  return lineTotal >= COPIED_PRICE_FLOOR && Math.abs(quantity - lineTotal) < 0.01;
}
