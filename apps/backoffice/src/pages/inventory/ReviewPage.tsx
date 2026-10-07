import type { ReviewItem } from '@autoparts/shared';
import {
  Anchor,
  Badge,
  Button,
  Group,
  SegmentedControl,
  Stack,
  Table,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../../api';
import { partName } from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';
import { useFormatDateTime } from '../../format';
import { inventoryKeys, useFormatQuantity, useLocationNames } from '../../inventory/common';

function Resolve({ item, onDone }: { item: ReviewItem; onDone: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const resolve = useMutation({
    mutationFn: () => api('POST', `/stock/review-items/${item.id}/resolve`, { note: note.trim() }),
    onSuccess: onDone,
  });
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap">
        <TextInput
          aria-label={t('review.note')}
          placeholder={t('review.note')}
          value={note}
          onChange={(e) => {
            setNote(e.currentTarget.value);
          }}
        />
        <Button
          size="xs"
          disabled={note.trim() === ''}
          loading={resolve.isPending}
          onClick={() => {
            resolve.mutate();
          }}
        >
          {t('review.resolve')}
        </Button>
      </Group>
      <ErrorAlert error={resolve.error} />
    </Stack>
  );
}

/** Stock that went below zero or left without a known cost (ADR 0020). */
export function ReviewPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const format = useFormatQuantity();
  const formatDateTime = useFormatDateTime();
  const locationName = useLocationNames();
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const items = useQuery({
    queryKey: inventoryKeys.review(status),
    queryFn: () => api<ReviewItem[]>('GET', `/stock/review-items?status=${status}`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['inventory', 'review'] });

  return (
    <Stack>
      <Title order={2}>{t('review.title')}</Title>
      <SegmentedControl
        value={status}
        onChange={setStatus}
        data={[
          { value: 'open', label: t('review.open') },
          { value: 'resolved', label: t('review.resolved') },
        ]}
      />
      <ErrorAlert error={items.error} />
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('review.kindLabel')}</Table.Th>
            <Table.Th>{t('catalog.sku')}</Table.Th>
            <Table.Th>{t('catalog.name')}</Table.Th>
            <Table.Th>{t('inventory.location')}</Table.Th>
            <Table.Th>{t('inventory.quantity')}</Table.Th>
            <Table.Th>{t('review.opened')}</Table.Th>
            <Table.Th>{status === 'open' ? t('common.actions') : t('review.note')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.data?.map((i) => (
            <Table.Tr key={i.id}>
              <Table.Td>
                <Badge color={i.kind === 'negative_stock' ? 'red' : 'yellow'} variant="light">
                  {t(`review.kind.${i.kind}`)}
                </Badge>
              </Table.Td>
              <Table.Td dir="ltr">
                <Anchor component={Link} to={`/catalog/parts/${i.partId}`}>
                  {i.sku}
                </Anchor>
              </Table.Td>
              <Table.Td>{partName(i, i18n.language)}</Table.Td>
              <Table.Td>{locationName(i.locationId)}</Table.Td>
              <Table.Td>{i.quantity === null ? '' : format(i.quantity)}</Table.Td>
              <Table.Td>{formatDateTime(i.openedAt)}</Table.Td>
              <Table.Td>
                {status === 'open' ? (
                  <Resolve item={i} onDone={refresh} />
                ) : (
                  (i.resolutionNote ?? '')
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
