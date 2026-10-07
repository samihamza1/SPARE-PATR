import { ROUNDING_MODES, newId } from '@autoparts/shared';
import { SUPPORTED_LOCALES } from '@autoparts/shared/i18n';
import type { Currency, TenantSettings } from '@autoparts/shared';
import {
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Table,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { ME_KEY } from '../auth';
import { ErrorAlert } from '../components/ErrorAlert';
import { Form, useRequired } from '../forms';

interface SettingsResponse {
  name: string;
  defaultLocale: string;
  timezone: string;
  functionalCurrency: string;
  settings: TenantSettings | null;
}

const SETTINGS_KEY = ['settings'] as const;
const CURRENCIES_KEY = ['currencies'] as const;

function SettingsForm({ initial }: { initial: SettingsResponse }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial.name);
  const [defaultLocale, setDefaultLocale] = useState(initial.defaultLocale);
  const [settings, setSettings] = useState<Partial<TenantSettings>>(initial.settings ?? {});
  const required = useRequired({ name, roundingMode: settings.money?.roundingMode });

  const save = useMutation({
    mutationFn: () => api<SettingsResponse>('PUT', '/settings', { name, defaultLocale, settings }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
      // The header shows the shop name from `me`.
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      notifications.show({ message: t('common.saved'), color: 'green' });
    },
  });

  return (
    <Paper
      withBorder
      p="md"
      component="form"
      // Required fields are checked in code, with messages in the app's language.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (required.ok()) save.mutate();
      }}
    >
      <Stack>
        <ErrorAlert error={save.error} />
        <Group grow>
          <TextInput
            label={t('settings.shopName')}
            value={name}
            required
            error={required.errors.name}
            onChange={(e) => {
              setName(e.currentTarget.value);
            }}
          />
          <Select
            label={t('settings.defaultLanguage')}
            data={SUPPORTED_LOCALES.map((l) => ({ value: l, label: t(`language.${l}`) }))}
            value={defaultLocale}
            allowDeselect={false}
            onChange={(v) => {
              if (v !== null) setDefaultLocale(v);
            }}
          />
        </Group>
        <Group grow>
          <TextInput
            label={t('settings.timezone')}
            value={initial.timezone}
            readOnly
            description={t('settings.fixedHint')}
          />
          <TextInput
            label={t('settings.functionalCurrency')}
            value={initial.functionalCurrency}
            readOnly
            description={t('settings.fixedHint')}
          />
        </Group>
        <Title order={4}>{t('settings.business')}</Title>
        <Group grow>
          <Select
            label={t('settings.roundingMode')}
            required
            placeholder={t('settings.choose')}
            data={ROUNDING_MODES.map((m) => ({ value: m, label: t(`rounding.${m}`) }))}
            error={required.errors.roundingMode}
            value={settings.money?.roundingMode ?? null}
            onChange={(v) => {
              if (v !== null) setSettings({ ...settings, money: { roundingMode: v } });
            }}
          />
          <Switch
            mt="lg"
            label={t('settings.allowNegativeStock')}
            checked={settings.inventory?.allowNegativeStock ?? false}
            onChange={(e) => {
              setSettings({
                ...settings,
                inventory: { allowNegativeStock: e.currentTarget.checked },
              });
            }}
          />
        </Group>
        <Title order={4}>{t('settings.security')}</Title>
        <Group grow>
          <NumberInput
            label={t('settings.idleMinutes')}
            min={5}
            max={1440}
            value={settings.session?.idleMinutes ?? 30}
            onChange={(v) => {
              // Ignore the transient empty value while the field is being edited.
              if (typeof v !== 'number') return;
              setSettings({
                ...settings,
                session: {
                  absoluteHours: settings.session?.absoluteHours ?? 12,
                  idleMinutes: v,
                },
              });
            }}
          />
          <NumberInput
            label={t('settings.absoluteHours')}
            min={1}
            max={24}
            value={settings.session?.absoluteHours ?? 12}
            onChange={(v) => {
              // Ignore the transient empty value while the field is being edited.
              if (typeof v !== 'number') return;
              setSettings({
                ...settings,
                session: {
                  idleMinutes: settings.session?.idleMinutes ?? 30,
                  absoluteHours: v,
                },
              });
            }}
          />
          <NumberInput
            label={t('settings.maxFailedLogins')}
            min={3}
            max={50}
            value={settings.security?.maxFailedLogins ?? 5}
            onChange={(v) => {
              // Ignore the transient empty value while the field is being edited.
              if (typeof v !== 'number') return;
              setSettings({
                ...settings,
                security: {
                  lockoutMinutes: settings.security?.lockoutMinutes ?? 15,
                  maxFailedLogins: v,
                },
              });
            }}
          />
          <NumberInput
            label={t('settings.lockoutMinutes')}
            min={1}
            max={1440}
            value={settings.security?.lockoutMinutes ?? 15}
            onChange={(v) => {
              // Ignore the transient empty value while the field is being edited.
              if (typeof v !== 'number') return;
              setSettings({
                ...settings,
                security: {
                  maxFailedLogins: settings.security?.maxFailedLogins ?? 5,
                  lockoutMinutes: v,
                },
              });
            }}
          />
        </Group>
        <Group justify="flex-end">
          <Button type="submit" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

function AddCurrencyModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [minorUnits, setMinorUnits] = useState<string | number>('');
  const [cashIncrement, setCashIncrement] = useState('');
  const required = useRequired({ code, minorUnits });
  const add = useMutation({
    mutationFn: () =>
      api<Currency>('POST', '/currencies', {
        id: newId(),
        code: code.trim().toUpperCase(),
        minorUnits: Number(minorUnits),
        cashIncrement: cashIncrement.trim() === '' ? null : cashIncrement.trim(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CURRENCIES_KEY });
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('currencies.add')}>
      <Form
        onSubmit={() => {
          if (required.ok()) add.mutate();
        }}
      >
        <Stack>
          <ErrorAlert error={add.error} />
          <TextInput
            label={t('currencies.code')}
            description={t('currencies.codeHint')}
            required
            maxLength={3}
            dir="ltr"
            value={code}
            error={required.errors.code}
            onChange={(e) => {
              setCode(e.currentTarget.value);
            }}
          />
          <NumberInput
            label={t('currencies.minorUnits')}
            description={t('currencies.minorUnitsHint')}
            required
            min={0}
            max={4}
            allowDecimal={false}
            value={minorUnits}
            error={required.errors.minorUnits}
            onChange={setMinorUnits}
          />
          <TextInput
            label={t('currencies.cashIncrement')}
            description={t('currencies.cashIncrementHint')}
            dir="ltr"
            value={cashIncrement}
            onChange={(e) => {
              setCashIncrement(e.currentTarget.value);
            }}
          />
          <Button type="submit" loading={add.isPending}>
            {t('common.save')}
          </Button>
        </Stack>
      </Form>
    </Modal>
  );
}

function Currencies() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const currencies = useQuery({
    queryKey: CURRENCIES_KEY,
    queryFn: () => api<Currency[]>('GET', '/currencies'),
  });
  const [adding, setAdding] = useState(false);
  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api<Currency>('PATCH', `/currencies/${id}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CURRENCIES_KEY }),
  });
  return (
    <Paper withBorder p="md">
      <Stack>
        <Group justify="space-between">
          <Title order={4}>{t('currencies.title')}</Title>
          <Button
            variant="light"
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('currencies.add')}
          </Button>
        </Group>
        <ErrorAlert error={currencies.error ?? setActive.error} />
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('currencies.code')}</Table.Th>
              <Table.Th>{t('currencies.minorUnits')}</Table.Th>
              <Table.Th>{t('currencies.cashIncrement')}</Table.Th>
              <Table.Th>{t('currencies.active')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {currencies.data?.map((c) => (
              <Table.Tr key={c.id}>
                <Table.Td dir="ltr">
                  <Group gap={4}>
                    {c.code}
                    {c.isFunctional && <Badge size="xs">{t('currencies.functional')}</Badge>}
                  </Group>
                </Table.Td>
                <Table.Td>{c.minorUnits}</Table.Td>
                <Table.Td dir="ltr">{c.cashIncrement ?? t('common.none')}</Table.Td>
                <Table.Td>
                  <Switch
                    aria-label={`${c.code} ${t('currencies.active')}`}
                    checked={c.isActive}
                    disabled={c.isFunctional || setActive.isPending}
                    onChange={(e) => {
                      setActive.mutate({ id: c.id, isActive: e.currentTarget.checked });
                    }}
                  />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
      {adding && (
        <AddCurrencyModal
          onClose={() => {
            setAdding(false);
          }}
        />
      )}
    </Paper>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api<SettingsResponse>('GET', '/settings'),
  });
  return (
    <Stack>
      <Title order={2}>{t('settings.title')}</Title>
      <ErrorAlert error={settings.error} />
      {settings.data !== undefined && <SettingsForm initial={settings.data} />}
      <Currencies />
    </Stack>
  );
}
