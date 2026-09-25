import { describe, expect, it } from 'vitest';
import { resolveLanguage, SUPPORTED_LANGS, REFERENCE_LANG } from '../lib/i18n';

/**
 * What a device actually reports, per language we ship.
 *
 * Not one of these is the bare code for the ten locales listed bare: a Korean
 * iPhone says `ko-KR`, never `ko`. Every one of those ten resolved to English
 * in production while the locale files were complete and the locale check was
 * green — the failure is in the resolution, so that is what this tests.
 */
const DEVICE_CODES: Record<string, string[]> = {
  'de-DE': ['de-DE', 'de', 'de-AT', 'de-CH'],
  en: ['en-US', 'en'],
  'en-GB': ['en-GB'],
  'es-419': ['es-MX', 'es-AR', 'es-CO', 'es-419'],
  'es-ES': ['es-ES', 'es'],
  'fr-FR': ['fr-FR', 'fr', 'fr-CA'],
  hi: ['hi-IN', 'hi'],
  id: ['id-ID', 'id'],
  ja: ['ja-JP', 'ja'],
  ko: ['ko-KR', 'ko'],
  'ms-MY': ['ms-MY', 'ms'],
  'nl-NL': ['nl-NL', 'nl'],
  pl: ['pl-PL', 'pl'],
  'pt-BR': ['pt-BR', 'pt'],
  'pt-PT': ['pt-PT'],
  sw: ['sw-KE', 'sw-TZ', 'sw'],
  th: ['th-TH', 'th'],
  tl: ['tl-PH', 'tl'],
  vi: ['vi-VN', 'vi'],
  'zh-CN': ['zh-CN', 'zh', 'zh-Hans-CN'],
  'zh-TW': ['zh-TW', 'zh-Hant', 'zh-Hant-TW'],
};

describe('resolveLanguage', () => {
  it('covers every language we ship', () => {
    expect(Object.keys(DEVICE_CODES).sort()).toEqual([...SUPPORTED_LANGS].sort());
  });

  for (const [lang, codes] of Object.entries(DEVICE_CODES)) {
    for (const code of codes) {
      it(`${code} → ${lang}`, () => {
        expect(resolveLanguage(code)[0]).toBe(lang);
      });
    }
  }

  it('every chain ends at the reference locale', () => {
    for (const codes of Object.values(DEVICE_CODES)) {
      for (const code of codes) {
        expect(resolveLanguage(code)).toContain(REFERENCE_LANG);
      }
    }
  });

  it('an unknown language is English, not a crash', () => {
    for (const code of ['xx', 'xx-YY', '', 'not-a-code']) {
      expect(resolveLanguage(code)[0]).toBe(REFERENCE_LANG);
    }
    expect(resolveLanguage(undefined)[0]).toBe(REFERENCE_LANG);
  });

  it('Traditional Chinese is decided by script, not region', () => {
    // zh-Hant-TW must not be reduced to `zh` and land on Simplified.
    expect(resolveLanguage('zh-Hant-HK')[0]).toBe('zh-TW');
    expect(resolveLanguage('zh-Hans-SG')[0]).toBe('zh-CN');
  });
});
