import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { loadDevice } from '../src/device';
import { setupI18n } from '../src/i18n';
import ar from '../src/locales/ar.json';
import en from '../src/locales/en.json';
import { Providers } from '../src/Providers';

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderApp(lng?: string) {
  const i18n = await setupI18n(lng);
  render(
    <Providers i18n={i18n}>
      <App />
    </Providers>,
  );
  return i18n;
}

function stubEnroll(status: number, body: unknown) {
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const fill = (shop: string, code: string) => {
  fireEvent.change(screen.getByLabelText(ar.enroll.shopCode, { exact: false }), {
    target: { value: shop },
  });
  fireEvent.change(screen.getByLabelText(ar.enroll.code, { exact: false }), {
    target: { value: code },
  });
  fireEvent.click(screen.getByRole('button', { name: ar.enroll.submit }));
};

describe('POS device enrollment', () => {
  it('starts in Arabic, right-to-left, on the enrollment screen', async () => {
    await renderApp();
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('heading', { name: ar.enroll.title })).toBeTruthy();
  });

  it('enrolls with the shop code and one-time code, and remembers the device', async () => {
    const fetch = stubEnroll(200, {
      deviceId: '01900000-0000-7000-8000-00000000d001',
      credential: 'c'.repeat(43),
    });
    await renderApp();
    fill(' Sky-Motors ', 'abcde-12345');
    await screen.findByText(ar.enroll.done);
    const [, init] = fetch.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      tenant: 'sky-motors',
      code: 'abcde-12345',
    });
    expect(loadDevice()).toEqual({
      tenant: 'sky-motors',
      deviceId: '01900000-0000-7000-8000-00000000d001',
      credential: 'c'.repeat(43),
    });
  });

  it('shows a translated error for a wrong or expired code', async () => {
    stubEnroll(400, { error: { code: 'device.invalid_code' } });
    await renderApp();
    fill('sky-motors', 'WRONG');
    expect((await screen.findByRole('alert')).textContent).toBe(ar.errors.device.invalid_code);
    expect(loadDevice()).toBeNull();
  });

  it('switches to English, left-to-right', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: ar.language.switch }));
    await screen.findByRole('heading', { name: en.enroll.title });
    await waitFor(() => {
      expect(document.documentElement.dir).toBe('ltr');
    });
  });
});
