import i18next from 'i18next';
import type { Module, Resource, i18n as I18n } from 'i18next';

export const SUPPORTED_LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Arabic-first, with English as the fallback for missing keys. */
export const DEFAULT_LOCALE: Locale = 'ar';
export const FALLBACK_LOCALE: Locale = 'en';

export type TextDirection = 'rtl' | 'ltr';

const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);

export function directionOf(locale: string): TextDirection {
  const language = locale.split('-')[0]?.toLowerCase() ?? '';
  return RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
}

export function isSupportedLocale(locale: string): locale is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale);
}

/** Anything with `lang` and `dir`, typically `document.documentElement`. */
export interface LocaleTarget {
  lang: string;
  dir: string;
}

export function applyDocumentLocale(target: LocaleTarget, locale: string): void {
  target.lang = locale;
  target.dir = directionOf(locale);
}

export interface CreateI18nOptions {
  resources: Resource;
  lng?: string;
  /** e.g. `initReactI18next` in the React apps. */
  plugins?: readonly Module[];
}

/** Creates an isolated i18next instance (no global state, safe in tests). */
export async function createI18n({
  resources,
  lng = DEFAULT_LOCALE,
  plugins = [],
}: CreateI18nOptions): Promise<I18n> {
  const instance = i18next.createInstance();
  for (const plugin of plugins) instance.use(plugin);
  await instance.init({
    resources,
    lng,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    // React escapes output itself.
    interpolation: { escapeValue: false },
  });
  return instance;
}
