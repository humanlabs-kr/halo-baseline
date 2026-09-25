import { describe, expect, it } from 'vitest';
import { applyExclusions } from '../lib/receipt-processor/categories';

/**
 * The lines the model kept putting in the wrong basket after being told not to.
 *
 * Each of these came off a real receipt in production, was sampled through the
 * reparse probe, and survived a prompt change that named it explicitly. The
 * prompt is a request; this is the guarantee.
 *
 * The rule is one-directional on purpose: exclusions only ever demote a line to
 * `other`. A lost observation costs one reading. A wrong one corrupts the
 * median every other shopper in that country is compared against, and nothing
 * downstream can tell the two apart.
 */
describe('what a category cannot contain', () => {
  const wrong: [string, Parameters<typeof applyExclusions>[0], string][] = [
    ['bleach is not detergent', 'detergent', 'LAVANDINA ODEX CQ4'],
    ['bleach is not soap', 'soap', 'HIPOCLORITO'],
    ['bleach in English is not detergent', 'detergent', 'CLOROX REGULAR BLEACH'],
    ['bleach in Korean is not detergent', 'detergent', '유한락스 1L'],
    ['toilet roll is not detergent', 'detergent', 'Higienol Max 80'],
    ['tissue is not detergent', 'detergent', 'KITCHEN ROLL 2PK'],
    ['shampoo is not soap', 'soap', 'SHAMPOO ANTI CASPA'],
    ['shortbread is not bread', 'bread', 'SHORTBREAD 210G'],
    ['a biscuit is not bread', 'bread', 'GALLETAS OREO 118G'],
    ['cake is not bread', 'bread', 'CHOCOLATE CAKE SLICE'],
    ['fresh milk is not milk powder', 'milk_powder', 'MILK WHOLE FIL 2L'],
    ['a fermented milk drink is not milk powder', 'milk_powder', '多發酵乳-原味1795ML/瓶'],
    ['yoghurt is not milk powder', 'milk_powder', 'YOGURT NATURAL 1KG'],
  ];

  for (const [what, category, rawText] of wrong) {
    it(what, () => {
      expect(applyExclusions(category, rawText, null)).toBeNull();
    });
  }

  it('demotes milk sold by the litre whatever it is called', () => {
    // The unit is the objective signal: powder is sold by weight. This catches
    // the liquid milks nobody has written a word for yet.
    expect(applyExclusions('milk_powder', 'SOMETHING UNFAMILIAR', 'l')).toBeNull();
    expect(applyExclusions('milk_powder', 'SOMETHING UNFAMILIAR', 'ml')).toBeNull();
  });
});

/**
 * The other half, and the half that would break the product if it went wrong.
 *
 * An exclusion list that is too eager empties the basket, and an empty basket
 * is a ledger with nothing to compare. Every line below is a real basket item
 * that has to survive.
 */
describe('what a category does contain', () => {
  const right: [string, Parameters<typeof applyExclusions>[0], string][] = [
    ['actual milk powder, which is milk', 'milk_powder', '即溶全脂奶粉500G'],
    ['milk powder in English', 'milk_powder', 'NIDO FULL CREAM MILK POWDER 400G'],
    ['milk powder in Korean', 'milk_powder', '남양 분유 800g'],
    ['a plain loaf', 'bread', 'ALBANY WHITE BREAD'],
    ['a loaf with a weight on it', 'bread', 'Warburtons Original Farmhouse 800g'],
    ['a loaf in Korean', 'bread', '식빵 한 봉지'],
    ['brioche, which is still a loaf', 'bread', 'BRIOCHE LOAF SLICE'],
    ['washing powder', 'detergent', 'OMO WASHING POWDER 900G'],
    ['washing powder in Spanish', 'detergent', 'JABON EN POLVO ALA 800G'],
    ['bar soap', 'soap', 'LIFEBUOY SOAP 175G'],
    ['rice', 'rice', 'MAMA GOLD RICE 5KG'],
    ['cooking oil', 'cooking_oil', 'RINA VEG OIL 5L'],
    ['sugar', 'sugar', 'ACUCAR ITAMARATI'],
  ];

  for (const [what, category, rawText] of right) {
    it(what, () => {
      expect(applyExclusions(category, rawText, null)).toBe(category);
    });
  }

  it('lets milk powder keep a weight unit', () => {
    expect(applyExclusions('milk_powder', 'NIDO 400G', 'g')).toBe('milk_powder');
    expect(applyExclusions('milk_powder', 'NIDO 1KG', 'kg')).toBe('milk_powder');
  });
});

/**
 * Fresh produce, which finds whichever basket category shares its unit.
 *
 * Measured on a Brazilian receipt: passion fruit and guava, both priced by the
 * kilo, both filed as `beans`. The basket's kilo categories are dry staples
 * and a legume series does not survive having guava in it.
 */
describe('fresh produce is not a dry staple', () => {
  const produce: [Parameters<typeof applyExclusions>[0], string][] = [
    ['beans', 'MARACUJA KG'],
    ['beans', 'GOIABA KG'],
    ['beans', 'BANANA PRATA KG'],
    ['rice', 'BATATA INGLESA KG'],
    ['garri', 'CEBOLA BRANCA KG'],
    ['sugar', 'LARANJA PERA KG'],
    ['tomato_paste', 'TOMATE ITALIANO KG'],
    ['beans', '양파 1kg'],
  ];

  for (const [category, rawText] of produce) {
    it(`${rawText} is not ${category}`, () => {
      expect(applyExclusions(category, rawText, null)).toBeNull();
    });
  }

  it('still keeps the dry staples themselves', () => {
    expect(applyExclusions('beans', 'FEIJAO CARIOCA 1KG', 'kg')).toBe('beans');
    expect(applyExclusions('beans', 'EWA OLOYIN 2KG', 'kg')).toBe('beans');
    expect(applyExclusions('rice', 'MAMA GOLD RICE 5KG', 'kg')).toBe('rice');
    expect(applyExclusions('garri', 'GARRI IJEBU 5KG', 'kg')).toBe('garri');
    expect(applyExclusions('tomato_paste', 'GINO TOMATO PASTE 210G', 'g')).toBe('tomato_paste');
    expect(applyExclusions('sugar', 'ACUCAR ITAMARATI', null)).toBe('sugar');
  });
});
