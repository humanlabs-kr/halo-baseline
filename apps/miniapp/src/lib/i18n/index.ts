import i18n, { type BackendModule, type ReadCallback } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

/**
 * Every locale Halo ships. Single source of truth: the i18next `supportedLngs`,
 * the lazy loader below and `scripts/check-locales.mjs` all read this list, so a
 * file added to `locales/` without being listed here fails `pnpm test`.
 */
export const SUPPORTED_LANGS = [
  'de-DE',
  'en',
  'en-GB',
  'es-419',
  'es-ES',
  'fr-FR',
  'hi',
  'id',
  'ja',
  'ko',
  'ms-MY',
  'nl-NL',
  'pl',
  'pt-BR',
  'pt-PT',
  'sw',
  'th',
  'tl',
  'vi',
  'zh-CN',
  'zh-TW',
] as const;

export type LangCode = (typeof SUPPORTED_LANGS)[number];

/** Locale file used as the reference for `check-locales` and as the fallback. */
export const REFERENCE_LANG: LangCode = 'en';

/**
 * Where a language code that is not in `SUPPORTED_LANGS` should land.
 *
 * Two directions, and only one of them used to work.
 *
 * **Bare to regional.** Eleven locales exist only as regional variants, so a
 * device reporting "de" has to be sent to "de-DE".
 *
 * **Regional to bare.** Ten locales are listed bare — ko, ja, id, th, vi, hi,
 * sw, tl, pl, en — and no device reports them that way. A Korean iPhone says
 * `ko-KR`, an Indonesian Android says `id-ID`. With
 * `nonExplicitSupportedLngs: false` those are judged unsupported and dropped
 * to English, which is what every user in Korea, Indonesia, Vietnam,
 * Thailand, Kenya, the Philippines, India, Japan and Poland was getting: ten
 * of the twenty-one languages we ship, unreachable from an actual phone. The
 * locale files were complete and `check-locales` was green.
 *
 * That flag is still correct — turning it on breaks the regional locales, and
 * there is a comment in `init` explaining how. The missing half is this
 * resolver, which handles both directions explicitly instead of letting
 * i18next guess in either.
 */
const REGIONAL_PREFERENCES: Record<string, readonly LangCode[]> = {
  de: ['de-DE'],
  es: ['es-ES'],
  fr: ['fr-FR'],
  ms: ['ms-MY'],
  nl: ['nl-NL'],
  pt: ['pt-BR'],
  zh: ['zh-CN'],
  // Traditional Chinese by script, whatever the region says.
  'zh-hant': ['zh-TW'],
  // Latin America has its own Spanish and it is not Spain's.
  'es-419': ['es-419'],
  'es-ar': ['es-419'], 'es-bo': ['es-419'], 'es-cl': ['es-419'], 'es-co': ['es-419'],
  'es-cr': ['es-419'], 'es-do': ['es-419'], 'es-ec': ['es-419'], 'es-gt': ['es-419'],
  'es-hn': ['es-419'], 'es-mx': ['es-419'], 'es-ni': ['es-419'], 'es-pa': ['es-419'],
  'es-pe': ['es-419'], 'es-pr': ['es-419'], 'es-py': ['es-419'], 'es-sv': ['es-419'],
  'es-us': ['es-419'], 'es-uy': ['es-419'], 'es-ve': ['es-419'],
};

/**
 * Resolves whatever a device reports into the closest locale we ship.
 *
 * Passed to i18next as `fallbackLng`, which accepts a function and calls it
 * with the code that failed the `supportedLngs` check.
 */
export function resolveLanguage(code?: string): [LangCode, ...LangCode[]] {
  const chain: LangCode[] = [];
  const add = (lang: LangCode) => { if (!chain.includes(lang)) chain.push(lang); };

  if (code) {
    const lower = code.toLowerCase();

    // Exactly what we ship, in whatever casing the device used.
    const exact = SUPPORTED_LANGS.find((lang) => lang.toLowerCase() === lower);
    if (exact) add(exact);

    // Script before region: zh-Hant-TW is Traditional, zh-CN is not.
    const script = lower.split('-').slice(0, 2).join('-');
    for (const key of [lower, script]) {
      for (const lang of REGIONAL_PREFERENCES[key] ?? []) add(lang);
    }

    // ko-KR -> ko, id-ID -> id.
    const base = lower.split('-')[0]!;
    const bare = SUPPORTED_LANGS.find((lang) => lang.toLowerCase() === base);
    if (bare) add(bare);

    // de-AT -> de -> de-DE.
    for (const lang of REGIONAL_PREFERENCES[base] ?? []) add(lang);
  }

  add(REFERENCE_LANG);

  // Non-empty by construction — the reference locale was just added — and the
  // type says so, because `convertDetectedLanguage` takes the first element
  // and has no answer for `undefined`.
  return chain as [LangCode, ...LangCode[]];
}

/**
 * Names for the language picker.
 *
 * Endonyms, not English names: someone who cannot read the current UI language
 * is exactly the person using this list, so "한국어" has to be findable without
 * reading "Korean". Written out rather than derived from `Intl.DisplayNames`
 * so the picker cannot change wording between devices or come back blank on a
 * webview with a trimmed ICU build.
 */
export const LANGUAGE_NAMES: Record<LangCode, string> = {
  'de-DE': 'Deutsch',
  en: 'English',
  'en-GB': 'English (UK)',
  'es-419': 'Español (Latinoamérica)',
  'es-ES': 'Español (España)',
  'fr-FR': 'Français',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  ja: '日本語',
  ko: '한국어',
  'ms-MY': 'Bahasa Melayu',
  'nl-NL': 'Nederlands',
  pl: 'Polski',
  'pt-BR': 'Português (Brasil)',
  'pt-PT': 'Português (Portugal)',
  sw: 'Kiswahili',
  th: 'ไทย',
  tl: 'Filipino',
  vi: 'Tiếng Việt',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
};

/**
 * Locale loaders, one dynamic chunk per language.
 *
 * Importing all 40 files at the top level would put every translation of the
 * app into the main bundle (~300 KB of JSON) so that each user could read one
 * of them. `import.meta.glob` without `eager` leaves them as separate chunks
 * that are fetched on demand; only `en` is bundled, as the fallback that must
 * always be present for first paint.
 */
const localeLoaders = import.meta.glob<{ default: Record<string, string> }>('./locales/*.json');

const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init: () => {
    // No options to read — the loader map is resolved at build time.
  },
  read: (language: string, _namespace: string, callback: ReadCallback) => {
    const load = localeLoaders[`./locales/${language}.json`];
    if (!load) {
      // Not an error: i18next also asks for intermediate forms such as "ko-KR"
      // before falling back to "ko". An empty bundle lets that resolution run.
      callback(null, {});
      return;
    }
    load()
      .then((module) => callback(null, module.default))
      .catch((error: unknown) => callback(error as Error, false));
  },
};

const STORED_KEY = 'halo.lang';
const CHOICE_KEY = 'halo.lang.chosen';

/**
 * Clears a stored language that the old, broken detector wrote.
 *
 * Until `convertDetectedLanguage` landed, every device reporting a regional
 * code for one of the ten bare-listed locales — `ko-KR`, `id-ID`, `vi-VN` and
 * the rest — resolved to English, and the detector cached that. localStorage
 * is first in the detection order, so fixing the resolver does nothing for
 * anyone who has already opened the app: they stay on English forever.
 *
 * So the stored value is dropped once, if and only if it disagrees with what
 * this device would resolve to now. An explicit pick from the language screen
 * sets `CHOICE_KEY` and is never touched — someone who chose English on a
 * Korean phone meant it.
 *
 * Runs before `init`, because that is when the detector reads storage.
 */
function repairStoredLanguage(): void {
  try {
    const stored = localStorage.getItem(STORED_KEY);
    if (!stored || localStorage.getItem(CHOICE_KEY)) return;

    const device = navigator.languages?.[0] ?? navigator.language;
    if (stored !== resolveLanguage(device)[0]) localStorage.removeItem(STORED_KEY);
  } catch {
    // No storage at all. Detection falls through to the device, which is the
    // outcome this function is trying to reach anyway.
  }
}

repairStoredLanguage();

void i18n
  .use(lazyLocaleBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // `en` ships in the main bundle; every other language arrives through the
    // backend above. `partialBundledLanguages` is what lets the two coexist.
    resources: { en: { translation: en } },
    partialBundledLanguages: true,
    fallbackLng: resolveLanguage,
    supportedLngs: [...SUPPORTED_LANGS],
    // `nonExplicitSupportedLngs` must stay off, and the reason is not obvious.
    //
    // When it is on, i18next reduces a code to its base language *before*
    // checking `supportedLngs`:
    //
    //   isSupportedCode('de-DE') -> supportedLngs.includes('de')
    //
    // Eleven of the twenty-one locales we ship are region-tagged (de-DE,
    // pt-BR, zh-CN, es-419, …) and the bare forms are deliberately not in the
    // list, so every one of them was judged unsupported and fell back to
    // English — about a fifth of our users, with no error anywhere. The locale
    // files were complete and `check-locales` was green the whole time;
    // nothing but rendering the page in German could show it.
    //
    // Bare codes are already handled, and handled better, by
    // `BASE_LANGUAGE_FALLBACKS` above: a device reporting "de" resolves to
    // de-DE explicitly, instead of i18next guessing.
    nonExplicitSupportedLngs: false,
    // Locale files are flat maps of string to string — `check-locales` fails
    // the build on anything else — so i18next's structural separators have no
    // job here, and leaving them on breaks real keys. Source-text keys are
    // keyed by their English copy, and "Free download on iOS & Android."
    // would otherwise be read as a path into a nested object that does not
    // exist: the lookup misses, i18next returns the key, and the string
    // renders in English in every language while looking perfectly fine.
    // A key containing ":" ("Mine:") is worse — it parses as a namespace and
    // renders as nothing at all.
    keySeparator: false,
    nsSeparator: false,
    interpolation: {
      escapeValue: false, // React escapes on render.
    },
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: STORED_KEY,
      // Runs on whatever the device reported, before i18next filters it
      // against `supportedLngs`. That order is the whole point: `ko-KR` is not
      // in the list and never will be, so by the time the filter sees it the
      // answer is already English. `fallbackLng` cannot help — it chooses
      // where a *lookup* falls through to, not which language is active.
      convertDetectedLanguage: (code) => resolveLanguage(code)[0],
    },
    react: {
      // Without Suspense a language switch re-renders with the fallback text
      // already on screen. With it, every screen would blank out while a
      // locale chunk loads — worse on the slow networks our users are on.
      useSuspense: false,
    },
  });

export function changeLanguage(code: LangCode): Promise<unknown> {
  // Marks the stored language as a decision rather than a guess, so the repair
  // below never overrides someone who picked English on a Korean phone.
  try {
    localStorage.setItem(CHOICE_KEY, '1');
  } catch {
    // Private mode, or storage full. The language still changes for this
    // session; only the "this was deliberate" note is lost.
  }

  return i18n.changeLanguage(code);
}

export default i18n;
