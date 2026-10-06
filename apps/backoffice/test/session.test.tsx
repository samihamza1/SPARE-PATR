import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ar from '../src/locales/ar.json';
import {
  ALL,
  FakeApi,
  id,
  me,
  notFound,
  ok,
  onPartPage,
  part,
  partDetail,
  renderApp,
  signIn,
  unauthenticated,
} from './harness';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const welcome = (name: string) => ar.home.welcome.replace('{{name}}', name);

/** Queries still holding data, apart from `me`. */
const cachedData = (queryClient: { getQueryCache: () => { getAll: () => unknown[] } }) =>
  (
    queryClient.getQueryCache().getAll() as {
      queryKey: readonly unknown[];
      state: { data: unknown };
    }[]
  ).filter((q) => q.queryKey[0] !== 'me' && q.state.data !== undefined);

describe('signing out', () => {
  it('keeps the user signed in and says so when the server cannot be reached', async () => {
    const api = new FakeApi().on('GET /auth/me', ok(me(ALL))).offline('POST /auth/logout');
    api.install();
    await renderApp('/');
    await screen.findByRole('heading', { name: welcome('سامي') });
    fireEvent.click(screen.getByRole('button', { name: ar.auth.logout }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(ar.auth.logoutFailed);
    expect(alert.textContent).toContain(ar.errors.network);
    expect(screen.getByRole('heading', { name: welcome('سامي') })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: ar.auth.title })).toBeNull();

    // Trying again once the server answers signs out for real.
    api.on('POST /auth/logout', { status: 204 });
    fireEvent.click(screen.getByRole('button', { name: ar.auth.logout }));
    await screen.findByRole('heading', { name: ar.auth.title });
  });

  it('keeps the user signed in when the server fails to end the session', async () => {
    new FakeApi()
      .on('GET /auth/me', ok(me(ALL)))
      .on('POST /auth/logout', { status: 503, body: { error: { code: 'server.error' } } })
      .install();
    await renderApp('/');
    await screen.findByRole('heading', { name: welcome('سامي') });
    fireEvent.click(screen.getByRole('button', { name: ar.auth.logout }));
    expect((await screen.findByRole('alert')).textContent).toContain(ar.auth.logoutFailed);
    expect(screen.getByRole('heading', { name: welcome('سامي') })).toBeTruthy();
  });

  it('treats a session that already ended as signed out', async () => {
    new FakeApi()
      .on('GET /auth/me', ok(me(ALL)))
      .on('POST /auth/logout', unauthenticated)
      .install();
    await renderApp('/');
    await screen.findByRole('heading', { name: welcome('سامي') });
    fireEvent.click(screen.getByRole('button', { name: ar.auth.logout }));
    await screen.findByRole('heading', { name: ar.auth.title });
  });

  it('forgets everything cached for the user', async () => {
    const detail = partDetail(part(1, 'A-SECRET', 'oem', 'قطعة المحل أ'));
    const api = onPartPage(new FakeApi(), detail)
      .on('GET /auth/me', ok(me(ALL)))
      .on('POST /auth/logout', { status: 204 });
    api.install();
    const { queryClient } = await renderApp(`/catalog/parts/${detail.id}`);
    await screen.findByRole('heading', { name: 'A-SECRET' });
    fireEvent.click(screen.getByRole('button', { name: ar.auth.logout }));
    await screen.findByRole('heading', { name: ar.auth.title });
    expect(cachedData(queryClient)).toEqual([]);
  });
});

describe('a session that ends mid-use', () => {
  it('drops the cached data before the sign-in page, so the next user never sees it', async () => {
    const detail = partDetail(part(1, 'A-SECRET', 'oem', 'قطعة المحل أ'));
    let who: 'A' | 'ended' | 'B' = 'A';
    const api = onPartPage(new FakeApi(), detail)
      .on('GET /auth/me', () => (who === 'A' ? ok(me(ALL)) : unauthenticated))
      .on('GET /catalog/parts', () => (who === 'A' ? ok([]) : unauthenticated))
      .on('POST /auth/login', () => {
        who = 'B';
        return ok(me([], { id: id(2), displayName: 'موظف المحل ب' }));
      });
    api.install();
    const { queryClient } = await renderApp(`/catalog/parts/${detail.id}`);
    await screen.findByRole('heading', { name: 'A-SECRET' });

    // A query fails with 401: the session is over.
    who = 'ended';
    fireEvent.click(screen.getByRole('link', { name: ar.catalog.back }));
    await screen.findByRole('heading', { name: ar.auth.title });
    expect(cachedData(queryClient)).toEqual([]);

    // Another shop's user signs in on the same browser and returns to the same part.
    api.on(`GET /catalog/parts/${detail.id}`, () => (who === 'B' ? notFound : ok(detail)));
    api.on('GET /catalog/parts', ok([]));
    signIn('b-user');
    await screen.findByRole('heading', { name: ar.catalog.partsTitle });
    expect(screen.queryByText('A-SECRET')).toBeNull();
  });

  it('signs out when a save fails with 401, and the next user sees only their own data', async () => {
    const number = {
      id: id(11),
      number: '04465-60320',
      numberNorm: '0446560320',
      kind: 'oem' as const,
      brandId: null,
    };
    const detail = partDetail(part(1, 'A-SECRET', 'oem', 'قطعة المحل أ'), { numbers: [number] });
    let who: 'A' | 'ended' | 'B' = 'A';
    const api = onPartPage(new FakeApi(), detail)
      .on('GET /auth/me', () => (who === 'A' ? ok(me(ALL)) : unauthenticated))
      .on(`POST /catalog/parts/${detail.id}/numbers/${number.id}/remove`, unauthenticated)
      .on('POST /auth/login', () => {
        who = 'B';
        return ok(me([], { id: id(2), displayName: 'موظف المحل ب' }));
      });
    api.install();
    const { queryClient } = await renderApp(`/catalog/parts/${detail.id}`);
    await screen.findByRole('heading', { name: 'A-SECRET' });

    who = 'ended';
    api.on(`GET /catalog/parts/${detail.id}`, () => (who === 'B' ? notFound : unauthenticated));
    fireEvent.click(screen.getByRole('button', { name: ar.catalog.remove }));
    await screen.findByRole('heading', { name: ar.auth.title });
    expect(cachedData(queryClient)).toEqual([]);

    // Back on the same page as shop B: the part is not theirs, and A's copy is gone.
    signIn('b-user');
    expect((await screen.findByRole('alert')).textContent).toContain(ar.errors.resource.not_found);
    expect(screen.queryByText('A-SECRET')).toBeNull();
    await waitFor(() => {
      expect(api.calls.filter((c) => c.path === `/catalog/parts/${detail.id}`)).toHaveLength(2);
    });
  });
});
