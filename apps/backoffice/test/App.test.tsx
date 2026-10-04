import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { setupI18n } from '../src/i18n';
import ar from '../src/locales/ar.json';
import en from '../src/locales/en.json';

afterEach(cleanup);

async function renderApp(lng?: string) {
  const i18n = await setupI18n(lng);
  render(
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>,
  );
  return i18n;
}

describe('Back office shell', () => {
  it('starts in Arabic, right-to-left', async () => {
    await renderApp();
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('heading').textContent).toBe(ar.app.title);
  });

  it('switches to English, left-to-right, and back', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('heading', { name: en.app.title });
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');

    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('heading', { name: ar.app.title });
    expect(document.documentElement.dir).toBe('rtl');
  });
});
