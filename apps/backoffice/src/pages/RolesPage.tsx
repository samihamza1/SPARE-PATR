import { PERMISSIONS, newId } from '@autoparts/shared';
import type { Permission, Role } from '@autoparts/shared';
import {
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Stack,
  Table,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { ME_KEY, useAuth } from '../auth';
import { ErrorAlert } from '../components/ErrorAlert';
import { Form, useRequired } from '../forms';

const ROLES_KEY = ['roles'] as const;

/** System roles are shown in the UI language; custom roles by their stored name. */
export function roleLabel(t: TFunction, role: Pick<Role, 'code' | 'name' | 'isSystem'>): string {
  return role.isSystem ? t(`roles.system.${role.code}`, { defaultValue: role.name }) : role.name;
}

function CreateRoleModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const required = useRequired({ code, name });
  const create = useMutation({
    mutationFn: () => api<Role>('POST', '/roles', { id: newId(), code, name, permissions: [] }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROLES_KEY });
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title={t('roles.create')}>
      <Form
        onSubmit={() => {
          if (required.ok()) create.mutate();
        }}
      >
        <Stack>
          <ErrorAlert error={create.error} />
          <TextInput
            label={t('fields.code')}
            description={t('roles.codeHint')}
            required
            dir="ltr"
            value={code}
            error={required.errors.code}
            onChange={(e) => {
              setCode(e.currentTarget.value);
            }}
          />
          <TextInput
            label={t('fields.name')}
            required
            value={name}
            error={required.errors.name}
            onChange={(e) => {
              setName(e.currentTarget.value);
            }}
          />
          <Button type="submit" loading={create.isPending}>
            {t('common.save')}
          </Button>
        </Stack>
      </Form>
    </Modal>
  );
}

export function RolesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const editable = can('roles.manage');
  const queryClient = useQueryClient();
  const roles = useQuery({ queryKey: ROLES_KEY, queryFn: () => api<Role[]>('GET', '/roles') });
  const [creating, setCreating] = useState(false);
  const update = useMutation({
    mutationFn: ({ role, permissions }: { role: Role; permissions: Permission[] }) =>
      api<Role>('PATCH', `/roles/${role.id}`, { permissions }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROLES_KEY });
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  });

  const toggle = (role: Role, permission: Permission, on: boolean) => {
    const permissions = on
      ? [...role.permissions, permission]
      : role.permissions.filter((p) => p !== permission);
    update.mutate({ role, permissions });
  };

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('roles.title')}</Title>
        {editable && (
          <Button
            onClick={() => {
              setCreating(true);
            }}
          >
            {t('roles.create')}
          </Button>
        )}
      </Group>
      <ErrorAlert error={roles.error ?? update.error} />
      <Table.ScrollContainer minWidth={700}>
        <Table striped withColumnBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('roles.permission')}</Table.Th>
              {roles.data?.map((role) => (
                <Table.Th key={role.id}>
                  <Group gap={4}>
                    {roleLabel(t, role)}
                    {role.isSystem && (
                      <Badge size="xs" variant="outline">
                        {t('roles.systemBadge')}
                      </Badge>
                    )}
                  </Group>
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {PERMISSIONS.map((permission) => (
              <Table.Tr key={permission}>
                <Table.Td>{t(`permissions.${permission}`)}</Table.Td>
                {roles.data?.map((role) => (
                  <Table.Td key={role.id}>
                    <Checkbox
                      aria-label={`${roleLabel(t, role)}: ${t(`permissions.${permission}`)}`}
                      checked={role.permissions.includes(permission)}
                      disabled={!editable || update.isPending}
                      onChange={(e) => {
                        toggle(role, permission, e.currentTarget.checked);
                      }}
                    />
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {creating && (
        <CreateRoleModal
          onClose={() => {
            setCreating(false);
          }}
        />
      )}
    </Stack>
  );
}
