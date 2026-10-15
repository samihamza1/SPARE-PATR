import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  applyDocumentLocale,
  createI18n,
  directionOf,
  isSupportedLocale,
} from '../src/i18n';

describe('i18n', () => {
  it('is Arabic-first with an English fallback', () => {
    expect(DEFAULT_LOCALE).toBe('ar');
    expect(FALLBACK_LOCALE).toBe('en');
  });

  it('knows text direction', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('ar-EG')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
  });

  it('validates supported locales', () => {
    expect(isSupportedLocale('ar')).toBe(true);
    expect(isSupportedLocale('xx')).toBe(false);
  });

  it('applies lang and dir to a document element', () => {
    const el = { lang: '', dir: '' };
    applyDocumentLocale(el, 'ar');
    expect(el).toEqual({ lang: 'ar', dir: 'rtl' });
    applyDocumentLocale(el, 'en');
    expect(el).toEqual({ lang: 'en', dir: 'ltr' });
  });

  it('creates isolated instances that fall back to English', async () => {
    const i18n = await createI18n({
      resources: { ar: { translation: { a: 'أ' } }, en: { translation: { a: 'A', b: 'B' } } },
    });
    expect(i18n.language).toBe('ar');
    expect(i18n.t('a')).toBe('أ');
    expect(i18n.t('b')).toBe('B');
  });
});
