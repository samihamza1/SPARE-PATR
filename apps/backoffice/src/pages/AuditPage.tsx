import type { AuditEntry, User } from '@autoparts/shared';
import { Button, Code, Group, Select, Stack, Table, Text, Title } from '@mantine/core';
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

type Snapshot = Record<string, unknown>;
const isSnapshot = (v: unknown): v is Snapshot =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const shown = (v: unknown): string =>
  v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);

/** What an entry changed: each field's value before and after, changed fields first. */
function Changes({ before, after }: { before: unknown; after: unknown }) {
  const { t } = useTranslation();
  if (before == null && after == null) return null;
  if (!isSnapshot(before ?? {}) || !isSnapshot(after ?? {})) {
    return (
      <Code block dir="ltr" fz="xs">
        {JSON.stringify({ before, after })}
      </Code>
    );
  }
  const b = (before ?? {}) as Snapshot;
  const a = (after ?? {}) as Snapshot;
  const changed = (k: string) => shown(b[k]) !== shown(a[k]);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort(
    (x, y) => Number(changed(y)) - Number(changed(x)),
  );
  return (
    <Table withTableBorder fz="xs" layout="fixed">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t('audit.field')}</Table.Th>
          {before != null && <Table.Th>{t('audit.before')}</Table.Th>}
          {after != null && <Table.Th>{t('audit.after')}</Table.Th>}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {keys.map((k) => (
          <Table.Tr key={k} fw={before != null && after != null && changed(k) ? 700 : undefined}>
            <Table.Td dir="ltr">{k}</Table.Td>
            {before != null && (
              <Table.Td dir="ltr" style={{ overflowWrap: 'anywhere' }}>
                {shown(b[k])}
              </Table.Td>
            )}
            {after != null && (
              <Table.Td dir="ltr" style={{ overflowWrap: 'anywhere' }}>
                {shown(a[k])}
              </Table.Td>
            )}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

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
                <Stack gap={4}>
                  {e.reason !== null && (
                    <Text size="sm">{t('audit.reasonText', { reason: e.reason })}</Text>
                  )}
                  <Changes before={e.before} after={e.after} />
                </Stack>
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
