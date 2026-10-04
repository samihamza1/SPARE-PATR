import { Alert, Button, Center, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceIdentity } from './device';
import { EnrollError, enroll, loadDevice } from './device';

function LanguageSwitch() {
  const { t, i18n } = useTranslation();
  const other = i18n.language === 'ar' ? 'en' : 'ar';
  return (
    <Button variant="subtle" lang={other} onClick={() => void i18n.changeLanguage(other)}>
      {t('language.switch')}
    </Button>
  );
}

function EnrollForm({ onEnrolled }: { onEnrolled: (device: DeviceIdentity) => void }) {
  const { t } = useTranslation();
  const [tenant, setTenant] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onEnrolled(await enroll(tenant.trim().toLowerCase(), code.trim()));
    } catch (e) {
      setError(e instanceof EnrollError ? e.code : 'server.error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Stack>
        <Title order={3}>{t('enroll.title')}</Title>
        <Text c="dimmed">{t('enroll.instructions')}</Text>
        {error !== null && (
          <Alert color="red" role="alert">
            {t(`errors.${error}`, { defaultValue: t('errors.server.error') })}
          </Alert>
        )}
        <TextInput
          label={t('enroll.shopCode')}
          required
          dir="ltr"
          value={tenant}
          onChange={(e) => {
            setTenant(e.currentTarget.value);
          }}
        />
        <TextInput
          label={t('enroll.code')}
          placeholder={t('enroll.codePlaceholder')}
          required
          dir="ltr"
          autoComplete="off"
          value={code}
          onChange={(e) => {
            setCode(e.currentTarget.value);
          }}
        />
        <Button type="submit" loading={busy}>
          {t('enroll.submit')}
        </Button>
      </Stack>
    </form>
  );
}

export function App() {
  const { t } = useTranslation();
  const [device, setDevice] = useState<DeviceIdentity | null>(() => loadDevice());

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" w={420}>
        <Stack>
          <Group justify="space-between">
            <Title order={2}>{t('app.title')}</Title>
            <LanguageSwitch />
          </Group>
          {device === null ? (
            <EnrollForm onEnrolled={setDevice} />
          ) : (
            <Alert color="green" title={t('enroll.done')}>
              {t('enroll.doneDetail', { shop: device.tenant })}
              <Text size="sm" mt="xs">
                {t('app.status')}
              </Text>
            </Alert>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}
