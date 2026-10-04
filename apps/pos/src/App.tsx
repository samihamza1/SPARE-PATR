import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/** Keeps <html lang/dir> and the document title in sync with the active language. */
function useDocumentLocale(): void {
  const { t, i18n } = useTranslation();
  useEffect(() => {
    const root = document.documentElement;
    root.lang = i18n.language;
    root.dir = i18n.dir(i18n.language);
    document.title = t('app.title');
  }, [i18n, i18n.language, t]);
}

export function App() {
  const { t, i18n } = useTranslation();
  useDocumentLocale();
  const next = i18n.language === 'ar' ? 'en' : 'ar';

  return (
    <main>
      <h1>{t('app.title')}</h1>
      <p>{t('app.status')}</p>
      <button type="button" lang={next} onClick={() => void i18n.changeLanguage(next)}>
        {t('app.switchLanguage')}
      </button>
    </main>
  );
}
