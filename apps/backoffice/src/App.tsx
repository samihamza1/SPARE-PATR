import { useTranslation } from 'react-i18next';

export function App() {
  const { t, i18n } = useTranslation();
  const otherLanguage = i18n.language === 'ar' ? 'en' : 'ar';

  return (
    <main>
      <h1>{t('app.title')}</h1>
      <p>{t('app.status')}</p>
      <button
        type="button"
        lang={otherLanguage}
        onClick={() => void i18n.changeLanguage(otherLanguage)}
      >
        {t('language.switch')}
      </button>
    </main>
  );
}
