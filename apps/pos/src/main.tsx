import '@mantine/core/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setupI18n } from './i18n';
import { Providers } from './Providers';

const root = document.getElementById('root');
if (root === null) throw new Error('#root element missing from index.html');

const i18n = await setupI18n();
document.title = i18n.t('app.title');

createRoot(root).render(
  <StrictMode>
    <Providers i18n={i18n}>
      <App />
    </Providers>
  </StrictMode>,
);
