import type {
  Brand,
  Category,
  Currency,
  PartSummary,
  PriceList,
  QualityGrade,
  Vehicle,
} from '@autoparts/shared';
import { Badge, Select, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';

export const catalogKeys = {
  brands: ['catalog', 'brands'] as const,
  categories: ['catalog', 'categories'] as const,
  priceLists: ['catalog', 'price-lists'] as const,
  currencies: ['currencies'] as const,
  aliases: ['catalog', 'aliases'] as const,
  parts: ['catalog', 'parts'] as const,
  part: (id: string) => ['catalog', 'part', id] as const,
};

export const useBrands = () =>
  useQuery({ queryKey: catalogKeys.brands, queryFn: () => api<Brand[]>('GET', '/catalog/brands') });
export const useCategories = () =>
  useQuery({
    queryKey: catalogKeys.categories,
    queryFn: () => api<Category[]>('GET', '/catalog/categories'),
  });
export const usePriceLists = () =>
  useQuery({
    queryKey: catalogKeys.priceLists,
    queryFn: () => api<PriceList[]>('GET', '/catalog/price-lists'),
  });
export const useCurrencies = () =>
  useQuery({
    queryKey: catalogKeys.currencies,
    queryFn: () => api<Currency[]>('GET', '/currencies'),
  });

const GRADE_COLORS: Record<QualityGrade, string> = {
  oem: 'teal',
  premium: 'blue',
  good: 'grape',
  economy: 'orange',
};

export function GradeBadge({ grade }: { grade: QualityGrade | null }) {
  const { t } = useTranslation();
  return grade === null ? (
    <Badge variant="outline" color="gray">
      {t('catalog.gradeLabel.none')}
    </Badge>
  ) : (
    <Badge color={GRADE_COLORS[grade]}>{t(`catalog.gradeLabel.${grade}`)}</Badge>
  );
}

/** A decimal string from the API, shown as is (never through a JS number). */
export function Price({ price }: { price: { amount: string; currency: string } | null }) {
  const { t } = useTranslation();
  if (price === null) return <Text c="dimmed">{t('catalog.noPrice')}</Text>;
  return (
    <Text span dir="ltr" ff="monospace">
      {price.amount} {price.currency}
    </Text>
  );
}

export const partName = (p: Pick<PartSummary, 'nameAr' | 'nameEn'>, lang: string): string =>
  (lang === 'ar' ? (p.nameAr ?? p.nameEn) : (p.nameEn ?? p.nameAr)) ?? '';

export const categoryName = (c: Category, lang: string): string =>
  (lang === 'ar' ? (c.nameAr ?? c.nameEn) : (c.nameEn ?? c.nameAr)) ?? '';

/** Picks a vehicle (shared or this shop's) by searching its name, Arabic name or engine code. */
export function VehiclePicker({
  label,
  error,
  onPick,
}: {
  label?: string;
  error?: string | undefined;
  onPick: (vehicle: Vehicle) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  const found = useQuery({
    queryKey: ['catalog', 'vehicle-search', q],
    queryFn: () => api<Vehicle[]>('GET', `/catalog/vehicles?q=${encodeURIComponent(q)}`),
    enabled: q.length > 0,
  });
  const byId = new Map((found.data ?? []).map((v) => [v.id, v]));
  return (
    <Select
      label={label ?? t('catalog.chooseVehicle')}
      placeholder={t('catalog.chooseVehicle')}
      error={error}
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      filter={({ options }) => options}
      value={null}
      data={(found.data ?? []).map((v) => ({
        value: v.id,
        label: `${v.name}${v.nameAr === null ? '' : ` / ${v.nameAr}`} (${t(`catalog.level.${v.level}`)}${
          v.yearFrom === null
            ? ''
            : ` ${String(v.yearFrom)}–${v.yearTo === null ? '' : String(v.yearTo)}`
        })`,
      }))}
      onChange={(id) => {
        const v = id === null ? undefined : byId.get(id);
        if (v !== undefined) {
          onPick(v);
          setSearch('');
        }
      }}
    />
  );
}

/** Picks a part by SKU, name or number. */
export function PartPicker({
  label,
  exclude,
  onPick,
}: {
  label: string;
  exclude?: string;
  onPick: (part: PartSummary) => void;
}) {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 250);
  const found = useQuery({
    queryKey: ['catalog', 'part-search', q],
    queryFn: () => api<PartSummary[]>('GET', `/catalog/parts?limit=20&q=${encodeURIComponent(q)}`),
    enabled: q.length > 0,
  });
  const parts = (found.data ?? []).filter((p) => p.id !== exclude);
  const byId = new Map(parts.map((p) => [p.id, p]));
  return (
    <Select
      label={label}
      placeholder={t('catalog.choosePart')}
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      filter={({ options }) => options}
      value={null}
      data={parts.map((p) => ({ value: p.id, label: `${p.sku} — ${partName(p, i18n.language)}` }))}
      onChange={(id) => {
        const p = id === null ? undefined : byId.get(id);
        if (p !== undefined) {
          onPick(p);
          setSearch('');
        }
      }}
    />
  );
}
