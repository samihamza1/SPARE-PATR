import { LOCATION_KINDS, newId } from '@autoparts/shared';
import type { Location } from '@autoparts/shared';
import {
  Badge,
  Button,
  Group,
  Modal,
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
import { ErrorAlert } from '../../components/ErrorAlert';
import { LocationKindBadge, inventoryKeys } from '../../inventory/common';

/** The shop, storerooms and warehouses (ADR 0018). */
export function LocationsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const manage = can('locations.manage');
  const queryClient = useQueryClient();
  const locations = useQuery({
    queryKey: inventoryKeys.allLocations,
    queryFn: () => api<Location[]>('GET', '/locations?includeArchived=true'),
  });
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Location['kind']>('warehouse');
  const [renaming, setRenaming] = useState<Location | null>(null);
  const [newName, setNewName] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['inventory', 'locations'] });

  const create = useMutation({
    mutationFn: () => api<Location>('POST', '/locations', { id: newId(), name: name.trim(), kind }),
    onSuccess: async () => {
      setName('');
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<Location>('PATCH', `/locations/${id}`, body),
    onSuccess: async () => {
      setRenaming(null);
      await refresh();
    },
  });

  return (
    <Stack>
      <Title order={2}>{t('locations.title')}</Title>
      <Text c="dimmed">{t('locations.intro')}</Text>
      {manage && (
        <Group
          component="form"
          align="flex-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() !== '') create.mutate();
          }}
        >
          <TextInput
            label={t('locations.name')}
            required
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value);
            }}
          />
          <Select
            label={t('locations.kindLabel')}
            data={LOCATION_KINDS.map((k) => ({ value: k, label: t(`locations.kind.${k}`) }))}
            value={kind}
            allowDeselect={false}
            onChange={(v) => {
              if (v === 'shop' || v === 'warehouse') setKind(v);
            }}
          />
          <Button type="submit" loading={create.isPending}>
            {t('locations.add')}
          </Button>
        </Group>
      )}
      <ErrorAlert error={locations.error ?? create.error ?? update.error} />
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('locations.name')}</Table.Th>
            <Table.Th>{t('locations.kindLabel')}</Table.Th>
            <Table.Th>{t('locations.status')}</Table.Th>
            {manage && <Table.Th>{t('common.actions')}</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {locations.data?.map((l) => (
            <Table.Tr key={l.id}>
              <Table.Td>{l.name}</Table.Td>
              <Table.Td>
                <LocationKindBadge kind={l.kind} />
              </Table.Td>
              <Table.Td>
                {l.isDefault && <Badge color="teal">{t('locations.default')}</Badge>}
                {l.archivedAt !== null && <Badge color="gray">{t('locations.archived')}</Badge>}
              </Table.Td>
              {manage && (
                <Table.Td>
                  <Group gap="xs">
                    <Button
                      size="xs"
                      variant="light"
                      onClick={() => {
                        setRenaming(l);
                        setNewName(l.name);
                      }}
                    >
                      {t('locations.rename')}
                    </Button>
                    {l.kind === 'shop' && !l.isDefault && l.archivedAt === null && (
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => {
                          update.mutate({ id: l.id, body: { isDefault: true } });
                        }}
                      >
                        {t('locations.makeDefault')}
                      </Button>
                    )}
                    {!l.isDefault && (
                      <Button
                        size="xs"
                        variant="light"
                        color={l.archivedAt === null ? 'red' : 'gray'}
                        onClick={() => {
                          const archive = l.archivedAt === null;
                          if (
                            !archive ||
                            window.confirm(t('locations.archiveConfirm', { name: l.name }))
                          )
                            update.mutate({ id: l.id, body: { archived: archive } });
                        }}
                      >
                        {l.archivedAt === null ? t('locations.archive') : t('locations.restore')}
                      </Button>
                    )}
                  </Group>
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {renaming !== null && (
        <Modal
          opened
          onClose={() => {
            setRenaming(null);
          }}
          title={t('locations.rename')}
        >
          <Stack
            component="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim() !== '')
                update.mutate({ id: renaming.id, body: { name: newName.trim() } });
            }}
          >
            <TextInput
              label={t('locations.name')}
              required
              value={newName}
              onChange={(e) => {
                setNewName(e.currentTarget.value);
              }}
            />
            <Button type="submit" loading={update.isPending}>
              {t('common.save')}
            </Button>
          </Stack>
        </Modal>
      )}
    </Stack>
  );
}
