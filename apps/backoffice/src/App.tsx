import { Center, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { Route, Routes } from 'react-router';
import { RequireAuth } from './auth';
import { RequirePermission } from './components/RequirePermission';
import { Shell } from './components/Shell';
import { AuditPage } from './pages/AuditPage';
import { DevicesPage } from './pages/DevicesPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { RolesPage } from './pages/RolesPage';
import { SettingsPage } from './pages/SettingsPage';
import { UsersPage } from './pages/UsersPage';

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
              <UsersPage />
            </RequirePermission>
          }
        />
        <Route path="roles" element={<RolesPage />} />
        <Route
          path="settings"
          element={
            <RequirePermission permission="settings.manage">
              <SettingsPage />
            </RequirePermission>
          }
        />
        <Route
          path="devices"
          element={
            <RequirePermission permission="devices.manage">
              <DevicesPage />
            </RequirePermission>
          }
        />
        <Route
          path="audit"
          element={
            <RequirePermission permission="audit.read">
              <AuditPage />
            </RequirePermission>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
