import type { Permission } from '@autoparts/shared';
import {
  AppShell,
  Burger,
  Button,
  Group,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, NavLink as RouterLink } from 'react-router';
import { LANGUAGE_KEY, useAuth } from '../auth';
import { errorText } from './ErrorAlert';

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
  { to: '/inventory/stock', label: 'nav.stock' },
  { to: '/inventory/adjust', label: 'nav.adjust', permission: 'stock.adjust' },
  { to: '/inventory/transfer', label: 'nav.transfer', permission: 'stock.transfer' },
  { to: '/inventory/counts', label: 'nav.counts', permission: 'stock.count' },
  { to: '/inventory/opening', label: 'nav.opening', permission: 'stock.opening' },
  { to: '/inventory/review', label: 'nav.review', permission: 'stock.review' },
  { to: '/locations', label: 'nav.locations' },
  { to: '/fx-rates', label: 'nav.fxRates' },
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
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try {
      // RequireAuth sends us to the login page once the session is gone.
      await logout();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: t('auth.logoutFailed'),
        message: errorText(t, error),
        autoClose: false,
      });
    } finally {
      setSigningOut(false);
    }
  };

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
              loading={signingOut}
              onClick={() => {
                void signOut();
              }}
            >
              {t('auth.logout')}
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs" aria-label={t('nav.menu')}>
        {/* The menu outgrows short screens; it scrolls on its own, below the header. */}
        <AppShell.Section grow component={ScrollArea}>
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
        </AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
