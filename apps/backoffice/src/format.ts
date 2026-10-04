import { useTranslation } from 'react-i18next';

/** Date-time in the active UI language (Arabic digits and RTL order in Arabic). */
export function useFormatDateTime(): (iso: string | null) => string {
  const { i18n, t } = useTranslation();
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  return (iso) => (iso === null ? t('common.never') : fmt.format(new Date(iso)));
}
