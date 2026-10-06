import { PART_NUMBER_KINDS, QUALITY_GRADES, newId } from '@autoparts/shared';
import type { PartDetail, PartSummary, PriceEntry } from '@autoparts/shared';
import {
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { api } from '../../api';
import { useAuth } from '../../auth';
import {
  GradeBadge,
  PartPicker,
  Price,
  VehiclePicker,
  catalogKeys,
  categoryName,
  partName,
  useBrands,
  useCategories,
  usePriceLists,
} from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';
import { useFormatDateTime } from '../../format';
import { Form, useRequired } from '../../forms';

const blankToNull = (v: string) => (v.trim() === '' ? null : v.trim());

function DetailsForm({ part, onSaved }: { part: PartDetail; onSaved: (p: PartDetail) => void }) {
  const { t, i18n } = useTranslation();
  const brands = useBrands();
  const categories = useCategories();
  const [sku, setSku] = useState(part.sku);
  const [nameAr, setNameAr] = useState(part.nameAr ?? '');
  const [nameEn, setNameEn] = useState(part.nameEn ?? '');
  const [grade, setGrade] = useState<string | null>(part.qualityGrade);
  const [brandId, setBrandId] = useState<string | null>(part.brandId);
  const [categoryId, setCategoryId] = useState<string | null>(part.categoryId);
  const [unit, setUnit] = useState(part.unit);
  const [notes, setNotes] = useState(part.notes ?? '');
  const required = useRequired(
    { sku, name: nameAr.trim() === '' ? nameEn : nameAr, unit },
    { name: 'validation.name.required' },
  );
  const save = useMutation({
    mutationFn: (body: object) => api<PartDetail>('PATCH', `/catalog/parts/${part.id}`, body),
    onSuccess: onSaved,
  });
  return (
    <Form
      onSubmit={() => {
        if (!required.ok()) return;
        save.mutate({
          sku: sku.trim(),
          nameAr: blankToNull(nameAr),
          nameEn: blankToNull(nameEn),
          qualityGrade: grade,
          brandId,
          categoryId,
          unit: unit.trim(),
          notes: blankToNull(notes),
        });
      }}
    >
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label={t('catalog.sku')}
            dir="ltr"
            required
            value={sku}
            error={required.errors.sku}
            onChange={(e) => {
              setSku(e.currentTarget.value);
            }}
          />
          <Select
            label={t('catalog.grade')}
            clearable
            placeholder={t('catalog.gradeLabel.none')}
            value={grade}
            onChange={setGrade}
            data={QUALITY_GRADES.map((g) => ({ value: g, label: t(`catalog.gradeLabel.${g}`) }))}
          />
          <TextInput
            label={t('catalog.nameAr')}
            value={nameAr}
            error={required.errors.name}
            onChange={(e) => {
              setNameAr(e.currentTarget.value);
            }}
          />
          <TextInput
            label={t('catalog.nameEn')}
            dir="ltr"
            value={nameEn}
            onChange={(e) => {
              setNameEn(e.currentTarget.value);
            }}
          />
          <Select
            label={t('catalog.brand')}
            clearable
            value={brandId}
            onChange={setBrandId}
            data={(brands.data ?? [])
              .filter((b) => b.archivedAt === null || b.id === brandId)
              .map((b) => ({ value: b.id, label: b.name }))}
          />
          <Select
            label={t('catalog.category')}
            clearable
            value={categoryId}
            onChange={setCategoryId}
            data={(categories.data ?? [])
              .filter((c) => c.archivedAt === null || c.id === categoryId)
              .map((c) => ({ value: c.id, label: categoryName(c, i18n.language) }))}
          />
          <TextInput
            label={t('catalog.unit')}
            dir="ltr"
            required
            value={unit}
            error={required.errors.unit}
            onChange={(e) => {
              setUnit(e.currentTarget.value);
            }}
          />
        </SimpleGrid>
        <Textarea
          label={t('catalog.notes')}
          value={notes}
          onChange={(e) => {
            setNotes(e.currentTarget.value);
          }}
        />
        <ErrorAlert error={save.error} />
        <Group>
          <Button type="submit" loading={save.isPending}>
            {t('common.save')}
          </Button>
          <Button
            variant="light"
            color={part.archivedAt === null ? 'red' : 'green'}
            onClick={() => {
              save.mutate({ archived: part.archivedAt === null });
            }}
          >
            {part.archivedAt === null ? t('catalog.archive') : t('catalog.restore')}
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}

function PricesCard({ part }: { part: PartDetail }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const formatDateTime = useFormatDateTime();
  const queryClient = useQueryClient();
  const lists = usePriceLists();
  const historyKey = ['catalog', 'part-prices', part.id] as const;
  const history = useQuery({
    queryKey: historyKey,
    queryFn: () => api<PriceEntry[]>('GET', `/catalog/parts/${part.id}/prices`),
  });
  const [listId, setListId] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const required = useRequired({ listId, price });
  const set = useMutation({
    mutationFn: (list: string) =>
      api('POST', `/catalog/price-lists/${list}/prices`, {
        id: newId(),
        partId: part.id,
        price: price.trim(),
      }),
    onSuccess: async () => {
      setPrice('');
      required.reset();
      await queryClient.invalidateQueries({ queryKey: historyKey });
      await queryClient.invalidateQueries({ queryKey: catalogKeys.part(part.id) });
    },
  });
  const listName = (id: string) => lists.data?.find((l) => l.id === id)?.name ?? '';
  return (
    <Card withBorder>
      <Title order={4}>{t('catalog.prices')}</Title>
      <Table>
        <Table.Tbody>
          {part.prices.map((p) => (
            <Table.Tr key={p.priceListId}>
              <Table.Td>{listName(p.priceListId)}</Table.Td>
              <Table.Td>
                <Price price={p.current} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {can('prices.manage') && (
        <Form
          onSubmit={() => {
            if (required.ok() && listId !== null) set.mutate(listId);
          }}
        >
          <Group align="flex-end" mt="sm">
            <Select
              label={t('catalog.priceList')}
              required
              value={listId}
              onChange={setListId}
              error={required.errors.listId}
              data={(lists.data ?? [])
                .filter((l) => l.archivedAt === null)
                .map((l) => ({ value: l.id, label: `${l.name} (${l.currency})` }))}
            />
            <TextInput
              label={t('catalog.price')}
              required
              dir="ltr"
              inputMode="decimal"
              value={price}
              error={required.errors.price}
              onChange={(e) => {
                setPrice(e.currentTarget.value);
              }}
            />
            <Button type="submit" loading={set.isPending}>
              {t('catalog.setPrice')}
            </Button>
          </Group>
        </Form>
      )}
      <ErrorAlert error={set.error ?? history.error} />
      <Text fw={600} mt="md">
        {t('catalog.history')}
      </Text>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('catalog.priceList')}</Table.Th>
            <Table.Th>{t('catalog.price')}</Table.Th>
            <Table.Th>{t('catalog.effectiveAt')}</Table.Th>
            <Table.Th>{t('catalog.recorded')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {history.data?.map((h) => (
            <Table.Tr key={h.id}>
              <Table.Td>{listName(h.priceListId)}</Table.Td>
              <Table.Td>
                <Price price={{ amount: h.price, currency: h.currency }} />
              </Table.Td>
              <Table.Td>{formatDateTime(h.effectiveAt)}</Table.Td>
              <Table.Td>
                {formatDateTime(h.recordedAt)} ·{' '}
                <Badge variant="light" size="sm">
                  {t(`catalog.source.${h.source}`)}
                </Badge>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}

function PartLink({ part }: { part: PartSummary }) {
  const { i18n } = useTranslation();
  return (
    <Group gap="xs">
      <Anchor component={Link} to={`/catalog/parts/${part.id}`} dir="ltr">
        {part.sku}
      </Anchor>
      <Text>{partName(part, i18n.language)}</Text>
      <GradeBadge grade={part.qualityGrade} />
    </Group>
  );
}

export function PartPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const key = catalogKeys.part(id);
  const part = useQuery({
    queryKey: key,
    queryFn: () => api<PartDetail>('GET', `/catalog/parts/${id}`),
  });
  const manage = can('catalog.manage');
  const [number, setNumber] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const numberRequired = useRequired({ number, kind });

  const update = (p: PartDetail) => {
    queryClient.setQueryData(key, p);
    void queryClient.invalidateQueries({ queryKey: catalogKeys.parts });
  };
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) =>
      api<PartDetail>('POST', `/catalog/parts/${id}${path}`, body ?? {}),
    onSuccess: (p) => {
      update(p);
      setNumber('');
      setReason('');
      numberRequired.reset();
    },
  });

  if (part.data === undefined) return <ErrorAlert error={part.error} />;
  const p = part.data;

  return (
    <Stack>
      <Anchor component={Link} to="/catalog/parts">
        {t('catalog.back')}
      </Anchor>
      <Group>
        <Title order={2} dir="ltr">
          {p.sku}
        </Title>
        <GradeBadge grade={p.qualityGrade} />
        {p.archivedAt !== null && <Badge color="gray">{t('catalog.archived')}</Badge>}
      </Group>
      <ErrorAlert error={act.error} />

      <Card withBorder>
        <Title order={4}>{t('catalog.details')}</Title>
        {manage ? (
          <DetailsForm key={JSON.stringify(p)} part={p} onSaved={update} />
        ) : (
          <Text>
            {p.nameAr} {p.nameEn}
          </Text>
        )}
      </Card>

      <Card withBorder>
        <Title order={4}>{t('catalog.numbers')}</Title>
        <Table>
          <Table.Tbody>
            {p.numbers.map((n) => (
              <Table.Tr key={n.id}>
                <Table.Td dir="ltr">{n.number}</Table.Td>
                <Table.Td>{t(`catalog.numberKind.${n.kind}`)}</Table.Td>
                <Table.Td>
                  {manage && (
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      onClick={() => {
                        act.mutate({ path: `/numbers/${n.id}/remove` });
                      }}
                    >
                      {t('catalog.remove')}
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {manage && (
          <Form
            onSubmit={() => {
              if (!numberRequired.ok()) return;
              act.mutate({
                path: '/numbers',
                body: { id: newId(), number: number.trim(), kind },
              });
            }}
          >
            <Group align="flex-end">
              <TextInput
                label={t('catalog.number')}
                required
                dir="ltr"
                value={number}
                error={numberRequired.errors.number}
                onChange={(e) => {
                  setNumber(e.currentTarget.value);
                }}
              />
              <Select
                label={t('catalog.kind')}
                required
                value={kind}
                onChange={setKind}
                error={numberRequired.errors.kind}
                data={PART_NUMBER_KINDS.map((k) => ({
                  value: k,
                  label: t(`catalog.numberKind.${k}`),
                }))}
              />
              <Button type="submit">{t('catalog.addNumber')}</Button>
            </Group>
          </Form>
        )}
      </Card>

      <Card withBorder>
        <Title order={4}>{t('catalog.fitments')}</Title>
        <Table>
          <Table.Tbody>
            {p.fitments.map((f) => (
              <Table.Tr key={f.id}>
                <Table.Td>{f.path.join(' › ')}</Table.Td>
                <Table.Td>{f.note}</Table.Td>
                <Table.Td>
                  {manage && (
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      onClick={() => {
                        act.mutate({ path: `/fitments/${f.id}/remove` });
                      }}
                    >
                      {t('catalog.remove')}
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {manage && (
          <VehiclePicker
            label={t('catalog.addFitment')}
            onPick={(v) => {
              act.mutate({ path: '/fitments', body: { id: newId(), vehicleId: v.id } });
            }}
          />
        )}
      </Card>

      <Card withBorder>
        <Title order={4}>{t('catalog.interchange')}</Title>
        <Stack gap="xs">
          {p.interchange.map((x) => (
            <PartLink key={x.id} part={x} />
          ))}
        </Stack>
        {manage && (
          <Group align="flex-end">
            <PartPicker
              label={t('catalog.linkPart')}
              exclude={p.id}
              onPick={(other) => {
                act.mutate({ path: '/interchange', body: { partId: other.id } });
              }}
            />
            {p.interchange.length > 0 && (
              <Button
                variant="subtle"
                color="red"
                onClick={() => {
                  act.mutate({ path: '/interchange/remove' });
                }}
              >
                {t('catalog.unlink')}
              </Button>
            )}
          </Group>
        )}
      </Card>

      <Card withBorder>
        <Title order={4}>{t('catalog.supersession')}</Title>
        {p.supersededBy !== null && (
          <Group>
            <Text fw={600}>{t('catalog.supersededBy')}:</Text>
            <PartLink part={p.supersededBy} />
          </Group>
        )}
        {p.supersedes.map((x) => (
          <Group key={x.id}>
            <Text fw={600}>{t('catalog.supersedes')}:</Text>
            <PartLink part={x} />
          </Group>
        ))}
        {manage && p.supersededBy === null && (
          <Group align="flex-end">
            <TextInput
              label={t('catalog.reason')}
              value={reason}
              onChange={(e) => {
                setReason(e.currentTarget.value);
              }}
            />
            <PartPicker
              label={t('catalog.supersede')}
              exclude={p.id}
              onPick={(other) => {
                act.mutate({
                  path: '/supersede',
                  body: { id: newId(), newPartId: other.id, reason: blankToNull(reason) },
                });
              }}
            />
          </Group>
        )}
      </Card>

      <PricesCard part={p} />
    </Stack>
  );
}
