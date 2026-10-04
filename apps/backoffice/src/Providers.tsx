import { DirectionProvider, MantineProvider, createTheme, useDirection } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { i18n as I18n } from 'i18next';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { directionOf } from '@autoparts/shared/i18n';
import { isUnauthenticated } from './api';
import { AuthProvider, ME_KEY } from './auth';

const theme = createTheme({
  primaryColor: 'blue',
  // System fonts render Arabic well on every platform we target; no web font download.
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Tahoma, "Noto Sans Arabic", sans-serif',
});

/** Keeps Mantine's direction (and therefore its RTL styles) in step with the language. */
function DirectionSync({ i18n }: { i18n: I18n }) {
  const { setDirection } = useDirection();
  useEffect(() => {
    const sync = (lng: string) => {
      setDirection(directionOf(lng));
    };
    sync(i18n.language);
    i18n.on('languageChanged', sync);
    return () => {
      i18n.off('languageChanged', sync);
    };
  }, [i18n, setDirection]);
  return null;
}

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    // A 401 anywhere means the session ended (idle, revoked): drop to the login page.
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (isUnauthenticated(error) && query.queryKey[0] !== ME_KEY[0]) {
          client.setQueryData(ME_KEY, null);
        }
      },
    }),
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return client;
}

export function Providers({
  i18n,
  children,
  queryClient,
}: {
  i18n: I18n;
  children: ReactNode;
  queryClient?: QueryClient;
}) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  return (
    <I18nextProvider i18n={i18n}>
      <DirectionProvider initialDirection={directionOf(i18n.language)} detectDirection={false}>
        <DirectionSync i18n={i18n} />
        <MantineProvider theme={theme}>
          <Notifications />
          <QueryClientProvider client={client}>
            <AuthProvider>{children}</AuthProvider>
          </QueryClientProvider>
        </MantineProvider>
      </DirectionProvider>
    </I18nextProvider>
  );
}
