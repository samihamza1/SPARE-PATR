import { Alert } from '@mantine/core';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '../api';

/** The translated message for an API error code; unknown errors get a generic message. */
export function errorText(t: TFunction, error: unknown): string {
  const code = error instanceof ApiRequestError ? error.code : 'server.error';
  return t(`errors.${code}`, { defaultValue: t('errors.server.error') });
}

/** Shows an API error in the user's language. Unknown errors get a generic message. */
export function ErrorAlert({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (error === null || error === undefined) return null;
  const issues = error instanceof ApiRequestError ? error.issues : [];
  return (
    <Alert color="red" role="alert" title={errorText(t, error)}>
      {issues.map((issue) => (
        <div key={`${issue.path}:${issue.message}`}>
          {t(`fields.${issue.path}`, { defaultValue: issue.path })}:{' '}
          {t(`validation.${issue.message}`, { defaultValue: t('validation.invalid') })}
        </div>
      ))}
    </Alert>
  );
}
