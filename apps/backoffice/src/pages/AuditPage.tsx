import type { AuditEntry, User } from '@autoparts/shared';
import { Button, Code, Group, Select, Stack, Table, Title } from '@mantine/core';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorAlert } from '../components/ErrorAlert';
import { useFormatDateTime } from '../format';

const PAGE = 50;
const ENTITY_TYPES = [
  'user',
  'role',
  'session',
  'tenant',
  'currency',
  'device',
  'part',
  'brand',
  'category',
  'vehicle',
  'vehicle_alias',
  'price_list',
  'import_batch',
] as const;

export function AuditPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const formatDateTime = useFormatDateTime();
  const [entityType, setEntityType] = useState<string | null>(null);
  // Names for actors when the viewer may list users; otherwise ids are shown.
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<User[]>('GET', '/users'),
    enabled: can('users.manage'),
  });
  const entries = useInfiniteQuery({
    queryKey: ['audit', entityType],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE) });
      if (entityType !== null) params.set('entityType', entityType);
      if (pageParam !== undefined) params.set('before', pageParam);
      return api<AuditEntry[]>('GET', `/audit-log?${params.toString()}`);
    },
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last.at(-1)?.id),
  });

  const actor = (id: string | null) => {
    if (id === null) return t('audit.system');
    return users.data?.find((u) => u.id === id)?.displayName ?? id.slice(-8);
  };

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('audit.title')}</Title>
        <Select
          aria-label={t('audit.entityType')}
          placeholder={t('audit.allEntities')}
          clearable
          data={ENTITY_TYPES.map((e) => ({ value: e, label: t(`audit.entities.${e}`) }))}
          value={entityType}
          onChange={setEntityType}
        />
      </Group>
      <ErrorAlert error={entries.error} />
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('audit.when')}</Table.Th>
            <Table.Th>{t('audit.who')}</Table.Th>
            <Table.Th>{t('audit.action')}</Table.Th>
            <Table.Th>{t('audit.details')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {entries.data?.pages.flat().map((e) => (
            <Table.Tr key={e.id}>
              <Table.Td>{formatDateTime(e.occurredAt)}</Table.Td>
              <Table.Td>{actor(e.actorUserId)}</Table.Td>
              <Table.Td>{t(`audit.actions.${e.action}`, { defaultValue: e.action })}</Table.Td>
              <Table.Td>
                {e.after !== null && (
                  <Code block dir="ltr" fz="xs">
                    {JSON.stringify(e.after)}
                  </Code>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {entries.hasNextPage && (
        <Button
          variant="light"
          loading={entries.isFetchingNextPage}
          onClick={() => void entries.fetchNextPage()}
        >
          {t('audit.loadMore')}
        </Button>
      )}
    </Stack>
  );
}
