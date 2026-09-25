import { describe, expect, it } from 'vitest';
import { LINE_ITEM_PROMPT } from '../lib/receipt-processor/line-items-prompt';

/**
 * The prompt is the product, and it has no type.
 *
 * Every rule below was written because a real receipt was read wrongly, and
 * each is one careless edit away from being deleted by someone tidying up a
 * long string. These assertions are not testing the model — they are testing
 * that the instruction is still in the file.
 *
 * The specific confusions came from sampling 85 stored receipts through the
 * reparse probe: six of the twenty lines that landed in the basket were in the
 * wrong one, and every miss was an adjacent product pulled inward.
 */
describe('the line-item prompt still carries its hard-won rules', () => {
  const rules: [string, string][] = [
    // Bleach was filed as both detergent and soap, in Spanish.
    ['bleach is neither detergent nor soap', 'BLEACH IS NOT DETERGENT AND NOT SOAP'],
    ['names bleach in the languages it appears in', 'hipoclorito'],
    // A toilet-roll brand was filed as detergent.
    ['paper goods are not detergent', 'PAPER IS NOT DETERGENT'],
    // Fresh milk and a fermented milk drink were both filed as milk powder.
    ['liquid milk is not milk powder', 'LIQUID MILK IS NOT MILK POWDER'],
    // Shortbread was filed as bread.
    ['sweet baked goods are not bread', 'SWEET BAKED GOODS ARE NOT BREAD'],
    // Passion fruit and guava, filed as beans, because they were the only
    // other thing on the receipt priced by the kilo.
    ['fresh produce is not a basket item', 'FRESH FRUIT AND VEGETABLES ARE NOT A BASKET ITEM'],
    // The rule that stops a guessed pack size entering a public index.
    ['refuses to infer a pack size', 'NEVER infer a pack size'],
    // The one that made rice five times too expensive.
    ['reads a pack size as a total measure', 'TOTAL MEASURE BOUGHT ON THAT LINE'],
    // Without this the product description carries the price columns with it.
    ['keeps the numeric columns out of rawText', 'PRODUCT DESCRIPTION only'],
    // A crate is thirty eggs in Nigeria and twelve in much of Asia.
    ['knows a Korean crate of eggs', '한판'],
  ];

  for (const [what, needle] of rules) {
    it(what, () => {
      expect(LINE_ITEM_PROMPT).toContain(needle);
    });
  }

  it('offers `other` as a real answer rather than a failure', () => {
    // Measured before this line existed: told to return null when unsure, the
    // model labelled 78% of lines anyway and most were wrong.
    expect(LINE_ITEM_PROMPT).toContain('"other" is a real answer');
  });
});
