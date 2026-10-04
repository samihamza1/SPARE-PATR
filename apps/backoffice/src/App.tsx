import { Center, Loader, Text } from '@mantine/core';
import { Suspense, lazy } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Route, Routes } from 'react-router';
import { RequireAuth } from './auth';
import { RequirePermission } from './components/RequirePermission';
import { Shell } from './components/Shell';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';

// Admin pages load on demand so sign-in and home stay small.
const UsersPage = lazy(() => import('./pages/UsersPage').then((m) => ({ default: m.UsersPage })));
const RolesPage = lazy(() => import('./pages/RolesPage').then((m) => ({ default: m.RolesPage })));
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const DevicesPage = lazy(() =>
  import('./pages/DevicesPage').then((m) => ({ default: m.DevicesPage })),
);
const AuditPage = lazy(() => import('./pages/AuditPage').then((m) => ({ default: m.AuditPage })));

function Page({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <Center p="xl">
          <Loader />
        </Center>
      }
    >
      {children}
    </Suspense>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <Center p="xl">
      <Text>{t('common.notFound')}</Text>
    </Center>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />
        <Route
          path="users"
          element={
            <RequirePermission permission="users.manage">
              <Page>
                <UsersPage />
              </Page>
            </RequirePermission>
          }
        />
        <Route
          path="roles"
          element={
            <Page>
              <RolesPage />
            </Page>
          }
        />
        <Route
          path="settings"
          element={
            <RequirePermission permission="settings.manage">
              <Page>
                <SettingsPage />
              </Page>
            </RequirePermission>
          }
        />
        <Route
          path="devices"
          element={
            <RequirePermission permission="devices.manage">
              <Page>
                <DevicesPage />
              </Page>
            </RequirePermission>
          }
        />
        <Route
          path="audit"
          element={
            <RequirePermission permission="audit.read">
              <Page>
                <AuditPage />
              </Page>
            </RequirePermission>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
