import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { LANGUAGE_KEY } from './auth';
import { setupI18n } from './i18n';
import { Providers } from './Providers';

const root = document.getElementById('root');
if (root === null) throw new Error('#root element missing from index.html');

const i18n = await setupI18n(localStorage.getItem(LANGUAGE_KEY) ?? undefined);
document.title = i18n.t('app.title');
i18n.on('languageChanged', () => {
  document.title = i18n.t('app.title');
});

createRoot(root).render(
  <StrictMode>
    <Providers i18n={i18n}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Providers>
  </StrictMode>,
);
