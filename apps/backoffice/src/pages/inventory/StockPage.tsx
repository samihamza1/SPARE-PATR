import type { StockBalanceRow } from '@autoparts/shared';
import { Anchor, Button, Checkbox, Group, Stack, Table, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../../api';
import { partName } from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';
import { useFormatDateTime } from '../../format';
import {
  LocationSelect,
  inventoryKeys,
  useFormatQuantity,
  useLocations,
} from '../../inventory/common';

const PAGE = 100;

/** Stock per location, with the last receipt and issue for dead-stock review (BRIEF 9). */
export function StockPage() {
  const { t, i18n } = useTranslation();
  const format = useFormatQuantity();
  const formatDateTime = useFormatDateTime();
  const locations = useLocations();
  const [chosen, setChosen] = useState<string | null>(null);
  const locationId = chosen ?? locations.data?.[0]?.id ?? null;
  const [nonZero, setNonZero] = useState(true);
  const [after, setAfter] = useState<string[]>([]);
  const cursor = after.at(-1);
  const query = [
    `locationId=${locationId ?? ''}`,
    `limit=${String(PAGE)}`,
    ...(nonZero ? ['nonZero=true'] : []),
    ...(cursor === undefined ? [] : [`after=${encodeURIComponent(cursor)}`]),
  ].join('&');
  const balances = useQuery({
    queryKey: inventoryKeys.balances(query),
    queryFn: () => api<StockBalanceRow[]>('GET', `/stock/balances?${query}`),
    enabled: locationId !== null,
  });
  const rows = balances.data ?? [];

  return (
    <Stack>
      <Title order={2}>{t('inventory.stockTitle')}</Title>
      <Group align="flex-end">
        <LocationSelect
          label={t('inventory.location')}
          value={locationId}
          onChange={(id) => {
            setChosen(id);
            setAfter([]);
          }}
        />
        <Checkbox
          label={t('inventory.onlyNonZero')}
          checked={nonZero}
          onChange={(e) => {
            setNonZero(e.currentTarget.checked);
            setAfter([]);
          }}
        />
      </Group>
      <ErrorAlert error={locations.error ?? balances.error} />
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('catalog.sku')}</Table.Th>
            <Table.Th>{t('catalog.name')}</Table.Th>
            <Table.Th>{t('inventory.quantity')}</Table.Th>
            <Table.Th>{t('inventory.lastIn')}</Table.Th>
            <Table.Th>{t('inventory.lastOut')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr key={`${r.partId}:${r.locationId}`}>
              <Table.Td dir="ltr">
                <Anchor component={Link} to={`/catalog/parts/${r.partId}`}>
                  {r.sku}
                </Anchor>
              </Table.Td>
              <Table.Td>{partName(r, i18n.language)}</Table.Td>
              <Table.Td {...(r.quantity < 0 && { c: 'red' })}>{format(r.quantity)}</Table.Td>
              <Table.Td>{formatDateTime(r.lastInAt)}</Table.Td>
              <Table.Td>{formatDateTime(r.lastOutAt)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Group>
        <Button
          variant="default"
          disabled={after.length === 0}
          onClick={() => {
            setAfter(after.slice(0, -1));
          }}
        >
          {t('common.previous')}
        </Button>
        <Button
          variant="default"
          disabled={rows.length < PAGE}
          onClick={() => {
            const last = rows.at(-1);
            if (last !== undefined) setAfter([...after, last.sku]);
          }}
        >
          {t('common.next')}
        </Button>
      </Group>
    </Stack>
  );
}
