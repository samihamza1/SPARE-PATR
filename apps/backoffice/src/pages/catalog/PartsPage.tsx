import { NEEDS_REVIEW, PART_NUMBER_KINDS, QUALITY_GRADES, newId } from '@autoparts/shared';
import type { PartDetail, PartSummary } from '@autoparts/shared';
import {
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { GradeBadge, catalogKeys, partName } from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';

const PAGE = 100;
type Review = (typeof NEEDS_REVIEW)[number] | 'all';

function NewPartModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sku, setSku] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [grade, setGrade] = useState<string | null>(null);
  const [number, setNumber] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api<PartDetail>('POST', '/catalog/parts', {
        id: newId(),
        sku: sku.trim(),
        nameAr: nameAr.trim() === '' ? null : nameAr.trim(),
        nameEn: nameEn.trim() === '' ? null : nameEn.trim(),
        qualityGrade: grade,
        numbers:
          number.trim() === '' || kind === null
            ? []
            : [{ id: newId(), number: number.trim(), kind }],
      }),
    onSuccess: (part) => {
      void navigate(`/catalog/parts/${part.id}`);
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('catalog.newPart')}>
      <Stack
        component="form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <TextInput
          label={t('catalog.sku')}
          required
          dir="ltr"
          value={sku}
          onChange={(e) => {
            setSku(e.currentTarget.value);
          }}
        />
        <TextInput
          label={t('catalog.nameAr')}
          value={nameAr}
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
        <Text size="xs" c="dimmed">
          {t('catalog.nameRequired')}
        </Text>
        <Select
          label={t('catalog.grade')}
          clearable
          value={grade}
          onChange={setGrade}
          data={QUALITY_GRADES.map((g) => ({ value: g, label: t(`catalog.gradeLabel.${g}`) }))}
          placeholder={t('catalog.gradeLabel.none')}
        />
        <Group grow>
          <TextInput
            label={t('catalog.number')}
            dir="ltr"
            value={number}
            onChange={(e) => {
              setNumber(e.currentTarget.value);
            }}
          />
          <Select
            label={t('catalog.kind')}
            value={kind}
            onChange={setKind}
            required={number.trim() !== ''}
            data={PART_NUMBER_KINDS.map((k) => ({ value: k, label: t(`catalog.numberKind.${k}`) }))}
          />
        </Group>
        <ErrorAlert error={create.error} />
        <Button type="submit" loading={create.isPending}>
          {t('common.save')}
        </Button>
      </Stack>
    </Modal>
  );
}

export function PartsPage() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 300);
  const [review, setReview] = useState<Review>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkGrade, setBulkGrade] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const manage = can('catalog.manage');

  const query = (after: string | undefined) => {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (q !== '') params.set('q', q);
    if (review !== 'all') params.set('needsReview', review);
    if (after !== undefined) params.set('after', after);
    return `/catalog/parts?${params.toString()}`;
  };
  const parts = useInfiniteQuery({
    queryKey: [...catalogKeys.parts, q, review],
    queryFn: ({ pageParam }) => api<PartSummary[]>('GET', query(pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last.at(-1)?.sku),
  });
  const rows = parts.data?.pages.flat() ?? [];

  const bulk = useMutation({
    mutationFn: () =>
      api<{ updated: number }>('POST', '/catalog/parts/bulk-update', {
        ids: [...selected],
        set: { qualityGrade: bulkGrade },
      }),
    onSuccess: async () => {
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: catalogKeys.parts });
    },
  });

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('catalog.partsTitle')}</Title>
        {manage && (
          <Button
            onClick={() => {
              setCreating(true);
            }}
          >
            {t('catalog.newPart')}
          </Button>
        )}
      </Group>
      <Group align="flex-end">
        <TextInput
          style={{ flex: 1 }}
          aria-label={t('catalog.filter')}
          placeholder={t('catalog.filter')}
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
          }}
        />
        <SegmentedControl
          value={review}
          onChange={(v) => {
            setReview(v);
            setSelected(new Set());
          }}
          data={(['all', ...NEEDS_REVIEW] as const).map((v) => ({
            value: v,
            label: t(`catalog.needsReview.${v}`),
          }))}
        />
      </Group>
      {manage && selected.size > 0 && (
        <Group>
          <Text>{t('catalog.selected', { count: selected.size })}</Text>
          <Select
            aria-label={t('catalog.bulkGrade')}
            placeholder={t('catalog.bulkGrade')}
            value={bulkGrade}
            onChange={setBulkGrade}
            data={QUALITY_GRADES.map((g) => ({ value: g, label: t(`catalog.gradeLabel.${g}`) }))}
          />
          <Button
            disabled={bulkGrade === null}
            loading={bulk.isPending}
            onClick={() => {
              bulk.mutate();
            }}
          >
            {t('catalog.bulkApply')}
          </Button>
        </Group>
      )}
      <ErrorAlert error={parts.error ?? bulk.error} />
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            {manage && <Table.Th />}
            <Table.Th>{t('catalog.sku')}</Table.Th>
            <Table.Th>{t('catalog.name')}</Table.Th>
            <Table.Th>{t('catalog.grade')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((p) => (
            <Table.Tr key={p.id}>
              {manage && (
                <Table.Td>
                  <Checkbox
                    aria-label={p.sku}
                    checked={selected.has(p.id)}
                    onChange={() => {
                      toggle(p.id);
                    }}
                  />
                </Table.Td>
              )}
              <Table.Td>
                <Anchor component={Link} to={`/catalog/parts/${p.id}`} dir="ltr">
                  {p.sku}
                </Anchor>
              </Table.Td>
              <Table.Td>
                {partName(p, i18n.language)}{' '}
                {p.archivedAt !== null && <Badge color="gray">{t('catalog.archived')}</Badge>}
              </Table.Td>
              <Table.Td>
                <GradeBadge grade={p.qualityGrade} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {rows.length === 0 && !parts.isLoading && <Text c="dimmed">{t('catalog.empty')}</Text>}
      {parts.hasNextPage && (
        <Button
          variant="light"
          loading={parts.isFetchingNextPage}
          onClick={() => {
            void parts.fetchNextPage();
          }}
        >
          {t('catalog.loadMore')}
        </Button>
      )}
      {creating && (
        <NewPartModal
          onClose={() => {
            setCreating(false);
          }}
        />
      )}
    </Stack>
  );
}
