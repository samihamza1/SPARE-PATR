import { Alert, List } from '@mantine/core';
import type { TFunction, i18n as I18n } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '../api';

/** The translated message for an API error code; unknown errors get a generic message. */
export function errorText(t: TFunction, error: unknown): string {
  const code = error instanceof ApiRequestError ? error.code : 'server.error';
  return t(`errors.${code}`, { defaultValue: t('errors.server.error') });
}

/** A translation that exists and is text (not a group of keys). */
function text(i18n: I18n, key: string): string | null {
  if (!i18n.exists(key)) return null;
  const value: unknown = i18n.t(key, { returnObjects: true });
  return typeof value === 'string' ? value : null;
}

/**
 * The label of an issue path such as "mapping.priceListId", "settings.session.idleMinutes"
 * or "numbers.0.number": the most specific labelled part, else the nearest labelled parent.
 * Null when nothing is labelled; a raw path is never shown.
 */
function fieldLabel(i18n: I18n, path: string): string | null {
  const parts = path.split('.').filter((p) => p !== '' && !/^\d+$/.test(p));
  for (let end = parts.length; end > 0; end--) {
    for (let start = 0; start < end; start++) {
      const label = text(i18n, `fields.${parts.slice(start, end).join('.')}`);
      if (label !== null) return label;
    }
  }
  return null;
}

/** One validation issue in the user's language: "<field>: <problem>". */
export function issueText(i18n: I18n, issue: { path: string; message: string }): string {
  const message = text(i18n, `validation.${issue.message}`) ?? i18n.t('validation.invalid');
  const field = fieldLabel(i18n, issue.path);
  return field === null ? message : i18n.t('validation.withField', { field, message });
}

/** Shows an API error in the user's language. Unknown errors get a generic message. */
export function ErrorAlert({ error }: { error: unknown }) {
  const { t, i18n } = useTranslation();
  if (error === null || error === undefined) return null;
  const issues = error instanceof ApiRequestError ? error.issues : [];
  return (
    <Alert color="red" role="alert" title={errorText(t, error)}>
      {issues.length > 0 && (
        <List size="sm">
          {issues.map((issue) => (
            <List.Item key={`${issue.path}:${issue.message}`}>{issueText(i18n, issue)}</List.Item>
          ))}
        </List>
      )}
    </Alert>
  );
}
