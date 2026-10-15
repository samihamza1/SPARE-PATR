import { DirectionProvider, MantineProvider, useDirection } from '@mantine/core';
import { directionOf } from '@autoparts/shared/i18n';
import type { i18n as I18n } from 'i18next';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { I18nextProvider } from 'react-i18next';

/** Keeps Mantine's direction in step with the language (Arabic RTL, English LTR). */
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

export function Providers({ i18n, children }: { i18n: I18n; children: ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <DirectionProvider initialDirection={directionOf(i18n.language)} detectDirection={false}>
        <DirectionSync i18n={i18n} />
        <MantineProvider>{children}</MantineProvider>
      </DirectionProvider>
    </I18nextProvider>
  );
}
