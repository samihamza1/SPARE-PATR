import { newId } from '@autoparts/shared';
import type { Device } from '@autoparts/shared';
import {
  Badge,
  Button,
  Code,
  CopyButton,
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
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorAlert } from '../components/ErrorAlert';
import { useFormatDateTime } from '../format';
import { Form, useRequired } from '../forms';
import { inventoryKeys, useLocationNames, useLocations } from '../inventory/common';

const DEVICES_KEY = ['devices'] as const;

interface CodeResult {
  device: Device;
  enrollmentCode: string;
}

function EnrollmentCode({ result, onClose }: { result: CodeResult; onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const formatDateTime = useFormatDateTime();
  return (
    <Modal opened onClose={onClose} title={t('devices.codeTitle', { name: result.device.name })}>
      <Stack>
        <Text>{t('devices.codeInstructions')}</Text>
        <Text>
          {t('auth.shopCode')}: <Code dir="ltr">{me?.tenant.slug}</Code>
        </Text>
        <Group>
          <Code fz="xl" dir="ltr" data-testid="enrollment-code">
            {result.enrollmentCode}
          </Code>
          <CopyButton value={result.enrollmentCode}>
            {({ copied, copy }) => (
              <Button size="xs" variant="light" onClick={copy}>
                {copied ? t('common.copied') : t('common.copy')}
              </Button>
            )}
          </CopyButton>
        </Group>
        <Text size="sm" c="dimmed">
          {t('devices.codeExpires', { time: formatDateTime(result.device.enrollmentExpiresAt) })}
        </Text>
      </Stack>
    </Modal>
  );
}

export function DevicesPage() {
  const { t } = useTranslation();
  const formatDateTime = useFormatDateTime();
  const queryClient = useQueryClient();
  const devices = useQuery({
    queryKey: DEVICES_KEY,
    queryFn: () => api<Device[]>('GET', '/devices'),
  });
  const [name, setName] = useState('');
  const [code, setCode] = useState<CodeResult | null>(null);
  const required = useRequired({ name });
  const refresh = () => queryClient.invalidateQueries({ queryKey: DEVICES_KEY });

  const create = useMutation({
    mutationFn: () => api<CodeResult>('POST', '/devices', { id: newId(), name: name.trim() }),
    onSuccess: async (result) => {
      setName('');
      required.reset();
      setCode(result);
      await refresh();
    },
  });
  const newCode = useMutation({
    mutationFn: (device: Device) =>
      api<CodeResult>('POST', `/devices/${device.id}/enrollment-code`),
    onSuccess: async (result) => {
      setCode(result);
      await refresh();
    },
  });
  const locations = useLocations();
  const locationName = useLocationNames();
  const shops = (locations.data ?? [])
    .filter((l) => l.kind === 'shop')
    .map((l) => ({ value: l.id, label: l.name }));
  const move = useMutation({
    mutationFn: ({ device, locationId }: { device: Device; locationId: string }) =>
      api<Device>('PATCH', `/devices/${device.id}`, { locationId }),
    onSuccess: async () => {
      await refresh();
      await queryClient.invalidateQueries({ queryKey: inventoryKeys.locations });
    },
  });
  const revoke = useMutation({
    mutationFn: (device: Device) => api<Device>('POST', `/devices/${device.id}/revoke`),
    onSuccess: refresh,
  });

  const status = (d: Device) => {
    if (d.revokedAt !== null) return <Badge color="red">{t('devices.revoked')}</Badge>;
    if (d.enrolledAt !== null) return <Badge color="green">{t('devices.enrolled')}</Badge>;
    return <Badge color="yellow">{t('devices.pending')}</Badge>;
  };

  return (
    <Stack>
      <Title order={2}>{t('devices.title')}</Title>
      <Form
        onSubmit={() => {
          if (required.ok()) create.mutate();
        }}
      >
        <Group align="flex-end">
          <TextInput
            label={t('devices.name')}
            required
            value={name}
            error={required.errors.name}
            onChange={(e) => {
              setName(e.currentTarget.value);
            }}
          />
          <Button type="submit" loading={create.isPending}>
            {t('devices.add')}
          </Button>
        </Group>
      </Form>
      <ErrorAlert
        error={devices.error ?? create.error ?? newCode.error ?? revoke.error ?? move.error}
      />
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('devices.name')}</Table.Th>
            <Table.Th>{t('devices.location')}</Table.Th>
            <Table.Th>{t('devices.status')}</Table.Th>
            <Table.Th>{t('devices.lastSeen')}</Table.Th>
            <Table.Th>{t('common.actions')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {devices.data?.map((d) => (
            <Table.Tr key={d.id}>
              <Table.Td>{d.name}</Table.Td>
              <Table.Td>
                {d.revokedAt === null ? (
                  <Select
                    aria-label={t('devices.location')}
                    data={shops}
                    value={d.locationId}
                    allowDeselect={false}
                    size="xs"
                    onChange={(locationId) => {
                      if (locationId !== null && locationId !== d.locationId)
                        move.mutate({ device: d, locationId });
                    }}
                  />
                ) : (
                  locationName(d.locationId)
                )}
              </Table.Td>
              <Table.Td>{status(d)}</Table.Td>
              <Table.Td>{formatDateTime(d.lastSeenAt)}</Table.Td>
              <Table.Td>
                {d.revokedAt === null && (
                  <Group gap="xs">
                    {d.enrolledAt === null && (
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => {
                          newCode.mutate(d);
                        }}
                      >
                        {t('devices.newCode')}
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="light"
                      color="red"
                      onClick={() => {
                        if (window.confirm(t('devices.revokeConfirm', { name: d.name })))
                          revoke.mutate(d);
                      }}
                    >
                      {t('devices.revoke')}
                    </Button>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {code !== null && (
        <EnrollmentCode
          result={code}
          onClose={() => {
            setCode(null);
          }}
        />
      )}
    </Stack>
  );
}
