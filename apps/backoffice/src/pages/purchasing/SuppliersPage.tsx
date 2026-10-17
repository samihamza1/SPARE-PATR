import { newId } from '@autoparts/shared';
import type { PartSummary, Supplier, SupplierPartPage } from '@autoparts/shared';
import {
  Badge,
  Button,
  Checkbox,
  Drawer,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { PartPicker, partName, useCurrencies } from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Pager } from '../../components/Pager';
import { Form, useRequired } from '../../forms';

const PAGE = 50;

export const purchasingKeys = {
  suppliers: ['purchasing', 'suppliers'] as const,
  supplierParts: (id: string) => ['purchasing', 'suppliers', id, 'parts'] as const,
};

interface SupplierFields {
  name: string;
  defaultCurrency: string | null;
  phone: string;
  note: string;
}

const emptyFields: SupplierFields = { name: '', defaultCurrency: null, phone: '', note: '' };

const fieldsOf = (s: Supplier): SupplierFields => ({
  name: s.name,
  defaultCurrency: s.defaultCurrency,
  phone: s.phone ?? '',
  note: s.note ?? '',
});

/** Blank optional text is sent as null: "no phone", not an empty one. */
const orNull = (s: string) => (s.trim() === '' ? null : s.trim());

/** Name, default currency, phone and note of a supplier. */
function SupplierForm({
  value,
  onChange,
  nameError,
}: {
  value: SupplierFields;
  onChange: (next: SupplierFields) => void;
  nameError: string | undefined;
}) {
  const { t } = useTranslation();
  const currencies = useCurrencies();
  const active = (currencies.data ?? []).filter(
    (c) => c.isActive || c.code === value.defaultCurrency,
  );
  return (
    <>
      <TextInput
        label={t('suppliers.name')}
        required
        value={value.name}
        error={nameError}
        onChange={(e) => {
          onChange({ ...value, name: e.currentTarget.value });
        }}
      />
      <Select
        label={t('suppliers.defaultCurrency')}
        description={t('suppliers.defaultCurrencyHint')}
        clearable
        data={active.map((c) => c.code)}
        value={value.defaultCurrency}
        onChange={(v) => {
          onChange({ ...value, defaultCurrency: v });
        }}
      />
      <TextInput
        label={t('suppliers.phone')}
        dir="ltr"
        value={value.phone}
        onChange={(e) => {
          onChange({ ...value, phone: e.currentTarget.value });
        }}
      />
      <TextInput
        label={t('suppliers.note')}
        value={value.note}
        onChange={(e) => {
          onChange({ ...value, note: e.currentTarget.value });
        }}
      />
    </>
  );
}

/** The supplier's own part numbers, mapped once to catalog parts (ADR 0026). */
function SupplierPartsDrawer({ supplier, onClose }: { supplier: Supplier; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const manage = can('purchases.manage') && supplier.archivedAt === null;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  const [offset, setOffset] = useState(0);
  const [number, setNumber] = useState('');
  const [part, setPart] = useState<PartSummary | null>(null);
  const required = useRequired(
    { number, part: part?.id ?? '' },
    { part: t('suppliers.choosePart') },
  );
  const mappings = useQuery({
    queryKey: [...purchasingKeys.supplierParts(supplier.id), q, offset],
    queryFn: () =>
      api<SupplierPartPage>(
        'GET',
        `/suppliers/${supplier.id}/parts?limit=${String(PAGE)}&offset=${String(offset)}&q=${encodeURIComponent(q)}`,
      ),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: purchasingKeys.supplierParts(supplier.id) });
  const add = useMutation({
    mutationFn: () =>
      api('POST', `/suppliers/${supplier.id}/parts`, {
        id: newId(),
        partId: part?.id,
        number: number.trim(),
      }),
    onSuccess: async () => {
      setNumber('');
      setPart(null);
      required.reset();
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (mappingId: string) =>
      api('POST', `/suppliers/${supplier.id}/parts/${mappingId}/remove`),
    onSuccess: refresh,
  });
  const total = mappings.data?.total ?? 0;

  return (
    <Drawer
      opened
      onClose={onClose}
      position={i18n.dir() === 'rtl' ? 'left' : 'right'}
      size="lg"
      title={t('suppliers.numbersOf', { name: supplier.name })}
    >
      <Stack>
        <Text c="dimmed" size="sm">
          {t('suppliers.numbersIntro')}
        </Text>
        {manage && (
          <Form
            onSubmit={() => {
              if (add.isPending || !required.ok()) return;
              add.mutate();
            }}
          >
            <Stack gap="xs">
              <TextInput
                label={t('suppliers.number')}
                required
                dir="ltr"
                value={number}
                error={required.errors.number}
                onChange={(e) => {
                  setNumber(e.currentTarget.value);
                }}
              />
              <PartPicker label={t('suppliers.part')} onPick={setPart} />
              {part !== null && (
                <Text size="sm">
                  {t('catalog.partOption', { sku: part.sku, name: partName(part, i18n.language) })}
                </Text>
              )}
              {required.errors.part !== undefined && (
                <Text c="red" size="sm">
                  {required.errors.part}
                </Text>
              )}
              <Group>
                <Button type="submit" loading={add.isPending}>
                  {t('suppliers.addNumber')}
                </Button>
              </Group>
            </Stack>
          </Form>
        )}
        <ErrorAlert error={mappings.error ?? add.error ?? remove.error} />
        <TextInput
          label={t('common.search')}
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            setOffset(0);
          }}
        />
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('suppliers.number')}</Table.Th>
              <Table.Th>{t('suppliers.part')}</Table.Th>
              {manage && <Table.Th>{t('common.actions')}</Table.Th>}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {mappings.data?.items.map((m) => (
              <Table.Tr key={m.id}>
                <Table.Td dir="ltr">{m.number}</Table.Td>
                <Table.Td>
                  {t('catalog.partOption', {
                    sku: m.part.sku,
                    name: partName(m.part, i18n.language),
                  })}
                  {m.part.archivedAt !== null && (
                    <Badge color="gray" ms="xs">
                      {t('suppliers.partArchived')}
                    </Badge>
                  )}
                </Table.Td>
                {manage && (
                  <Table.Td>
                    <Button
                      size="xs"
                      variant="light"
                      color="red"
                      onClick={() => {
                        if (
                          window.confirm(t('suppliers.removeNumberConfirm', { number: m.number }))
                        )
                          remove.mutate(m.id);
                      }}
                    >
                      {t('suppliers.removeNumber')}
                    </Button>
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {mappings.data !== undefined && total === 0 && (
          <Text c="dimmed">{t('suppliers.noNumbers')}</Text>
        )}
        <Pager
          hasPrevious={offset > 0}
          hasNext={offset + PAGE < total}
          onPrevious={() => {
            setOffset(Math.max(0, offset - PAGE));
          }}
          onNext={() => {
            setOffset(offset + PAGE);
          }}
        />
      </Stack>
    </Drawer>
  );
}

/** Who the shop buys from, and their part numbers (ADR 0026). */
export function SuppliersPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const manage = can('purchases.manage');
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  const [showArchived, setShowArchived] = useState(false);
  const [fields, setFields] = useState<SupplierFields>(emptyFields);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [editFields, setEditFields] = useState<SupplierFields>(emptyFields);
  const [numbersOf, setNumbersOf] = useState<Supplier | null>(null);
  const required = useRequired({ name: fields.name });
  const editRequired = useRequired({ name: editFields.name });
  const suppliers = useQuery({
    queryKey: [...purchasingKeys.suppliers, q, showArchived],
    queryFn: () =>
      api<Supplier[]>(
        'GET',
        `/suppliers?includeArchived=${String(showArchived)}&q=${encodeURIComponent(q)}`,
      ),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: purchasingKeys.suppliers });

  const create = useMutation({
    mutationFn: () =>
      api<Supplier>('POST', '/suppliers', {
        id: newId(),
        name: fields.name.trim(),
        defaultCurrency: fields.defaultCurrency,
        phone: orNull(fields.phone),
        note: orNull(fields.note),
      }),
    onSuccess: async () => {
      setFields(emptyFields);
      required.reset();
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<Supplier>('PATCH', `/suppliers/${id}`, body),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });

  return (
    <Stack>
      <Title order={2}>{t('suppliers.title')}</Title>
      <Text c="dimmed">{t('suppliers.intro')}</Text>
      {manage && (
        <Form
          onSubmit={() => {
            if (create.isPending || !required.ok()) return;
            create.mutate();
          }}
        >
          <Stack gap="xs" maw={480}>
            <SupplierForm value={fields} onChange={setFields} nameError={required.errors.name} />
            <Group>
              <Button type="submit" loading={create.isPending}>
                {t('suppliers.add')}
              </Button>
            </Group>
          </Stack>
        </Form>
      )}
      {/* An edit's error shows in its dialog. */}
      <ErrorAlert
        error={suppliers.error ?? create.error ?? (editing === null ? update.error : null)}
      />
      <Group align="flex-end">
        <TextInput
          label={t('common.search')}
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
          }}
        />
        <Checkbox
          label={t('suppliers.showArchived')}
          checked={showArchived}
          onChange={(e) => {
            setShowArchived(e.currentTarget.checked);
          }}
        />
      </Group>
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('suppliers.name')}</Table.Th>
            <Table.Th>{t('suppliers.defaultCurrency')}</Table.Th>
            <Table.Th>{t('suppliers.phone')}</Table.Th>
            <Table.Th>{t('suppliers.status')}</Table.Th>
            <Table.Th>{t('common.actions')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {suppliers.data?.map((s) => (
            <Table.Tr key={s.id}>
              <Table.Td>{s.name}</Table.Td>
              <Table.Td>{s.defaultCurrency ?? t('common.none')}</Table.Td>
              <Table.Td dir="ltr">{s.phone ?? ''}</Table.Td>
              <Table.Td>
                {s.archivedAt !== null && <Badge color="gray">{t('suppliers.archived')}</Badge>}
              </Table.Td>
              <Table.Td>
                <Group gap="xs">
                  <Button
                    size="xs"
                    variant="light"
                    onClick={() => {
                      setNumbersOf(s);
                    }}
                  >
                    {t('suppliers.numbers')}
                  </Button>
                  {manage && (
                    <Button
                      size="xs"
                      variant="light"
                      onClick={() => {
                        update.reset();
                        editRequired.reset();
                        setEditFields(fieldsOf(s));
                        setEditing(s);
                      }}
                    >
                      {t('suppliers.edit')}
                    </Button>
                  )}
                  {manage && (
                    <Button
                      size="xs"
                      variant="light"
                      color={s.archivedAt === null ? 'red' : 'gray'}
                      onClick={() => {
                        const archive = s.archivedAt === null;
                        if (
                          !archive ||
                          window.confirm(t('suppliers.archiveConfirm', { name: s.name }))
                        )
                          update.mutate({ id: s.id, body: { archived: archive } });
                      }}
                    >
                      {s.archivedAt === null ? t('suppliers.archive') : t('suppliers.restore')}
                    </Button>
                  )}
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {suppliers.data?.length === 0 && <Text c="dimmed">{t('suppliers.none')}</Text>}
      {editing !== null && (
        <Modal
          opened
          onClose={() => {
            setEditing(null);
            update.reset();
          }}
          title={t('suppliers.edit')}
        >
          <Form
            onSubmit={() => {
              if (update.isPending || !editRequired.ok()) return;
              update.mutate({
                id: editing.id,
                body: {
                  name: editFields.name.trim(),
                  defaultCurrency: editFields.defaultCurrency,
                  phone: orNull(editFields.phone),
                  note: orNull(editFields.note),
                },
              });
            }}
          >
            <Stack>
              <SupplierForm
                value={editFields}
                onChange={setEditFields}
                nameError={editRequired.errors.name}
              />
              <ErrorAlert error={update.error} />
              <Button type="submit" loading={update.isPending}>
                {t('common.save')}
              </Button>
            </Stack>
          </Form>
        </Modal>
      )}
      {numbersOf !== null && (
        <SupplierPartsDrawer
          supplier={numbersOf}
          onClose={() => {
            setNumbersOf(null);
          }}
        />
      )}
    </Stack>
  );
}
