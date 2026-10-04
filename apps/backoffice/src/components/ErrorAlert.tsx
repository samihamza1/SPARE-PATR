import { Alert } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '../api';

/** Shows an API error in the user's language. Unknown errors get a generic message. */
export function ErrorAlert({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (error === null || error === undefined) return null;
  const code = error instanceof ApiRequestError ? error.code : 'server.error';
  const issues = error instanceof ApiRequestError ? error.issues : [];
  return (
    <Alert
      color="red"
      role="alert"
      title={t(`errors.${code}`, { defaultValue: t('errors.server.error') })}
    >
      {issues.map((issue) => (
        <div key={`${issue.path}:${issue.message}`}>
          {t(`fields.${issue.path}`, { defaultValue: issue.path })}:{' '}
          {t(`validation.${issue.message}`, { defaultValue: t('validation.invalid') })}
        </div>
      ))}
    </Alert>
  );
}
