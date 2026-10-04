import i18next from 'i18next';
import type { i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

import ar from './locales/ar.json';
import en from './locales/en.json';

export const resources = { ar: { translation: ar }, en: { translation: en } } as const;

/** Arabic first, English fallback (CLAUDE.md). The tenant/user locale overrides later. */
export async function createI18n(language = 'ar'): Promise<i18n> {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: 'en',
    supportedLngs: ['ar', 'en'],
    interpolation: { escapeValue: false },
  });
  return instance;
}
