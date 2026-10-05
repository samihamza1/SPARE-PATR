import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ar from '../src/locales/ar.json';
import en from '../src/locales/en.json';
import { ALL, FakeApi, ROLES, USERS, me, renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const unauthenticated = { status: 401, body: { error: { code: 'auth.unauthenticated' } } };

describe('login', () => {
  it('starts in Arabic, right-to-left, with Arabic labels', async () => {
    new FakeApi().on('GET /auth/me', unauthenticated).install();
    await renderApp('/');
    await screen.findByRole('heading', { name: ar.auth.title });
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(screen.getByLabelText(ar.auth.shopCode, { exact: false })).toBeTruthy();
  });

  it('shows the translated error for bad credentials and clears the password', async () => {
    new FakeApi()
      .on('GET /auth/me', unauthenticated)
      .on('POST /auth/login', {
        status: 401,
        body: { error: { code: 'auth.invalid_credentials' } },
      })
      .install();
    await renderApp('/');
    fireEvent.change(await screen.findByLabelText(ar.auth.shopCode, { exact: false }), {
      target: { value: 'sky-motors' },
    });
    fireEvent.change(screen.getByLabelText(ar.auth.username, { exact: false }), {
      target: { value: 'owner' },
    });
    const password = screen.getByLabelText(ar.auth.password, { exact: false });
    fireEvent.change(password, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: ar.auth.submit }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      ar.errors.auth.invalid_credentials,
    );
    expect((password as HTMLInputElement).value).toBe('');
  });

  it('signs in, remembers the shop code and lands on the home page', async () => {
    const api = new FakeApi()
      .on('GET /auth/me', unauthenticated)
      .on('POST /auth/login', { status: 200, body: me(ALL) });
    api.install();
    await renderApp('/users');
    fireEvent.change(await screen.findByLabelText(ar.auth.shopCode, { exact: false }), {
      target: { value: ' sky-motors ' },
    });
    fireEvent.change(screen.getByLabelText(ar.auth.username, { exact: false }), {
      target: { value: 'owner' },
    });
    fireEvent.change(screen.getByLabelText(ar.auth.password, { exact: false }), {
      target: { value: 'secret passphrase' },
    });
    api
      .on('GET /users', { status: 200, body: USERS })
      .on('GET /roles', { status: 200, body: ROLES });
    fireEvent.click(screen.getByRole('button', { name: ar.auth.submit }));
    // Returns to the page that required the login.
    await screen.findByRole('heading', { name: ar.users.title });
    expect(api.calls.find((c) => c.path === '/auth/login')?.body).toEqual({
      tenant: 'sky-motors',
      username: 'owner',
      password: 'secret passphrase',
    });
    expect(localStorage.getItem('autoparts.shopCode')).toBe('sky-motors');
  });
});

describe('shell and permissions', () => {
  it('shows only the pages a cashier may open', async () => {
    new FakeApi().on('GET /auth/me', { status: 200, body: me([]) }).install();
    await renderApp('/');
    const nav = await screen.findByRole('navigation', { name: ar.nav.menu });
    const links = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(links).toEqual([
      ar.nav.home,
      ar.nav.search,
      ar.nav.parts,
      ar.nav.vehicles,
      ar.nav.catalogSetup,
      ar.nav.roles,
    ]);
  });

  it('shows every page to the owner', async () => {
    new FakeApi().on('GET /auth/me', { status: 200, body: me(ALL) }).install();
    await renderApp('/');
    const nav = await screen.findByRole('navigation', { name: ar.nav.menu });
    expect(within(nav).getAllByRole('link')).toHaveLength(11);
  });

  it('signs out to the login page, and the next user starts at home', async () => {
    const api = new FakeApi()
      .on('GET /auth/me', { status: 200, body: me(ALL) })
      .on('GET /audit-log', { status: 200, body: [] })
      .on('GET /users', { status: 200, body: USERS })
      .on('POST /auth/logout', { status: 204 })
      .on('POST /auth/login', { status: 200, body: me([], { displayName: 'كاشير' }) });
    api.install();
    await renderApp('/audit');
    fireEvent.click(await screen.findByRole('button', { name: ar.auth.logout }));
    await screen.findByRole('heading', { name: ar.auth.title });
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/auth/logout')).toBe(true);
    fireEvent.change(screen.getByLabelText(ar.auth.shopCode, { exact: false }), {
      target: { value: 'sky-motors' },
    });
    fireEvent.change(screen.getByLabelText(ar.auth.username, { exact: false }), {
      target: { value: 'cash1' },
    });
    fireEvent.change(screen.getByLabelText(ar.auth.password, { exact: false }), {
      target: { value: 'cashier passphrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: ar.auth.submit }));
    await screen.findByRole('heading', { name: 'أهلاً كاشير' });
  });

  it('explains a missing permission when a page is opened directly', async () => {
    new FakeApi().on('GET /auth/me', { status: 200, body: me([]) }).install();
    await renderApp('/settings');
    expect((await screen.findByRole('alert')).textContent).toContain(ar.errors.auth.forbidden);
  });

  it('goes back to the login page when the session ends mid-use', async () => {
    new FakeApi()
      .on('GET /auth/me', { status: 200, body: me(ALL) })
      .on('GET /users', unauthenticated)
      .on('GET /roles', unauthenticated)
      .install();
    await renderApp('/users');
    await screen.findByRole('heading', { name: ar.auth.title });
  });

  it("uses the user's language preference when this browser has not chosen one", async () => {
    new FakeApi().on('GET /auth/me', { status: 200, body: me(ALL, { locale: 'en' }) }).install();
    await renderApp('/');
    await screen.findByRole('heading', { name: 'Welcome, سامي' });
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('switches to English, left-to-right, and back', async () => {
    new FakeApi().on('GET /auth/me', { status: 200, body: me(ALL) }).install();
    await renderApp('/');
    await screen.findByRole('heading', { name: 'أهلاً سامي' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ar.language.switch }));
      await Promise.resolve();
    });
    await screen.findByRole('heading', { name: 'Welcome, سامي' });
    expect(document.documentElement.dir).toBe('ltr');
    expect(screen.getByRole('button', { name: en.auth.logout })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.language.switch }));
    await waitFor(() => {
      expect(document.documentElement.dir).toBe('rtl');
    });
  });
});

describe('users page', () => {
  it('lists users with translated system role names and creates a user', async () => {
    const api = new FakeApi()
      .on('GET /auth/me', { status: 200, body: me(ALL) })
      .on('GET /users', { status: 200, body: USERS })
      .on('GET /roles', { status: 200, body: ROLES })
      .on('POST /users', (body) => ({ status: 201, body }));
    api.install();
    await renderApp('/users');
    await screen.findByText(ar.roles.system.owner);
    fireEvent.click(screen.getByRole('button', { name: ar.users.create }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(ar.fields.username, { exact: false }), {
      target: { value: 'cash1' },
    });
    fireEvent.change(within(dialog).getByLabelText(ar.fields.displayName, { exact: false }), {
      target: { value: 'كاشير' },
    });
    fireEvent.change(within(dialog).getByLabelText(ar.fields.password, { exact: false }), {
      target: { value: 'cashier passphrase' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: ar.common.save }));
    await waitFor(() => {
      expect(api.calls.some((c) => c.method === 'POST' && c.path === '/users')).toBe(true);
    });
    expect(api.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      username: 'cash1',
      displayName: 'كاشير',
      password: 'cashier passphrase',
    });
  });

  it('shows field-level validation messages from the API in Arabic', async () => {
    new FakeApi()
      .on('GET /auth/me', { status: 200, body: me(ALL) })
      .on('GET /users', { status: 200, body: USERS })
      .on('GET /roles', { status: 200, body: ROLES })
      .on('POST /users', {
        status: 400,
        body: {
          error: {
            code: 'request.invalid',
            issues: [{ path: 'password', message: 'password.too_short' }],
          },
        },
      })
      .install();
    await renderApp('/users');
    fireEvent.click(await screen.findByRole('button', { name: ar.users.create }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(ar.fields.username, { exact: false }), {
      target: { value: 'x' },
    });
    fireEvent.change(within(dialog).getByLabelText(ar.fields.displayName, { exact: false }), {
      target: { value: 'x' },
    });
    fireEvent.change(within(dialog).getByLabelText(ar.fields.password, { exact: false }), {
      target: { value: 'x' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: ar.common.save }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain(ar.validation.password.too_short);
  });
});

describe('every page renders in both languages', () => {
  const pages = ['/', '/users', '/roles', '/settings', '/devices', '/audit'];
  for (const lng of ['ar', 'en'] as const) {
    it.each(pages)(`${lng} %s`, async (route) => {
      new FakeApi()
        .on('GET /auth/me', { status: 200, body: me(ALL) })
        .on('GET /users', { status: 200, body: USERS })
        .on('GET /roles', { status: 200, body: ROLES })
        .on('GET /settings', {
          status: 200,
          body: {
            name: 'Sky Motors',
            defaultLocale: 'ar',
            timezone: 'UTC',
            functionalCurrency: 'AAA',
            settings: {
              session: { idleMinutes: 30, absoluteHours: 12 },
              security: { maxFailedLogins: 5, lockoutMinutes: 15 },
              money: { roundingMode: 'HALF_EVEN' },
              inventory: { allowNegativeStock: false },
            },
          },
        })
        .on('GET /currencies', {
          status: 200,
          body: [
            {
              id: '01900000-0000-7000-8000-0000000000c1',
              code: 'AAA',
              minorUnits: 2,
              cashIncrement: null,
              isActive: true,
              sortOrder: 0,
              isFunctional: true,
            },
          ],
        })
        .on('GET /devices', { status: 200, body: [] })
        .on('GET /audit-log', { status: 200, body: [] })
        .install();
      const { container } = await renderApp(route, lng);
      await screen.findByRole('navigation');
      expect(document.documentElement.dir).toBe(lng === 'ar' ? 'rtl' : 'ltr');
      await waitFor(() => {
        expect(screen.queryByRole('alert')).toBeNull();
      });
      // No raw i18n keys leaked into the page.
      expect(container.ownerDocument.body.textContent).not.toMatch(
        /\b(nav|auth|users|roles|settings|devices|audit|common|errors)\.[a-z_]+/,
      );
    });
  }
});
