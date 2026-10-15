import { applyDocumentLocale, createI18n } from '@autoparts/shared/i18n';
import type { i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './locales/ar.json';
import en from './locales/en.json';

export const resources = { ar: { translation: ar }, en: { translation: en } };

/** Creates the app's i18n instance and keeps <html lang dir> in sync with the language. */
export async function setupI18n(lng?: string): Promise<I18n> {
  const i18n = await createI18n({
    resources,
    plugins: [initReactI18next],
    ...(lng === undefined ? {} : { lng }),
  });
  applyDocumentLocale(document.documentElement, i18n.language);
  i18n.on('languageChanged', (language: string) => {
    applyDocumentLocale(document.documentElement, language);
  });
  return i18n;
}
