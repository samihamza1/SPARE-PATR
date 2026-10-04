import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../src/App';
import { createI18n } from '../src/i18n';
import ar from '../src/locales/ar.json';
import en from '../src/locales/en.json';

afterEach(cleanup);

const keys = (obj: object, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

describe('i18n', () => {
  it('ar and en define exactly the same keys', () => {
    expect(keys(ar).sort()).toEqual(keys(en).sort());
  });

  it('renders right-to-left in Arabic by default and switches to left-to-right', async () => {
    const i18n = await createI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>,
    );
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(screen.getByRole('heading').textContent).toBe(ar.app.title);

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
      await Promise.resolve();
    });
    expect(document.documentElement.dir).toBe('ltr');
    expect(screen.getByRole('heading').textContent).toBe(en.app.title);
  });
});
