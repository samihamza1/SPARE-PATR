import { COUNT_SCOPES, newId } from '@autoparts/shared';
import type { CountLine, StockCount } from '@autoparts/shared';
import {
  Anchor,
  Badge,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { categoryName, partName, useCategories } from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';
import { useFormatDateTime } from '../../format';
import {
  LocationSelect,
  inventoryKeys,
  useFormatQuantity,
  useLocationNames,
} from '../../inventory/common';

/** Stock counts (ADR 0025): supervisors open and approve, counters count blind. */
export function CountsPage() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const formatDateTime = useFormatDateTime();
  const locationName = useLocationNames();
  const categories = useCategories();
  const counts = useQuery({
    queryKey: inventoryKeys.counts,
    queryFn: () => api<StockCount[]>('GET', '/stock/counts'),
  });
  const [locationId, setLocationId] = useState<string | null>(null);
  const [scope, setScope] = useState<'all' | 'category'>('all');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const open = useMutation({
    mutationFn: () =>
      api<StockCount>('POST', '/stock/counts', {
        id: newId(),
        locationId,
        scope,
        ...(scope === 'category' && { categoryId }),
        ...(note.trim() !== '' && { note: note.trim() }),
      }),
    onSuccess: (count) => navigate(`/inventory/counts/${count.id}`),
  });

  return (
    <Stack>
      <Title order={2}>{t('count.title')}</Title>
      {can('stock.approve_count') && (
        <Group align="flex-end">
          <LocationSelect
            label={t('inventory.location')}
            value={locationId}
            onChange={setLocationId}
            required
          />
          <Select
            label={t('count.scopeLabel')}
            data={COUNT_SCOPES.filter((s) => s !== 'parts').map((s) => ({
              value: s,
              label: t(`count.scope.${s}`),
            }))}
            value={scope}
            allowDeselect={false}
            onChange={(s) => {
              if (s === 'all' || s === 'category') setScope(s);
            }}
          />
          {scope === 'category' && (
            <Select
              label={t('catalog.category')}
              data={(categories.data ?? []).map((c) => ({
                value: c.id,
                label: categoryName(c, i18n.language),
              }))}
              value={categoryId}
              onChange={setCategoryId}
              searchable
            />
          )}
          <TextInput
            label={t('inventory.note')}
            value={note}
            onChange={(e) => {
              setNote(e.currentTarget.value);
            }}
          />
          <Button
            disabled={locationId === null || (scope === 'category' && categoryId === null)}
            loading={open.isPending}
            onClick={() => {
              open.mutate();
            }}
          >
            {t('count.open')}
          </Button>
        </Group>
      )}
      <ErrorAlert error={counts.error ?? open.error} />
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('inventory.location')}</Table.Th>
            <Table.Th>{t('count.scopeLabel')}</Table.Th>
            <Table.Th>{t('count.progress')}</Table.Th>
            <Table.Th>{t('count.statusLabel')}</Table.Th>
            <Table.Th>{t('count.created')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {counts.data?.map((c) => (
            <Table.Tr key={c.id}>
              <Table.Td>
                <Anchor component={Link} to={`/inventory/counts/${c.id}`}>
                  {locationName(c.locationId)}
                </Anchor>
              </Table.Td>
              <Table.Td>{t(`count.scope.${c.scope}`)}</Table.Td>
              <Table.Td>{t('count.counted', { counted: c.counted, lines: c.lines })}</Table.Td>
              <Table.Td>
                <Badge variant="light">{t(`count.status.${c.status}`)}</Badge>
              </Table.Td>
              <Table.Td>{formatDateTime(c.createdAt)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function CountInput({
  countId,
  line,
  onSaved,
}: {
  countId: string;
  line: CountLine;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<number | ''>(line.counted ?? '');
  const save = useMutation({
    mutationFn: (counted: number) =>
      api('PUT', `/stock/counts/${countId}/lines/${line.partId}`, { counted }),
    onSuccess: onSaved,
  });
  return (
    <Group gap="xs" wrap="nowrap">
      <NumberInput
        aria-label={t('count.countedLabel', { sku: line.sku })}
        size="lg"
        min={0}
        allowDecimal={false}
        allowNegative={false}
        value={value}
        onChange={(v) => {
          setValue(typeof v === 'number' ? v : '');
        }}
        onBlur={() => {
          if (typeof value === 'number' && value !== line.counted) save.mutate(value);
        }}
        w={130}
      />
      {/* Saved = the server holds what is typed; it survives the line being refetched. */}
      {line.counted !== null && value === line.counted && (
        <Badge color="green">{t('count.saved')}</Badge>
      )}
      <ErrorAlert error={save.error} />
    </Group>
  );
}

/** One count: big inputs for counters (blind); expected and differences for approvers. */
export function CountPage() {
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const { can } = useAuth();
  const approver = can('stock.approve_count');
  const queryClient = useQueryClient();
  const format = useFormatQuantity();
  const locationName = useLocationNames();
  const [documentId] = useState(newId);
  const count = useQuery({
    queryKey: inventoryKeys.count(id),
    queryFn: () => api<StockCount>('GET', `/stock/counts/${id}`),
  });
  const lines = useQuery({
    queryKey: inventoryKeys.countLines(id),
    queryFn: () => api<CountLine[]>('GET', `/stock/counts/${id}/lines`),
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: inventoryKeys.count(id) }),
      queryClient.invalidateQueries({ queryKey: inventoryKeys.countLines(id) }),
    ]);
  const approve = useMutation({
    mutationFn: () => api('POST', `/stock/counts/${id}/approve`, { documentId }),
    onSuccess: async () => {
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
  const cancel = useMutation({
    mutationFn: () => api('POST', `/stock/counts/${id}/cancel`),
    onSuccess: refresh,
  });
  const c = count.data;
  const isOpen = c?.status === 'open';
  const [filter, setFilter] = useState('');
  const shown = (lines.data ?? []).filter(
    (l) =>
      filter === '' ||
      l.sku.toLowerCase().includes(filter.toLowerCase()) ||
      partName(l, i18n.language).includes(filter),
  );

  return (
    <Stack>
      <Title order={2}>
        {c === undefined
          ? t('count.title')
          : t('count.titleAt', { location: locationName(c.locationId) })}
      </Title>
      <ErrorAlert error={count.error ?? lines.error ?? approve.error ?? cancel.error} />
      {c !== undefined && (
        <Group>
          <Badge variant="light" size="lg">
            {t(`count.status.${c.status}`)}
          </Badge>
          <Text>{t('count.counted', { counted: c.counted, lines: c.lines })}</Text>
          {approver && isOpen && (
            <>
              <Button
                loading={approve.isPending}
                onClick={() => {
                  if (window.confirm(t('count.approveConfirm'))) approve.mutate();
                }}
              >
                {t('count.approve')}
              </Button>
              <Button
                variant="light"
                color="red"
                loading={cancel.isPending}
                onClick={() => {
                  if (window.confirm(t('count.cancelConfirm'))) cancel.mutate();
                }}
              >
                {t('count.cancel')}
              </Button>
            </>
          )}
        </Group>
      )}
      <TextInput
        label={t('count.find')}
        value={filter}
        onChange={(e) => {
          setFilter(e.currentTarget.value);
        }}
      />
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('catalog.sku')}</Table.Th>
            <Table.Th>{t('catalog.name')}</Table.Th>
            <Table.Th>{t('count.countedHeader')}</Table.Th>
            {approver && <Table.Th>{t('count.expected')}</Table.Th>}
            {approver && <Table.Th>{t('count.variance')}</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {shown.map((l) => (
            <Table.Tr key={l.partId}>
              <Table.Td dir="ltr">{l.sku}</Table.Td>
              <Table.Td>{partName(l, i18n.language)}</Table.Td>
              <Table.Td>
                {isOpen ? (
                  <CountInput
                    key={`${l.partId}:${String(l.counted)}`}
                    countId={id}
                    line={l}
                    onSaved={refresh}
                  />
                ) : l.counted === null ? (
                  ''
                ) : (
                  format(l.counted)
                )}
              </Table.Td>
              {approver && <Table.Td>{l.expected == null ? '' : format(l.expected)}</Table.Td>}
              {approver && (
                <Table.Td
                  {...((l.variance ?? 0) !== 0 && { c: (l.variance ?? 0) < 0 ? 'red' : 'green' })}
                >
                  {l.variance == null ? '' : format(l.variance)}
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
