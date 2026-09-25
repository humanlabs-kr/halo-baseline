import { EXTRACTION_LABELS } from './categories';

/**
 * The line-item half of the vision prompt.
 *
 * Kept apart from `RECEIPT_SYSTEM_PROMPT` because the two are tuned against
 * different things: the existing prompt decides whether a receipt earns points
 * and has been calibrated on real submissions, and a line-item mistake must not
 * be able to change a payout. Compose them, do not merge them.
 *
 * The rules below are deliberately restrictive. A missing line costs us one
 * observation out of a corpus of millions; an invented one puts a fabricated
 * price into a public index, which is the failure that would actually matter.
 */
export const LINE_ITEM_PROMPT = `
================================================================
STEP 2 — LINE ITEMS
================================================================
Read the purchased lines off the receipt. Output one entry per printed line.

WHAT IS A LINE ITEM
  Only goods or services actually purchased.
  NOT line items — skip these entirely:
    - Subtotal, total, balance, change, rounding
    - Tax / VAT lines
    - Discounts, coupons, loyalty points, refunds
    - Payment method lines, card numbers, approval codes
    - Store headers, addresses, phone numbers, thank-you text

FIELDS PER LINE
  rawText    : the PRODUCT DESCRIPTION only, exactly as printed — brand, name
               and pack size. Keep the spelling, the abbreviations and the
               capitalisation. Do not clean it up or translate it.

               Leave OUT the numeric columns and codes that share the printed
               row. Many receipts are laid out as a table:

                   상품명              단가    수량    금액
                   오징어&새우튀김    25,000    1     25,000
                   000044

               There, rawText is "오징어&새우튀김" — not
               "오징어&새우튀김 000044 25,000 1 25,000". The quantity and the
               amount have their own fields below, and the product code is not
               part of the name. The same applies to every layout that puts a
               price, a unit price, a quantity, a SKU, a barcode or a tax
               marker on the item's row.
  category   : one of [${EXTRACTION_LABELS.join(', ')}].
  quantity   : the number of units, or null.
  unit       : one of [kg, g, l, ml, piece, pack, crate, loaf, sachet, tin], or null.
  lineTotal  : the amount printed for that line, or null.

CATEGORY — PICK ONE, ALWAYS
  You MUST return exactly one label. "other" is a real answer, not a failure.
  Most lines on a real receipt are "other". Returning "other" often is CORRECT.

  TWO PAIRS THAT GET CONFUSED — measured failures, read carefully:
    soap      = bar or liquid soap for washing the BODY (e.g. "Sabun Lifebuoy").
                Shampoo is NOT soap. Toothpaste is NOT soap. Dish liquid is NOT soap.
    detergent = powder or liquid for washing CLOTHES only.
                Body soap is NOT detergent.
    If a line is shampoo, conditioner, toothpaste, or dishwashing liquid -> other.

  FOUR MORE THAT GET CONFUSED — every one of these was observed on a real
  receipt and every one was put in the wrong basket:

    BLEACH IS NOT DETERGENT AND NOT SOAP.
      lavandina · lejía · hipoclorito · cloro · eau de javel · 표백제 · 락스
      · pemutih · bleach  -> ALWAYS other.
      It whitens; it does not wash clothes and it does not wash a body.

    PAPER IS NOT DETERGENT.
      toilet roll, kitchen roll, tissue, napkins, wipes
      · papel higiénico · 화장지, 휴지 · tisu  -> other.

    LIQUID MILK IS NOT MILK POWDER.
      milk_powder means POWDER, in a tin or a sachet, that you mix with water.
      Fresh milk, UHT milk, a milk carton, a bottle, condensed or evaporated
      milk, yoghurt drinks, fermented milk
      · leche (líquida) · 우유 · susu cair · 牛奶 · 発酵乳  -> other.
      A size in ML or L is the giveaway: powder is sold by weight.

    SWEET BAKED GOODS ARE NOT BREAD.
      biscuits, shortbread, cookies, cake, pastry, doughnuts, crackers, buns
      with a sweet filling · galletas · bizcocho · 과자, 비스킷 · 餅乾  -> other.
      bread means the plain staple loaf people eat with a meal.

    FRESH FRUIT AND VEGETABLES ARE NOT A BASKET ITEM.
      Anything sold loose by weight from the produce aisle — fruit, greens,
      onions, potatoes, tomatoes · maracuja · goiaba · cebolla · 사과, 양파
      -> other.
      beans means DRIED beans or lentils in a bag. tomato_paste means paste in
      a tin or a sachet. Observed: "MARACUJA KG" and "GOIABA KG" — passion
      fruit and guava — both filed as beans, because they are the only other
      thing on the receipt priced by the kilo.

  These are all "other" — do not force them into a category:
    Bottled water, soft drinks, coffee, tea   -> other
    Milk of any kind that is not powder       -> other
    Soy sauce, syrup, seasoning, spices       -> other
    Snacks, wafers, chips, sweets, biscuits   -> other
    Toothpaste, shampoo, conditioner, tissue  -> other
    Dishwashing liquid, cleaning spray        -> other
    Bleach and disinfectant                   -> other
    Cheese, ham, yoghurt                      -> other
    Prepared or cooked food, restaurant items -> other
    Plastic bags, service charges, fuel       -> other
    Medicine, clothing, electronics, tyres    -> other

  THE TWELVE IN OTHER LANGUAGES
  Receipts are printed in the language of the shop. Reading the word is not
  brand knowledge — it is reading. These name the same twelve:
    rice         쌀, 백미, 햇반 · beras · ìrẹsì · mchele · arroz · 米, お米, 精米
    beans        콩, 대두 · kacang · ewa · maharage · frijoles · 大豆, 豆
    garri        gari, garri, eba
    bread        빵, 식빵 · roti · buredi · pan · 食パン, パン
                 The staple loaf. Biscuits and cake are "other".
    noodles      라면, 면 · mie, indomie · nouilles · 即席麺, インスタント麺, ラーメン
    cooking_oil  식용유, 기름 · minyak goreng · epo · mafuta · aceite
                 サラダ油, キャノーラ油, ごま油, オリーブオイル
    eggs         계란, 달걀 · telur · ẹyin · mayai · huevos · たまご, 卵, 鶏卵
                 한판 / 한 판 / 30구 is one crate of eggs.
    milk_powder  분유 · susu bubuk · leche en polvo · 粉ミルク
                 POWDER ONLY. Liquid milk of any kind is "other".
    sugar        설탕 · gula · suga · sukari · azúcar · 砂糖, 上白糖, グラニュー糖
    tomato_paste 토마토 페이스트 · pasta tomat · tomato puree · トマトペースト
    detergent    세제, 세탁세제 · deterjen · sabun cuci · jabón en polvo (CLOTHES)
                 洗濯洗剤, 衣料用洗剤. Bleach is not detergent.
    soap         비누 · sabun mandi · jabón de tocador (BODY)
                 石けん, ボディソープ. Bleach is not soap.

  Decide from the PRINTED TEXT ONLY. If the text does not clearly name one of the
  twelve, the answer is "other". Never reason from brand knowledge.

QUANTITY AND UNIT — STRICTEST RULE ON THIS PAGE

  quantity is the TOTAL MEASURE BOUGHT ON THAT LINE, not the number of packs.

  Two numbers are usually printed and they multiply:
    (a) the pack size, inside the product name  — "5KG", "1L", "30구"
    (b) how many packs, in a quantity column    — the "1" or "2" beside it

    상품명              단가      수량    금액
    햇반 백미 5KG      18,900      1     18,900
      -> quantity 5, unit kg.   NOT quantity 1.
         One pack of five kilos is five kilos.

    식용유 1.8L         9,400      2     18,800
      -> quantity 3.6, unit l.  Two bottles of 1.8 litres.

    MAMA GOLD RICE 5KG            1      4,200
      -> quantity 5, unit kg.

  Getting this wrong is not a small error: it is what the price per kilo is
  computed from. Reading a 5 kg sack as 1 kg makes it five times too expensive,
  and that number is pooled with every other shopper's.

  - A measure written in WORDS counts as a pack size. "CRATE OF EGGS" is
    quantity 1, unit crate. "한판" / "한 판" is one crate. "LOAF OF BREAD" is
    one loaf. A tin, a sachet, a bottle, a pack — use the unit it names.
  - "2 x 500G" means quantity 1000, unit g (total across the line).
  - A count with no measure at all ("3 BREAD") is quantity 3, unit piece.
  - Some numbers on a line describe the PRODUCT, not how much was bought.
    Japanese bread prints how it was sliced: "食パン 6枚切" is one loaf cut
    into six, so quantity 1, unit loaf — NOT quantity 6. Same for "8枚切",
    "4枚切". Observed: the model answered quantity 6, unit piece, which prices
    a single loaf at a sixth of its cost. "10個入" and "10個" on eggs ARE a
    count — quantity 10, unit piece — because that is how many you get.
  - NEVER infer a pack size from the brand, the price, or what is typical.
    "INDOMIE" with no size is quantity null, unit null. Not "1 pack".
    "ACUCAR ITAMARATI" with no size is quantity null, unit null — even though
    that brand is usually sold in a one-kilo bag. Observed: the model answered
    "1 kg" for exactly that line. It was right, and it must still not do it.
    A guessed pack size does not produce a missing number, it produces a
    WRONG unit price, and that number is pooled into the figure every other
    shopper in the country is compared against. There is no way to tell a
    guess from a reading after the fact.
    If you cannot point at characters on the receipt that state the size,
    the answer is null.
  - If only a per-unit price is printed and no quantity, return null for both.

LINE TOTAL
  - Must be the amount printed on that line, after any per-line discount shown there.
  - If the receipt prints only a unit price and a quantity, multiply them.
  - If no amount can be read for the line, return null.

ORDERING
  - lineNo starts at 1 and follows the printed order, top to bottom.

IF THE IMAGE IS NOT A RECEIPT, OR STEP 0 FAILED
  - Return an empty lineItems array. Do not invent lines.
`;

/** JSON-schema fragment for `lineItems`, merged into the strict response schema. */
export const LINE_ITEMS_JSON_SCHEMA = {
  type: 'array',
  description:
    "Purchased lines, in printed order. Empty when none could be read.",
  items: {
    type: 'object',
    properties: {
      lineNo: {
        type: 'integer',
        description: "1-based position in printed order.",
      },
      rawText: {
        type: 'string',
        description:
          'The product description only, exactly as printed. Excludes the price, unit price, quantity and product code columns that share its row.',
      },
      category: {
        type: 'string',
        enum: [...EXTRACTION_LABELS],
        description: 'Basket category, or `other` when the line is outside the basket.',
      },
      quantity: {
        type: ['number', 'null'],
        description: "Printed quantity, never inferred.",
      },
      unit: {
        type: ['string', 'null'],
        enum: [
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
          null,
        ],
        description: "Printed unit, never inferred.",
      },
      lineTotal: {
        type: ['number', 'null'],
        description: "Amount printed for the line.",
      },
    },
    required: [
      "lineNo",
      "rawText",
      "category",
      "quantity",
      "unit",
      "lineTotal",
    ],
    additionalProperties: false,
  },
} as const;
