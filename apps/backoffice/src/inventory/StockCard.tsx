import { newId } from '@autoparts/shared';
import type { PartStock, StockMove } from '@autoparts/shared';
import { Button, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorAlert } from '../components/ErrorAlert';
import { useFormatDateTime } from '../format';
import { Amount, inventoryKeys, useFormatQuantity, useLocationNames } from './common';

/**
 * Stock of one part on its page: quantity per location for everyone; value and average
 * only with cost.view (BRIEF: cashiers never see cost); latest moves; quick actions.
 */
export function StockCard({
  partId,
  replacementId,
}: {
  partId: string;
  /** The active replacement, when the part is superseded. */
  replacementId: string | null;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const name = useLocationNames();
  const format = useFormatQuantity();
  const formatDateTime = useFormatDateTime();
  const stock = useQuery({
    queryKey: inventoryKeys.partStock(partId),
    queryFn: () => api<PartStock>('GET', `/stock/parts/${partId}`),
  });
  const movesQuery = `partId=${partId}&limit=10`;
  const moves = useQuery({
    queryKey: inventoryKeys.moves(movesQuery),
    queryFn: () => api<StockMove[]>('GET', `/stock/moves?${movesQuery}`),
  });
  const toReplacement = useMutation({
    mutationFn: () => api('POST', '/stock/part-transfers', { id: newId(), partId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['inventory'] }),
  });

  const s = stock.data;
  return (
    <Card withBorder>
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={4}>{t('inventory.stock')}</Title>
          <Group gap="xs">
            {can('stock.adjust') && (
              <Button
                size="xs"
                variant="light"
                component={Link}
                to={`/inventory/adjust?part=${partId}`}
              >
                {t('inventory.adjust')}
              </Button>
            )}
            {can('stock.transfer') && (
              <Button
                size="xs"
                variant="light"
                component={Link}
                to={`/inventory/transfer?part=${partId}`}
              >
                {t('inventory.transfer')}
              </Button>
            )}
            {can('stock.adjust') && replacementId !== null && (s?.total ?? 0) > 0 && (
              <Button
                size="xs"
                variant="light"
                loading={toReplacement.isPending}
                onClick={() => {
                  if (window.confirm(t('inventory.toReplacementConfirm'))) toReplacement.mutate();
                }}
              >
                {t('inventory.toReplacement')}
              </Button>
            )}
          </Group>
        </Group>
        <ErrorAlert error={stock.error ?? moves.error ?? toReplacement.error} />
        {s !== undefined && (
          <Table>
            <Table.Tbody>
              {s.locations.map((l) => (
                <Table.Tr key={l.locationId}>
                  <Table.Td>{name(l.locationId)}</Table.Td>
                  <Table.Td {...(l.quantity < 0 && { c: 'red' })}>{format(l.quantity)}</Table.Td>
                </Table.Tr>
              ))}
              <Table.Tr>
                <Table.Td fw={700}>{t('inventory.total')}</Table.Td>
                <Table.Td fw={700}>{format(s.total)}</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        )}
        {s?.cost !== undefined && (
          <Group gap="lg">
            <Stack gap={0}>
              <Text size="xs" c="dimmed">
                {t('inventory.value')}
              </Text>
              <Amount amount={s.cost.value} currency={s.cost.currency} />
            </Stack>
            {s.cost.averageCost !== null && (
              <Stack gap={0}>
                <Text size="xs" c="dimmed">
                  {t('inventory.averageCost')}
                </Text>
                <Amount amount={s.cost.averageCost} currency={s.cost.currency} />
              </Stack>
            )}
          </Group>
        )}
        {(moves.data?.length ?? 0) > 0 && (
          <Table striped fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('inventory.when')}</Table.Th>
                <Table.Th>{t('inventory.move')}</Table.Th>
                <Table.Th>{t('inventory.location')}</Table.Th>
                <Table.Th>{t('inventory.quantity')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {moves.data?.map((m) => (
                <Table.Tr key={m.id}>
                  <Table.Td>{formatDateTime(m.occurredAt)}</Table.Td>
                  <Table.Td>
                    {m.reason === null
                      ? t(`inventory.moveKind.${m.kind}`)
                      : t('inventory.kindWithReason', {
                          kind: t(`inventory.moveKind.${m.kind}`),
                          reason: t(`inventory.reason.${m.reason}`),
                        })}
                  </Table.Td>
                  <Table.Td>{name(m.locationId)}</Table.Td>
                  <Table.Td dir="ltr">{format(m.quantity)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Card>
  );
}
