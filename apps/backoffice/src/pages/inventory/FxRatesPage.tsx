import { DECIMAL_PATTERN, dec, newId } from '@autoparts/shared';
import type { CurrentFxRates, FxRateRecord } from '@autoparts/shared';
import { Alert, Button, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { ErrorAlert } from '../../components/ErrorAlert';
import { useCurrencies } from '../../catalog/common';
import { useFormatDateTime } from '../../format';
import { inventoryKeys } from '../../inventory/common';

/** Positive, at most 12 integer digits and 10 decimals (the database's limits). */
const RATE_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,10})?$/;

/**
 * Exchange rates entered by hand, as the market quotes them: "1 USD = 3.6725 AED"
 * (ADR 0019). The form reads the same way, so the direction is never in doubt.
 */
export function FxRatesPage() {
  const { t, i18n } = useTranslation();
  const { me, can } = useAuth();
  const formatDateTime = useFormatDateTime();
  const queryClient = useQueryClient();
  const functional = me?.tenant.functionalCurrency ?? '';
  const currencies = useCurrencies();
  const others = (currencies.data ?? [])
    .filter((c) => c.isActive && c.code !== functional)
    .map((c) => c.code);
  const current = useQuery({
    queryKey: inventoryKeys.fxCurrent,
    queryFn: () => api<CurrentFxRates>('GET', '/fx-rates/current'),
  });
  const history = useQuery({
    queryKey: inventoryKeys.fxRates,
    queryFn: () => api<FxRateRecord[]>('GET', '/fx-rates?limit=100'),
  });
  const [base, setBase] = useState<string | null>(functional === '' ? null : functional);
  const [quote, setQuote] = useState<string | null>(null);
  const [rate, setRate] = useState('');
  const [rateDate, setRateDate] = useState('');
  const [note, setNote] = useState('');
  const validRate =
    RATE_PATTERN.test(rate.trim()) && DECIMAL_PATTERN.test(rate.trim()) && dec(rate.trim()).gt(0);
  const pairOk =
    base !== null && quote !== null && base !== quote && [base, quote].includes(functional);

  const record = useMutation({
    mutationFn: () =>
      api<FxRateRecord>('POST', '/fx-rates', {
        id: newId(),
        base,
        quote,
        rate: rate.trim(),
        ...(rateDate !== '' && { rateDate }),
        ...(note.trim() !== '' && { note: note.trim() }),
      }),
    onSuccess: async () => {
      setRate('');
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['inventory', 'fx'] });
    },
  });

  const missingToday = (current.data?.rates ?? []).filter((r) => !r.enteredToday);
  const allCurrencies = [functional, ...others];

  return (
    <Stack>
      <Title order={2}>{t('fx.title')}</Title>
      {missingToday.length > 0 && (
        <Alert color="yellow" role="status" title={t('fx.missingTodayTitle')}>
          {t('fx.missingToday', {
            currencies: new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(
              missingToday.map((r) => r.currency),
            ),
          })}
        </Alert>
      )}
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('fx.currency')}</Table.Th>
            <Table.Th>{t('fx.current')}</Table.Th>
            <Table.Th>{t('fx.date')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {current.data?.rates.map((r) => (
            <Table.Tr key={r.currency}>
              <Table.Td>{r.currency}</Table.Td>
              <Table.Td dir="ltr">
                {r.rate === null
                  ? t('fx.none')
                  : t('fx.quote', { base: r.rate.base, rate: r.rate.rate, quote: r.rate.quote })}
              </Table.Td>
              <Table.Td>{r.rate?.rateDate ?? ''}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {can('fx.manage') && (
        <Stack
          component="form"
          gap="xs"
          onSubmit={(e) => {
            e.preventDefault();
            if (validRate && pairOk) record.mutate();
          }}
        >
          <Title order={4}>{t('fx.record')}</Title>
          {/* Reads like the market quote: 1 [base] = [rate] [quote]. Kept left to right. */}
          <Group align="flex-end" dir="ltr">
            <Text pb={8}>{t('fx.formOne')}</Text>
            <Select
              aria-label={t('fx.base')}
              data={allCurrencies}
              value={base}
              onChange={setBase}
              allowDeselect={false}
              w={110}
            />
            <Text pb={8}>{t('fx.formEquals')}</Text>
            <TextInput
              aria-label={t('fx.rate')}
              value={rate}
              inputMode="decimal"
              error={rate !== '' && !validRate ? t('fx.badRate') : undefined}
              onChange={(e) => {
                setRate(e.currentTarget.value);
              }}
              w={160}
            />
            <Select
              aria-label={t('fx.quoteCurrency')}
              data={allCurrencies}
              value={quote}
              onChange={setQuote}
              allowDeselect={false}
              w={110}
            />
          </Group>
          <Group align="flex-end">
            <TextInput
              type="date"
              label={t('fx.date')}
              description={t('fx.dateHint')}
              value={rateDate}
              onChange={(e) => {
                setRateDate(e.currentTarget.value);
              }}
            />
            <TextInput
              label={t('fx.note')}
              value={note}
              onChange={(e) => {
                setNote(e.currentTarget.value);
              }}
            />
            <Button type="submit" disabled={!validRate || !pairOk} loading={record.isPending}>
              {t('fx.save')}
            </Button>
          </Group>
          {!pairOk && base !== null && quote !== null && (
            <Text size="sm" c="red">
              {t('fx.needsFunctional', { currency: functional })}
            </Text>
          )}
        </Stack>
      )}
      <ErrorAlert error={current.error ?? history.error ?? record.error} />
      <Title order={4}>{t('fx.history')}</Title>
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('fx.date')}</Table.Th>
            <Table.Th>{t('fx.rate')}</Table.Th>
            <Table.Th>{t('fx.note')}</Table.Th>
            <Table.Th>{t('fx.recordedAt')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {history.data?.map((r) => (
            <Table.Tr key={r.id}>
              <Table.Td>{r.rateDate}</Table.Td>
              <Table.Td dir="ltr">
                {t('fx.quote', { base: r.base, rate: r.rate, quote: r.quote })}
              </Table.Td>
              <Table.Td>{r.note ?? ''}</Table.Td>
              <Table.Td>{formatDateTime(r.recordedAt)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
