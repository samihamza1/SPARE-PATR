import type { Permission } from '@autoparts/shared';
import { AppShell, Burger, Button, Group, NavLink, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useTranslation } from 'react-i18next';
import { Outlet, NavLink as RouterLink } from 'react-router';
import { LANGUAGE_KEY, useAuth } from '../auth';

interface NavItem {
  to: string;
  label: string;
  permission?: Permission;
}

const NAV: NavItem[] = [
  { to: '/', label: 'nav.home' },
  { to: '/search', label: 'nav.search' },
  { to: '/catalog/parts', label: 'nav.parts' },
  { to: '/catalog/vehicles', label: 'nav.vehicles' },
  { to: '/catalog/setup', label: 'nav.catalogSetup' },
  { to: '/catalog/imports', label: 'nav.imports', permission: 'catalog.import' },
  { to: '/users', label: 'nav.users', permission: 'users.manage' },
  { to: '/roles', label: 'nav.roles' },
  { to: '/settings', label: 'nav.settings', permission: 'settings.manage' },
  { to: '/devices', label: 'nav.devices', permission: 'devices.manage' },
  { to: '/audit', label: 'nav.audit', permission: 'audit.read' },
];

export function LanguageSwitch() {
  const { t, i18n } = useTranslation();
  const other = i18n.language === 'ar' ? 'en' : 'ar';
  return (
    <Button
      variant="subtle"
      lang={other}
      onClick={() => {
        localStorage.setItem(LANGUAGE_KEY, other);
        void i18n.changeLanguage(other);
      }}
    >
      {t('language.switch')}
    </Button>
  );
}

export function Shell() {
  const { t } = useTranslation();
  const { me, can, logout } = useAuth();
  const [opened, { toggle, close }] = useDisclosure();

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              aria-label={t('nav.menu')}
            />
            <Title order={4}>{t('app.title')}</Title>
            <Text c="dimmed" size="sm">
              {me?.tenant.name}
            </Text>
          </Group>
          <Group gap="xs">
            <Text size="sm">{me?.user.displayName}</Text>
            <LanguageSwitch />
            <Button
              variant="light"
              onClick={() => {
                // RequireAuth sends us to the login page once the session is gone.
                void logout();
              }}
            >
              {t('auth.logout')}
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs" aria-label={t('nav.menu')}>
        <Stack gap={2}>
          {NAV.filter((item) => item.permission === undefined || can(item.permission)).map(
            (item) => (
              <NavLink
                key={item.to}
                component={RouterLink}
                to={item.to}
                end={item.to === '/'}
                label={t(item.label)}
                onClick={close}
              />
            ),
          )}
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
