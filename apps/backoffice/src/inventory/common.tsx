import type { Location, PartStock } from '@autoparts/shared';
import { Badge, Group, Select, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';

export const inventoryKeys = {
  locations: ['inventory', 'locations'] as const,
  allLocations: ['inventory', 'locations', 'all'] as const,
  fxCurrent: ['inventory', 'fx', 'current'] as const,
  fxRates: ['inventory', 'fx', 'rates'] as const,
  partStock: (id: string) => ['inventory', 'part-stock', id] as const,
  moves: (query: string) => ['inventory', 'moves', query] as const,
  balances: (query: string) => ['inventory', 'balances', query] as const,
  counts: ['inventory', 'counts'] as const,
  count: (id: string) => ['inventory', 'count', id] as const,
  countLines: (id: string) => ['inventory', 'count-lines', id] as const,
  openings: ['inventory', 'openings'] as const,
  opening: (id: string) => ['inventory', 'opening', id] as const,
  openingLines: (id: string, status: string) => ['inventory', 'opening-lines', id, status] as const,
  review: (status: string) => ['inventory', 'review', status] as const,
};

/** Active locations (shop first by sort order); everyone signed in may read them. */
export const useLocations = () =>
  useQuery({
    queryKey: inventoryKeys.locations,
    queryFn: () => api<Location[]>('GET', '/locations'),
  });

/** id -> name, including archived locations (old moves may refer to them). */
export function useLocationNames(): (id: string | null) => string {
  const all = useQuery({
    queryKey: inventoryKeys.allLocations,
    queryFn: () => api<Location[]>('GET', '/locations?includeArchived=true'),
  });
  const names = new Map((all.data ?? []).map((l) => [l.id, l.name]));
  return (id) => (id === null ? '' : (names.get(id) ?? ''));
}

export function LocationSelect({
  label,
  value,
  onChange,
  kind,
  required,
}: {
  label: string;
  value: string | null;
  onChange: (id: string | null) => void;
  kind?: Location['kind'];
  required?: boolean;
}) {
  const locations = useLocations();
  const data = (locations.data ?? [])
    .filter((l) => kind === undefined || l.kind === kind)
    .map((l) => ({ value: l.id, label: l.name }));
  return (
    <Select
      label={label}
      data={data}
      value={value}
      onChange={onChange}
      required={required === true}
      allowDeselect={false}
    />
  );
}

export function LocationKindBadge({ kind }: { kind: Location['kind'] }) {
  const { t } = useTranslation();
  return (
    <Badge variant="light" color={kind === 'shop' ? 'blue' : 'gray'}>
      {t(`locations.kind.${kind}`)}
    </Badge>
  );
}

/** An amount from the API as a decimal string with its currency; never a JS number. */
export function Amount({ amount, currency }: { amount: string; currency: string }) {
  const { t } = useTranslation();
  return (
    <Text span dir="ltr" ff="monospace">
      {t('inventory.amount', { amount, currency })}
    </Text>
  );
}

/** Whole units, in the UI language's digits. */
export function useFormatQuantity(): (q: number) => string {
  const { i18n } = useTranslation();
  const fmt = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 });
  return (q) => fmt.format(q);
}

/** Quantities of one part per location, with a badge when none is on hand. */
export function StockBadges({ locations }: { locations: PartStock['locations'] }) {
  const { t } = useTranslation();
  const name = useLocationNames();
  const format = useFormatQuantity();
  const held = locations.filter((l) => l.quantity !== 0);
  if (held.length === 0) {
    return (
      <Badge color="gray" variant="outline">
        {t('inventory.outOfStock')}
      </Badge>
    );
  }
  return (
    <Group gap={4}>
      {held.map((l) => (
        <Badge key={l.locationId} color={l.quantity < 0 ? 'red' : 'green'} variant="light">
          {t('inventory.atLocation', {
            location: name(l.locationId),
            quantity: format(l.quantity),
          })}
        </Badge>
      ))}
    </Group>
  );
}
