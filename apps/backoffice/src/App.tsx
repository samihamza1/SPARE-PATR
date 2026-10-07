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
const SearchPage = lazy(() =>
  import('./pages/catalog/SearchPage').then((m) => ({ default: m.SearchPage })),
);
const PartsPage = lazy(() =>
  import('./pages/catalog/PartsPage').then((m) => ({ default: m.PartsPage })),
);
const PartPage = lazy(() =>
  import('./pages/catalog/PartPage').then((m) => ({ default: m.PartPage })),
);
const VehiclesPage = lazy(() =>
  import('./pages/catalog/VehiclesPage').then((m) => ({ default: m.VehiclesPage })),
);
const SetupPage = lazy(() =>
  import('./pages/catalog/SetupPage').then((m) => ({ default: m.SetupPage })),
);
const ImportsPage = lazy(() =>
  import('./pages/catalog/ImportsPage').then((m) => ({ default: m.ImportsPage })),
);
const ImportBatchPage = lazy(() =>
  import('./pages/catalog/ImportBatchPage').then((m) => ({ default: m.ImportBatchPage })),
);

// Inventory (Sprint 4).
const LocationsPage = lazy(() =>
  import('./pages/inventory/LocationsPage').then((m) => ({ default: m.LocationsPage })),
);
const FxRatesPage = lazy(() =>
  import('./pages/inventory/FxRatesPage').then((m) => ({ default: m.FxRatesPage })),
);
const StockPage = lazy(() =>
  import('./pages/inventory/StockPage').then((m) => ({ default: m.StockPage })),
);
const MovementPage = lazy(() =>
  import('./pages/inventory/MovementPage').then((m) => ({ default: m.MovementPage })),
);
const OpeningListPage = lazy(() =>
  import('./pages/inventory/OpeningPage').then((m) => ({ default: m.OpeningListPage })),
);
const OpeningDraftPage = lazy(() =>
  import('./pages/inventory/OpeningPage').then((m) => ({ default: m.OpeningDraftPage })),
);
const CountsPage = lazy(() =>
  import('./pages/inventory/CountsPage').then((m) => ({ default: m.CountsPage })),
);
const CountPage = lazy(() =>
  import('./pages/inventory/CountsPage').then((m) => ({ default: m.CountPage })),
);
const ReviewPage = lazy(() =>
  import('./pages/inventory/ReviewPage').then((m) => ({ default: m.ReviewPage })),
);

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
        <Route
          path="search"
          element={
            <Page>
              <SearchPage />
            </Page>
          }
        />
        <Route
          path="catalog/parts"
          element={
            <Page>
              <PartsPage />
            </Page>
          }
        />
        <Route
          path="catalog/parts/:id"
          element={
            <Page>
              <PartPage />
            </Page>
          }
        />
        <Route
          path="catalog/vehicles"
          element={
            <Page>
              <VehiclesPage />
            </Page>
          }
        />
        <Route
          path="catalog/setup"
          element={
            <Page>
              <SetupPage />
            </Page>
          }
        />
        <Route
          path="catalog/imports"
          element={
            <RequirePermission permission="catalog.import">
              <Page>
                <ImportsPage />
              </Page>
            </RequirePermission>
          }
        />
        <Route
          path="catalog/imports/:id"
          element={
            <RequirePermission permission="catalog.import">
              <Page>
                <ImportBatchPage />
              </Page>
            </RequirePermission>
          }
        />
        <Route
          path="locations"
          element={
            <Page>
              <LocationsPage />
            </Page>
          }
        />
        <Route
          path="fx-rates"
          element={
            <Page>
              <FxRatesPage />
            </Page>
          }
        />
        <Route
          path="inventory/stock"
          element={
            <Page>
              <StockPage />
            </Page>
          }
        />
        <Route
          path="inventory/adjust"
          element={
            <RequirePermission permission="stock.adjust">
              <Page>
                <MovementPage mode="adjust" />
              </Page>
            </RequirePermission>
          }
        />
        <Route
          path="inventory/transfer"
          element={
            <RequirePermission permission="stock.transfer">
              <Page>
                <MovementPage mode="transfer" />
              </Page>
            </RequirePermission>
          }
        />
        <Route
          path="inventory/opening"
          element={
            <RequirePermission permission="stock.opening">
              <Page>
                <OpeningListPage />
              </Page>
            </RequirePermission>
          }
        />
        <Route
          path="inventory/opening/:id"
          element={
            <RequirePermission permission="stock.opening">
              <Page>
                <OpeningDraftPage />
              </Page>
            </RequirePermission>
          }
        />
        <Route
          path="inventory/counts"
          element={
            <RequirePermission permission="stock.count">
              <Page>
                <CountsPage />
              </Page>
            </RequirePermission>
          }
        />
        <Route
          path="inventory/counts/:id"
          element={
            <RequirePermission permission="stock.count">
              <Page>
                <CountPage />
              </Page>
            </RequirePermission>
          }
        />
        <Route
          path="inventory/review"
          element={
            <RequirePermission permission="stock.review">
              <Page>
                <ReviewPage />
              </Page>
            </RequirePermission>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
