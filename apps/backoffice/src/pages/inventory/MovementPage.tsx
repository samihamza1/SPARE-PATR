import { ADJUSTMENT_REASONS, newId } from '@autoparts/shared';
import type { AdjustmentReason, PartSummary, StockDocument } from '@autoparts/shared';
import {
  Alert,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { PartPicker, partName, useCurrencies } from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';
import { LocationSelect } from '../../inventory/common';

interface Line {
  part: Pick<PartSummary, 'id' | 'sku' | 'nameAr' | 'nameEn'>;
  quantity: number | '';
  unitCost: string;
  currency: string | null;
}

const COST_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;

/**
 * Stock adjustments (stock.adjust) and transfers between locations (stock.transfer).
 * The reason decides the direction of an adjustment; the form only asks for quantities.
 */
export function MovementPage({ mode }: { mode: 'adjust' | 'transfer' }) {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const currencies = useCurrencies();
  const [params] = useSearchParams();
  const [documentId, setDocumentId] = useState(newId);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [toLocationId, setToLocationId] = useState<string | null>(null);
  const [reason, setReason] = useState<AdjustmentReason>('found');
  const [dataDirection, setDataDirection] = useState<'in' | 'out'>('in');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [done, setDone] = useState<StockDocument | null>(null);

  // A part chosen on its page arrives as ?part=<id>.
  const preset = params.get('part');
  const presetPart = useQuery({
    queryKey: ['catalog', 'part', preset],
    queryFn: () => api<PartSummary>('GET', `/catalog/parts/${preset ?? ''}`),
    enabled: preset !== null,
  });
  const functional = me?.tenant.functionalCurrency ?? null;
  const newLine = (part: Line['part']): Line => ({
    part,
    quantity: 1,
    unitCost: '',
    currency: functional,
  });
  // Add the preset part once, while rendering (no effect needed for derived state).
  const [presetAdded, setPresetAdded] = useState<string | null>(null);
  const p = presetPart.data;
  if (p !== undefined && presetAdded !== p.id) {
    setPresetAdded(p.id);
    setLines((ls) => (ls.some((l) => l.part.id === p.id) ? ls : [...ls, newLine(p)]));
  }

  const incoming =
    mode === 'adjust' &&
    (reason === 'found' || (reason === 'data_correction' && dataDirection === 'in'));
  const sign = mode === 'adjust' && !incoming ? -1 : 1;
  const linesOk =
    lines.length > 0 &&
    lines.every(
      (l) =>
        typeof l.quantity === 'number' &&
        l.quantity >= 1 &&
        (l.unitCost === '' || (COST_PATTERN.test(l.unitCost) && l.currency !== null)),
    );
  const ready =
    linesOk &&
    locationId !== null &&
    (mode === 'adjust' || (toLocationId !== null && toLocationId !== locationId));

  const post = useMutation({
    mutationFn: () =>
      mode === 'adjust'
        ? api<StockDocument>('POST', '/stock/adjustments', {
            id: documentId,
            locationId,
            reason,
            ...(note.trim() !== '' && { note: note.trim() }),
            lines: lines.map((l) => ({
              partId: l.part.id,
              quantity: sign * Number(l.quantity),
              ...(incoming &&
                l.unitCost !== '' && { unitCost: { amount: l.unitCost, currency: l.currency } }),
            })),
          })
        : api<StockDocument>('POST', '/stock/transfers', {
            id: documentId,
            fromLocationId: locationId,
            toLocationId,
            ...(note.trim() !== '' && { note: note.trim() }),
            lines: lines.map((l) => ({ partId: l.part.id, quantity: Number(l.quantity) })),
          }),
    onSuccess: async (doc) => {
      setDone(doc);
      setLines([]);
      setNote('');
      // A new document gets a new id; a retry of the same one keeps it (idempotent).
      setDocumentId(newId());
      await queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
  });

  return (
    <Stack>
      <Title order={2}>
        {t(mode === 'adjust' ? 'inventory.adjustTitle' : 'inventory.transferTitle')}
      </Title>
      {done !== null && (
        <Alert
          color="green"
          role="status"
          withCloseButton
          onClose={() => {
            setDone(null);
          }}
        >
          {t('inventory.posted', { count: done.moves.length })}
        </Alert>
      )}
      <Group align="flex-end">
        <LocationSelect
          label={t(mode === 'adjust' ? 'inventory.location' : 'inventory.from')}
          value={locationId}
          onChange={setLocationId}
          required
        />
        {mode === 'transfer' && (
          <LocationSelect
            label={t('inventory.to')}
            value={toLocationId}
            onChange={setToLocationId}
            required
          />
        )}
        {mode === 'adjust' && (
          <Select
            label={t('inventory.reasonLabel')}
            data={ADJUSTMENT_REASONS.map((r) => ({ value: r, label: t(`inventory.reason.${r}`) }))}
            value={reason}
            allowDeselect={false}
            onChange={(r) => {
              if (r !== null) setReason(r);
            }}
          />
        )}
        {mode === 'adjust' && reason === 'data_correction' && (
          <Select
            label={t('inventory.direction')}
            data={[
              { value: 'in', label: t('inventory.directionIn') },
              { value: 'out', label: t('inventory.directionOut') },
            ]}
            value={dataDirection}
            allowDeselect={false}
            onChange={(d) => {
              if (d === 'in' || d === 'out') setDataDirection(d);
            }}
          />
        )}
      </Group>
      <PartPicker
        label={t('inventory.addPart')}
        onPick={(p) => {
          if (!lines.some((l) => l.part.id === p.id)) setLines([...lines, newLine(p)]);
        }}
      />
      {lines.length > 0 && (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('catalog.sku')}</Table.Th>
              <Table.Th>{t('catalog.name')}</Table.Th>
              <Table.Th>{t('inventory.quantity')}</Table.Th>
              {incoming && <Table.Th>{t('inventory.unitCost')}</Table.Th>}
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {lines.map((l, i) => (
              <Table.Tr key={l.part.id}>
                <Table.Td dir="ltr">{l.part.sku}</Table.Td>
                <Table.Td>{partName(l.part, i18n.language)}</Table.Td>
                <Table.Td>
                  <NumberInput
                    aria-label={t('inventory.quantity')}
                    min={1}
                    allowDecimal={false}
                    allowNegative={false}
                    value={l.quantity}
                    onChange={(v) => {
                      setLines(
                        lines.map((x, j) =>
                          j === i ? { ...x, quantity: typeof v === 'number' ? v : '' } : x,
                        ),
                      );
                    }}
                    w={110}
                  />
                </Table.Td>
                {incoming && (
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <TextInput
                        aria-label={t('inventory.unitCost')}
                        placeholder={t('inventory.averageHint')}
                        inputMode="decimal"
                        value={l.unitCost}
                        error={l.unitCost !== '' && !COST_PATTERN.test(l.unitCost)}
                        onChange={(e) => {
                          const unitCost = e.currentTarget.value;
                          setLines(lines.map((x, j) => (j === i ? { ...x, unitCost } : x)));
                        }}
                        w={130}
                      />
                      <Select
                        aria-label={t('inventory.currency')}
                        data={(currencies.data ?? []).filter((c) => c.isActive).map((c) => c.code)}
                        value={l.currency}
                        allowDeselect={false}
                        onChange={(currency) => {
                          setLines(lines.map((x, j) => (j === i ? { ...x, currency } : x)));
                        }}
                        w={90}
                      />
                    </Group>
                  </Table.Td>
                )}
                <Table.Td>
                  <Button
                    size="xs"
                    variant="subtle"
                    color="red"
                    aria-label={t('inventory.removeLine', { sku: l.part.sku })}
                    onClick={() => {
                      setLines(lines.filter((_, j) => j !== i));
                    }}
                  >
                    {t('inventory.remove')}
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <TextInput
        label={t('inventory.note')}
        value={note}
        onChange={(e) => {
          setNote(e.currentTarget.value);
        }}
      />
      <ErrorAlert error={post.error} />
      <Group>
        <Button
          disabled={!ready}
          loading={post.isPending}
          onClick={() => {
            post.mutate();
          }}
        >
          {t(mode === 'adjust' ? 'inventory.postAdjustment' : 'inventory.postTransfer')}
        </Button>
      </Group>
    </Stack>
  );
}
