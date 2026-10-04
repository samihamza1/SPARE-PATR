import { newId } from '@autoparts/shared';
import type { Role, User } from '@autoparts/shared';
import {
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  PasswordInput,
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
import { roleLabel } from './RolesPage';

const USERS_KEY = ['users'] as const;

function CreateUserModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ username: '', displayName: '', password: '' });
  const create = useMutation({
    mutationFn: () => api<User>('POST', '/users', { id: newId(), ...form }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: USERS_KEY });
      setForm({ username: '', displayName: '', password: '' });
      onClose();
    },
  });
  return (
    <Modal opened={opened} onClose={onClose} title={t('users.create')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Stack>
          <ErrorAlert error={create.error} />
          <TextInput
            label={t('fields.username')}
            required
            value={form.username}
            onChange={(e) => {
              setForm({ ...form, username: e.currentTarget.value });
            }}
          />
          <TextInput
            label={t('fields.displayName')}
            required
            value={form.displayName}
            onChange={(e) => {
              setForm({ ...form, displayName: e.currentTarget.value });
            }}
          />
          <PasswordInput
            label={t('fields.password')}
            description={t('users.passwordHint')}
            required
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => {
              setForm({ ...form, password: e.currentTarget.value });
            }}
          />
          <Button type="submit" loading={create.isPending}>
            {t('common.save')}
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}

function RolesModal({ user, roles, onClose }: { user: User; roles: Role[]; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: ({ roleId, grant }: { roleId: string; grant: boolean }) =>
      grant
        ? api<User>('POST', `/users/${user.id}/roles`, { roleId })
        : api<User>('POST', `/users/${user.id}/roles/${roleId}/revoke`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
  });
  return (
    <Modal opened onClose={onClose} title={t('users.rolesOf', { name: user.displayName })}>
      <Stack>
        <ErrorAlert error={toggle.error} />
        {roles.map((role) => (
          <Checkbox
            key={role.id}
            label={roleLabel(t, role)}
            checked={user.roleIds.includes(role.id)}
            disabled={toggle.isPending}
            onChange={(e) => {
              toggle.mutate({ roleId: role.id, grant: e.currentTarget.checked });
            }}
          />
        ))}
      </Stack>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: User; onClose: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const reset = useMutation({
    mutationFn: () => api('POST', `/users/${user.id}/password`, { password }),
    onSuccess: onClose,
  });
  return (
    <Modal opened onClose={onClose} title={t('users.resetPasswordOf', { name: user.displayName })}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          reset.mutate();
        }}
      >
        <Stack>
          <ErrorAlert error={reset.error} />
          <PasswordInput
            label={t('fields.password')}
            description={t('users.passwordHint')}
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.currentTarget.value);
            }}
          />
          <Text size="sm" c="dimmed">
            {t('users.resetPasswordEffect')}
          </Text>
          <Button type="submit" loading={reset.isPending}>
            {t('users.resetPassword')}
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}

export function UsersPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const formatDateTime = useFormatDateTime();
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: USERS_KEY, queryFn: () => api<User[]>('GET', '/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<Role[]>('GET', '/roles') });
  const [creating, setCreating] = useState(false);
  const [rolesFor, setRolesFor] = useState<User | null>(null);
  const [resetFor, setResetFor] = useState<User | null>(null);
  const archive = useMutation({
    mutationFn: (user: User) => api<User>('POST', `/users/${user.id}/archive`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
  });

  const roleName = (id: string) => {
    const role = roles.data?.find((r) => r.id === id);
    return role === undefined ? id : roleLabel(t, role);
  };

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('users.title')}</Title>
        <Button
          onClick={() => {
            setCreating(true);
          }}
        >
          {t('users.create')}
        </Button>
      </Group>
      <ErrorAlert error={users.error ?? archive.error} />
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('fields.username')}</Table.Th>
            <Table.Th>{t('fields.displayName')}</Table.Th>
            <Table.Th>{t('users.roles')}</Table.Th>
            <Table.Th>{t('users.lastLogin')}</Table.Th>
            <Table.Th>{t('common.actions')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {users.data?.map((user) => {
            const archived = user.archivedAt !== null;
            return (
              <Table.Tr key={user.id} c={archived ? 'dimmed' : 'inherit'}>
                <Table.Td dir="ltr">{user.username}</Table.Td>
                <Table.Td>{user.displayName}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {archived && <Badge color="gray">{t('users.archived')}</Badge>}
                    {user.roleIds.map((id) => (
                      <Badge key={id} variant="light">
                        {roleName(id)}
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td>{formatDateTime(user.lastLoginAt)}</Table.Td>
                <Table.Td>
                  {!archived && (
                    <Group gap="xs">
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => {
                          setRolesFor(user);
                        }}
                      >
                        {t('users.roles')}
                      </Button>
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => {
                          setResetFor(user);
                        }}
                      >
                        {t('users.resetPassword')}
                      </Button>
                      {user.id !== me?.user.id && (
                        <Button
                          size="xs"
                          variant="light"
                          color="red"
                          onClick={() => {
                            if (
                              window.confirm(t('users.archiveConfirm', { name: user.displayName }))
                            ) {
                              archive.mutate(user);
                            }
                          }}
                        >
                          {t('users.archive')}
                        </Button>
                      )}
                    </Group>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      <CreateUserModal
        opened={creating}
        onClose={() => {
          setCreating(false);
        }}
      />
      {rolesFor !== null && (
        <RolesModal
          user={users.data?.find((u) => u.id === rolesFor.id) ?? rolesFor}
          roles={roles.data ?? []}
          onClose={() => {
            setRolesFor(null);
          }}
        />
      )}
      {resetFor !== null && (
        <ResetPasswordModal
          user={resetFor}
          onClose={() => {
            setResetFor(null);
          }}
        />
      )}
    </Stack>
  );
}
