import {
  Button,
  Center,
  Group,
  Paper,
  PasswordInput,
  Stack,
  TextInput,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { SHOP_CODE_KEY, useAuth } from '../auth';
import { ErrorAlert } from '../components/ErrorAlert';
import { LanguageSwitch } from '../components/Shell';

export function LoginPage() {
  const { t } = useTranslation();
  const { me, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [tenant, setTenant] = useState(() => localStorage.getItem(SHOP_CODE_KEY) ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/';
  if (me !== null) return <Navigate to={from} replace />;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await login({ tenant: tenant.trim(), username: username.trim(), password });
      await navigate(from, { replace: true });
    } catch (e) {
      setError(e);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center mih="100vh" p="md">
      <Paper
        withBorder
        shadow="sm"
        p="xl"
        w={380}
        component="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack>
          <Group justify="space-between">
            <Title order={2}>{t('auth.title')}</Title>
            <LanguageSwitch />
          </Group>
          <ErrorAlert error={error} />
          <TextInput
            label={t('auth.shopCode')}
            description={t('auth.shopCodeHint')}
            value={tenant}
            onChange={(e) => {
              setTenant(e.currentTarget.value);
            }}
            required
            autoComplete="organization"
            dir="ltr"
          />
          <TextInput
            label={t('auth.username')}
            value={username}
            onChange={(e) => {
              setUsername(e.currentTarget.value);
            }}
            required
            autoComplete="username"
          />
          <PasswordInput
            label={t('auth.password')}
            value={password}
            onChange={(e) => {
              setPassword(e.currentTarget.value);
            }}
            required
            autoComplete="current-password"
          />
          <Button type="submit" loading={busy}>
            {t('auth.submit')}
          </Button>
        </Stack>
      </Paper>
    </Center>
  );
}
