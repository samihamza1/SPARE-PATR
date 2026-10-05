import { ALIAS_TARGETS, VEHICLE_LEVELS, newId } from '@autoparts/shared';
import type { Vehicle, VehicleAlias } from '@autoparts/shared';
import {
  Anchor,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { VehiclePicker, catalogKeys, categoryName, useCategories } from '../../catalog/common';
import { ErrorAlert } from '../../components/ErrorAlert';

const years = (v: Vehicle) =>
  v.yearFrom === null && v.yearTo === null
    ? ''
    : `${v.yearFrom === null ? '' : String(v.yearFrom)}–${v.yearTo === null ? '' : String(v.yearTo)}`;

function AddVehicle({ parent, onAdded }: { parent: Vehicle; onAdded: () => void }) {
  const { t } = useTranslation();
  const level = VEHICLE_LEVELS[VEHICLE_LEVELS.indexOf(parent.level) + 1];
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [engine, setEngine] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api('POST', '/catalog/vehicles', {
        id: newId(),
        parentId: parent.id,
        level,
        name: name.trim(),
        nameAr: nameAr.trim() === '' ? null : nameAr.trim(),
        ...((level === 'generation' || level === 'engine') && { yearFrom: from, yearTo: to }),
        ...(level === 'engine' && { engineCode: engine.trim() === '' ? null : engine.trim() }),
      }),
    onSuccess: () => {
      setName('');
      setNameAr('');
      setEngine('');
      onAdded();
    },
  });
  if (level === undefined) return null;
  const toNumber = (v: string | number) => (typeof v === 'number' ? v : null);
  return (
    <Stack gap="xs">
      <Group
        component="form"
        align="flex-end"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <TextInput
          label={`${t('fields.name')} (${t(`catalog.level.${level}`)})`}
          required
          dir="ltr"
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
          }}
        />
        <TextInput
          label={t('vehicles.nameAr')}
          value={nameAr}
          onChange={(e) => {
            setNameAr(e.currentTarget.value);
          }}
        />
        {(level === 'generation' || level === 'engine') && (
          <>
            <NumberInput
              label={t('vehicles.yearFrom')}
              min={1900}
              max={2100}
              allowDecimal={false}
              value={from ?? ''}
              onChange={(v) => {
                setFrom(toNumber(v));
              }}
            />
            <NumberInput
              label={t('vehicles.yearTo')}
              min={1900}
              max={2100}
              allowDecimal={false}
              value={to ?? ''}
              onChange={(v) => {
                setTo(toNumber(v));
              }}
            />
          </>
        )}
        {level === 'engine' && (
          <TextInput
            label={t('vehicles.engineCode')}
            dir="ltr"
            value={engine}
            onChange={(e) => {
              setEngine(e.currentTarget.value);
            }}
          />
        )}
        <Button type="submit" loading={add.isPending}>
          {t('vehicles.add')}
        </Button>
      </Group>
      <ErrorAlert error={add.error} />
    </Stack>
  );
}

function Aliases() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const categories = useCategories();
  const aliases = useQuery({
    queryKey: catalogKeys.aliases,
    queryFn: () => api<VehicleAlias[]>('GET', '/catalog/vehicle-aliases'),
  });
  const [alias, setAlias] = useState('');
  const [target, setTarget] = useState<string | null>('vehicle');
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: catalogKeys.aliases });
  const add = useMutation({
    mutationFn: () =>
      api('POST', '/catalog/vehicle-aliases', {
        id: newId(),
        alias: alias.trim(),
        target,
        vehicleId: target === 'vehicle' ? vehicle?.id : null,
        categoryId: target === 'category' ? categoryId : null,
      }),
    onSuccess: async () => {
      setAlias('');
      setVehicle(null);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api('POST', `/catalog/vehicle-aliases/${id}/remove`),
    onSuccess: refresh,
  });
  const catName = (id: string | null) => {
    const c = categories.data?.find((x) => x.id === id);
    return c === undefined ? '' : categoryName(c, i18n.language);
  };
  return (
    <Card withBorder>
      <Title order={4}>{t('vehicles.aliases')}</Title>
      <Text size="sm" c="dimmed">
        {t('vehicles.aliasesHint')}
      </Text>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('vehicles.alias')}</Table.Th>
            <Table.Th>{t('vehicles.mapsTo')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {aliases.data?.map((a) => (
            <Table.Tr key={a.id}>
              <Table.Td dir="ltr">{a.alias}</Table.Td>
              <Table.Td>
                {t(`vehicles.target.${a.target}`)}
                {a.target === 'vehicle' && `: ${a.vehicleName ?? ''}`}
                {a.target === 'category' && `: ${catName(a.categoryId)}`}
              </Table.Td>
              <Table.Td>
                {can('catalog.manage') && (
                  <Button
                    size="xs"
                    variant="subtle"
                    color="red"
                    onClick={() => {
                      remove.mutate(a.id);
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
      {can('catalog.manage') && (
        <Group
          component="form"
          align="flex-end"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <TextInput
            label={t('vehicles.alias')}
            required
            value={alias}
            onChange={(e) => {
              setAlias(e.currentTarget.value);
            }}
          />
          <Select
            label={t('vehicles.mapsTo')}
            value={target}
            onChange={setTarget}
            data={ALIAS_TARGETS.map((x) => ({ value: x, label: t(`vehicles.target.${x}`) }))}
          />
          {target === 'vehicle' &&
            (vehicle === null ? (
              <VehiclePicker onPick={setVehicle} />
            ) : (
              <Badge
                size="lg"
                variant="light"
                onClick={() => {
                  setVehicle(null);
                }}
              >
                {vehicle.name} ×
              </Badge>
            ))}
          {target === 'category' && (
            <Select
              label={t('catalog.category')}
              value={categoryId}
              onChange={setCategoryId}
              data={(categories.data ?? []).map((c) => ({
                value: c.id,
                label: categoryName(c, i18n.language),
              }))}
            />
          )}
          <Button type="submit" loading={add.isPending}>
            {t('vehicles.addAlias')}
          </Button>
        </Group>
      )}
      <ErrorAlert error={aliases.error ?? add.error ?? remove.error} />
    </Card>
  );
}

export function VehiclesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [path, setPath] = useState<Vehicle[]>([]);
  const current = path.at(-1);
  const key = ['catalog', 'vehicles', current?.id ?? 'root'] as const;
  const children = useQuery({
    queryKey: key,
    queryFn: () =>
      api<Vehicle[]>(
        'GET',
        current === undefined ? '/catalog/vehicles' : `/catalog/vehicles?parentId=${current.id}`,
      ),
  });

  return (
    <Stack>
      <Title order={2}>{t('vehicles.title')}</Title>
      <Breadcrumbs>
        <Anchor
          component="button"
          onClick={() => {
            setPath([]);
          }}
        >
          {t('vehicles.all')}
        </Anchor>
        {path.map((v, i) => (
          <Anchor
            key={v.id}
            component="button"
            onClick={() => {
              setPath(path.slice(0, i + 1));
            }}
          >
            {v.name}
          </Anchor>
        ))}
      </Breadcrumbs>
      <ErrorAlert error={children.error} />
      <Table striped highlightOnHover>
        <Table.Tbody>
          {children.data?.map((v) => (
            <Table.Tr key={v.id}>
              <Table.Td>
                <Anchor
                  component="button"
                  onClick={() => {
                    setPath([...path, v]);
                  }}
                >
                  {v.name}
                </Anchor>{' '}
                {v.nameAr !== null && <Text span>/ {v.nameAr}</Text>}
              </Table.Td>
              <Table.Td>{t(`catalog.level.${v.level}`)}</Table.Td>
              <Table.Td dir="ltr">
                {years(v)} {v.engineCode ?? ''}
              </Table.Td>
              <Table.Td>
                <Badge variant="light" color={v.isLocal ? 'grape' : 'gray'}>
                  {v.isLocal ? t('vehicles.local') : t('vehicles.platform')}
                </Badge>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {children.data?.length === 0 && <Text c="dimmed">{t('vehicles.empty')}</Text>}
      {can('catalog.manage') && current !== undefined && (
        <AddVehicle
          parent={current}
          onAdded={() => {
            void queryClient.invalidateQueries({ queryKey: key });
          }}
        />
      )}
      <Aliases />
    </Stack>
  );
}
