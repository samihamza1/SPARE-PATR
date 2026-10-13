import type { Permission } from '@autoparts/shared';
import { Alert } from '@mantine/core';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth';

/** Hides a page from users without the permission (the API enforces it regardless). */
export function RequirePermission({
  permission,
  children,
}: {
  /** One permission, or several that are all needed. */
  permission: Permission | readonly Permission[];
  children: ReactNode;
}) {
  const { can } = useAuth();
  const { t } = useTranslation();
  const needed: readonly Permission[] = typeof permission === 'string' ? [permission] : permission;
  if (!needed.every((p) => can(p))) {
    return (
      <Alert color="yellow" role="alert" title={t('errors.auth.forbidden')}>
        {t('common.forbiddenHint')}
      </Alert>
    );
  }
  return children;
}
