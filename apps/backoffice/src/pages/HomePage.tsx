import { Badge, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth';

export function HomePage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  if (me === null) return null;
  return (
    <Stack>
      <Title order={2}>{t('home.welcome', { name: me.user.displayName })}</Title>
      <Paper withBorder p="md">
        <Stack gap="xs">
          <Text>
            {t('home.shop')}: <b>{me.tenant.name}</b> ({me.tenant.slug})
          </Text>
          <Text>
            {t('home.functionalCurrency')}: <b>{me.tenant.functionalCurrency}</b>
          </Text>
          <Group gap="xs">
            <Text>{t('home.permissions')}:</Text>
            {me.permissions.length === 0 ? (
              <Text c="dimmed">{t('common.none')}</Text>
            ) : (
              me.permissions.map((p) => (
                <Badge key={p} variant="light">
                  {t(`permissions.${p}`)}
                </Badge>
              ))
            )}
          </Group>
        </Stack>
      </Paper>
    </Stack>
  );
}
