import { describe, expect, it } from 'vitest';
import { createFormatters } from '@/lib/format';
import { SUPPORTED_LANGS } from '@/lib/i18n';

/**
 * The month span under the ledger's headline figure.
 *
 * `Intl.DateTimeFormat.formatRange` answers a range in Japanese and Chinese
 * with a numeric pattern whatever skeleton it was given, so `09/01～09/21` sat
 * directly above day headings reading `9月20日` — three date formats in one
 * column, on the most-read screen in the app. Nothing throws and nothing is
 * wrong enough to notice in a diff.
 */
const FROM = new Date(2026, 8, 1);
const TO = new Date(2026, 8, 21);

describe('dayRange', () => {
  it('writes a range the way the language writes a date', () => {
    for (const lang of SUPPORTED_LANGS) {
      const fmt = createFormatters(lang);
      const range = fmt.dayRange(FROM, TO);
      const single = fmt.day(FROM);

      // Every mark a single date carries has to be in the range. In Japanese
      // that is 月 and 日; the numeric pattern has neither.
      for (const mark of single.replace(/[\d\s]/g, '')) {
        expect(range, `${lang}: ${range} lost "${mark}" from ${single}`).toContain(mark);
      }
    }
  });

  it('names both ends where the language cannot elide one', () => {
    // Korean and English drop the repeated month — "9월 1일~21일". Japanese
    // has no elided form in this skeleton, so both dates are written out
    // rather than silently falling back to slashes.
    expect(createFormatters('ja').dayRange(FROM, TO)).toBe('9月1日～9月21日');
    expect(createFormatters('ko').dayRange(FROM, TO)).toBe('9월 1일~21일');
  });
});
