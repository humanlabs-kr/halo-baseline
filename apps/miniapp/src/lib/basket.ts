import type { TFunction } from 'i18next';

/**
 * The twelve basket categories, named on screen.
 *
 * The API sends both a `category` key and an English `label`. Only the key is
 * usable: a label rendered by the server is a string the client cannot
 * translate, and it was reaching Korean screens as "Rice" and "Cooking oil"
 * beside Korean product names. The key is the contract; the word is the
 * client's business.
 *
 * Grouped the same way — `Groceries` and `Household` were the same problem one
 * level up.
 */
export function categoryName(category: string | null, t: TFunction): string {
  if (category === null) return t('Uncategorised');
  return t(`category.${category}`, { defaultValue: category });
}

export function groupName(group: string, t: TFunction): string {
  return t(`group.${group}`, { defaultValue: group });
}

/** The unit a category's price is quoted in, spoken rather than abbreviated. */
export function unitName(unit: string, t: TFunction): string {
  return t(`unit.${unit}`, { defaultValue: unit });
}

/**
 * One of the unit, as a shopper says it: "1kg", "한 판", "1 crate".
 *
 * Prices in this app are always the price of one unit, and the screens were
 * labelling them with a preposition — "kg당 3,780원", "per crate". That is
 * correct and it is not how anyone reads a shelf. A shelf says 1kg 3,780원,
 * and the quantity in front of the unit is what makes the number look like a
 * price rather than a rate.
 *
 * Countable units take the language's own counter ("한 판", not "1 판"), so
 * this cannot be assembled from `unitName` and a numeral.
 */
export function unitEach(unit: string, t: TFunction): string {
  return t(`unitEach.${unit}`, { defaultValue: `1 ${unitName(unit, t)}` });
}

/**
 * A month from a `YYYY-MM` key, in the language on screen.
 *
 * The ledger had a hardcoded English array and used it for the month switcher,
 * both comparison bars and the summary line — so a Korean screen headed
 * "September 2026" over "1–20 Sep". `Intl` already knows every month in every
 * language we ship; the array only ever existed because it was quicker.
 */
export function monthLabel(
  month: string | undefined,
  lang: string,
  style: 'long' | 'short' = 'long',
): string {
  if (!month) return '';
  const [year, index] = month.split('-').map(Number) as [number, number];
  const at = new Date(Date.UTC(year, index - 1, 1));

  return new Intl.DateTimeFormat(lang, {
    month: style,
    ...(style === 'long' ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(at);
}
