import { OPENING_LINE_STATUSES, newId } from '@autoparts/shared';
import type {
  ImportBatch,
  OpeningDraft,
  OpeningLine,
  OpeningLineStatus,
  OpeningSummary,
  StockDocument,
} from '@autoparts/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../../api';
import { partName } from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';
import { useFormatDateTime } from '../../format';
import { Amount, LocationSelect, inventoryKeys, useFormatQuantity } from '../../inventory/common';

const COST_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;

/** Opening stock drafts, and starting one from an applied catalog import (ADR 0024). */
export function OpeningListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const formatDateTime = useFormatDateTime();
  const drafts = useQuery({
    queryKey: inventoryKeys.openings,
    queryFn: () => api<OpeningSummary[]>('GET', '/stock/opening'),
  });
  const imports = useQuery({
    queryKey: ['catalog', 'imports'],
    queryFn: () => api<ImportBatch[]>('GET', '/catalog/imports'),
  });
  const used = new Set(
    (drafts.data ?? []).filter((d) => d.status !== 'discarded').map((d) => d.batchId),
  );
  const applied = (imports.data ?? []).filter((b) => b.status === 'applied' && !used.has(b.id));
  const [batchId, setBatchId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => api<OpeningDraft>('POST', '/stock/opening', { id: newId(), batchId }),
    onSuccess: (draft) => navigate(`/inventory/opening/${draft.id}`),
  });

  return (
    <Stack>
      <Title order={2}>{t('opening.title')}</Title>
      <Text c="dimmed">{t('opening.intro')}</Text>
      <Group align="flex-end">
        <Select
          label={t('opening.fromImport')}
          placeholder={applied.length === 0 ? t('opening.noImports') : undefined}
          data={applied.map((b) => ({
            value: b.id,
            label: t('opening.importLabel', { file: b.fileName, sheet: b.sheet ?? '' }),
          }))}
          value={batchId}
          onChange={setBatchId}
        />
        <Button
          disabled={batchId === null}
          loading={start.isPending}
          onClick={() => {
            start.mutate();
          }}
        >
          {t('opening.start')}
        </Button>
      </Group>
      <ErrorAlert error={drafts.error ?? imports.error ?? start.error} />
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('opening.file')}</Table.Th>
            <Table.Th>{t('opening.status')}</Table.Th>
            <Table.Th>{t('opening.created')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {drafts.data?.map((d) => (
            <Table.Tr key={d.id}>
              <Table.Td>
                <Anchor component={Link} to={`/inventory/opening/${d.id}`}>
                  {d.fileName}
                </Anchor>
              </Table.Td>
              <Table.Td>
                <Badge variant="light">{t(`opening.draftStatus.${d.status}`)}</Badge>
              </Table.Td>
              <Table.Td>{formatDateTime(d.createdAt)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function LineEditor({
  draft,
  line,
  onSaved,
}: {
  draft: OpeningDraft;
  line: OpeningLine;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [cost, setCost] = useState(line.costSource === 'entered' ? (line.unitCost ?? '') : '');
  const [quantity, setQuantity] = useState<number | ''>(line.quantity ?? '');
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<OpeningDraft>('PATCH', `/stock/opening/${draft.id}/lines/${line.partId}`, body),
    onSuccess: onSaved,
  });
  const editable = draft.status === 'draft' && line.exclusion !== 'already_opened';
  if (!editable) return null;
  return (
    <Group gap="xs" wrap="nowrap">
      {line.status === 'needs_quantity' && (
        <NumberInput
          aria-label={t('inventory.quantity')}
          min={1}
          allowDecimal={false}
          allowNegative={false}
          value={quantity}
          onChange={(v) => {
            setQuantity(typeof v === 'number' ? v : '');
          }}
          w={100}
        />
      )}
      {(line.status === 'needs_cost' ||
        line.status === 'needs_quantity' ||
        line.costSource === 'entered') && (
        <TextInput
          aria-label={t('opening.unitCost', { currency: draft.costCurrency })}
          placeholder={line.suggestedUnitCost ?? t('opening.unitCostPlaceholder')}
          inputMode="decimal"
          value={cost}
          error={cost !== '' && !COST_PATTERN.test(cost)}
          onChange={(e) => {
            setCost(e.currentTarget.value);
          }}
          w={130}
        />
      )}
      {line.status !== 'excluded' && (
        <Button
          size="xs"
          variant="light"
          disabled={
            (cost !== '' && !COST_PATTERN.test(cost)) ||
            (cost === '' && quantity === (line.quantity ?? ''))
          }
          loading={save.isPending}
          onClick={() => {
            save.mutate({
              ...(cost !== '' && { unitCost: cost }),
              ...(typeof quantity === 'number' && quantity !== line.quantity && { quantity }),
            });
          }}
        >
          {t('common.save')}
        </Button>
      )}
      {line.suggestedUnitCost !== null && cost === '' && line.status === 'needs_cost' && (
        <Button
          size="xs"
          variant="subtle"
          onClick={() => {
            setCost(line.suggestedUnitCost ?? '');
          }}
        >
          {t('opening.useSuggestion')}
        </Button>
      )}
      <Button
        size="xs"
        variant="subtle"
        color={line.status === 'excluded' ? 'gray' : 'red'}
        onClick={() => {
          save.mutate({ excluded: line.status !== 'excluded' });
        }}
      >
        {line.status === 'excluded' ? t('opening.include') : t('opening.exclude')}
      </Button>
      <ErrorAlert error={save.error} />
    </Group>
  );
}

/**
 * One opening draft: tabs by line state, totals in both currencies, and posting once every
 * line is ready or excluded (ADR 0024).
 */
export function OpeningDraftPage() {
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const format = useFormatQuantity();
  const [status, setStatus] = useState<OpeningLineStatus>('needs_cost');
  const draft = useQuery({
    queryKey: inventoryKeys.opening(id),
    queryFn: () => api<OpeningDraft>('GET', `/stock/opening/${id}`),
  });
  const lines = useQuery({
    queryKey: inventoryKeys.openingLines(id, status),
    queryFn: () =>
      api<OpeningLine[]>('GET', `/stock/opening/${id}/lines?status=${status}&limit=500`),
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: inventoryKeys.opening(id) }),
      queryClient.invalidateQueries({ queryKey: ['inventory', 'opening-lines', id] }),
    ]);
  const settings = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<OpeningDraft>('PATCH', `/stock/opening/${id}`, body),
    onSuccess: refresh,
  });
  const post = useMutation({
    mutationFn: () => api<StockDocument>('POST', `/stock/opening/${id}/post`),
    onSuccess: async () => {
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
  const d = draft.data;
  const blocked =
    d === undefined ||
    d.counts.needs_cost > 0 ||
    d.counts.needs_quantity > 0 ||
    d.counts.ready === 0;
  const missingRate =
    d !== undefined && d.costCurrency !== d.functionalCurrency && d.fxRate === null;

  return (
    <Stack>
      <Title order={2}>{t('opening.title')}</Title>
      <ErrorAlert error={draft.error ?? settings.error ?? post.error} />
      {d !== undefined && (
        <>
          <Group align="flex-end">
            <LocationSelect
              label={t('inventory.location')}
              value={d.locationId}
              onChange={(locationId) => {
                if (locationId !== null && d.status === 'draft') settings.mutate({ locationId });
              }}
            />
            <TextInput
              type="date"
              label={t('opening.asOf')}
              value={d.asOf}
              disabled={d.status !== 'draft'}
              onChange={(e) => {
                const asOf = e.currentTarget.value;
                if (asOf !== '') settings.mutate({ asOf });
              }}
            />
            <Stack gap={0}>
              <Text size="xs" c="dimmed">
                {t('opening.rate')}
              </Text>
              <Text dir="ltr">
                {d.fxRate === null
                  ? d.costCurrency === d.functionalCurrency
                    ? t('opening.noRateNeeded')
                    : t('fx.none')
                  : t('fx.quote', {
                      base: d.fxRate.base,
                      rate: d.fxRate.rate,
                      quote: d.fxRate.quote,
                    })}
              </Text>
            </Stack>
          </Group>
          {missingRate && (
            <Alert color="yellow" role="status">
              {t('opening.rateMissing', { currency: d.costCurrency, date: d.asOf })}{' '}
              <Anchor component={Link} to="/fx-rates">
                {t('nav.fxRates')}
              </Anchor>
            </Alert>
          )}
          <Card withBorder>
            <Group gap="xl">
              <Stack gap={0}>
                <Text size="xs" c="dimmed">
                  {t('opening.units')}
                </Text>
                <Text>{format(d.totals.quantity)}</Text>
              </Stack>
              <Stack gap={0}>
                <Text size="xs" c="dimmed">
                  {t('opening.totalIn', { currency: d.costCurrency })}
                </Text>
                <Amount amount={d.totals.amount} currency={d.costCurrency} />
              </Stack>
              <Stack gap={0}>
                <Text size="xs" c="dimmed">
                  {t('opening.totalIn', { currency: d.functionalCurrency })}
                </Text>
                {d.totals.functionalAmount === null ? (
                  <Text c="dimmed">{t('fx.none')}</Text>
                ) : (
                  <Amount amount={d.totals.functionalAmount} currency={d.functionalCurrency} />
                )}
              </Stack>
              <Badge variant="light" size="lg">
                {t(`opening.draftStatus.${d.status}`)}
              </Badge>
            </Group>
          </Card>
          {d.status === 'draft' && (
            <Group>
              <Button
                disabled={blocked || missingRate}
                loading={post.isPending}
                onClick={() => {
                  if (window.confirm(t('opening.postConfirm'))) post.mutate();
                }}
              >
                {t('opening.post')}
              </Button>
              {blocked && <Text c="dimmed">{t('opening.notReady')}</Text>}
            </Group>
          )}
          <Tabs
            value={status}
            onChange={(v) => {
              if (v !== null) setStatus(v as OpeningLineStatus);
            }}
          >
            <Tabs.List>
              {OPENING_LINE_STATUSES.map((s) => (
                <Tabs.Tab key={s} value={s}>
                  {t('opening.tab', { label: t(`opening.lineStatus.${s}`), count: d.counts[s] })}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('catalog.sku')}</Table.Th>
                <Table.Th>{t('catalog.name')}</Table.Th>
                <Table.Th>{t('opening.rows')}</Table.Th>
                <Table.Th>{t('inventory.quantity')}</Table.Th>
                <Table.Th>{t('opening.amount', { currency: d.costCurrency })}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {lines.data?.map((l) => (
                <Table.Tr key={l.partId}>
                  <Table.Td dir="ltr">{l.sku}</Table.Td>
                  <Table.Td>{partName(l, i18n.language)}</Table.Td>
                  <Table.Td>{format(l.rows)}</Table.Td>
                  <Table.Td>
                    {l.quantity === null ? (l.fileQuantity ?? '') : format(l.quantity)}
                  </Table.Td>
                  <Table.Td>
                    {l.amount === null ? (
                      l.exclusion !== null ? (
                        t(`opening.exclusion.${l.exclusion}`)
                      ) : (
                        ''
                      )
                    ) : (
                      <Amount amount={l.amount} currency={d.costCurrency} />
                    )}
                  </Table.Td>
                  <Table.Td>
                    <LineEditor
                      key={`${l.partId}:${l.status}`}
                      draft={d}
                      line={l}
                      onSaved={refresh}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
    </Stack>
  );
}
