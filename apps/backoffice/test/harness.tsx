import type { MeResponse, Permission, Role, User } from '@autoparts/shared';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { App } from '../src/App';
import { LANGUAGE_KEY } from '../src/auth';
import { setupI18n } from '../src/i18n';
import { Providers, createQueryClient } from '../src/Providers';

type Handler = (body: unknown) => { status: number; body?: unknown };

/** A tiny fake of the API: "METHOD /path" -> handler. Unmatched requests fail the test. */
export class FakeApi {
  readonly calls: { method: string; path: string; query: string; body: unknown }[] = [];
  private readonly routes = new Map<string, Handler>();

  on(route: string, handler: Handler | { status: number; body?: unknown }): this {
    this.routes.set(route, typeof handler === 'function' ? handler : () => handler);
    return this;
  }

  install(): void {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET';
      const [path = '', query = ''] = url.replace(/^\/api/, '').split('?');
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      this.calls.push({ method, path, query, body });
      const handler = this.routes.get(`${method} ${path}`);
      if (handler === undefined) {
        return Promise.reject(new Error(`Unexpected request ${method} ${path}`));
      }
      const res = handler(body);
      return Promise.resolve(
        new Response(res.status === 204 ? null : JSON.stringify(res.body ?? {}), {
          status: res.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
  }
}

export function me(
  permissions: Permission[],
  overrides: Partial<MeResponse['user']> = {},
): MeResponse {
  return {
    user: {
      id: '01900000-0000-7000-8000-000000000001',
      username: 'owner',
      displayName: 'سامي',
      locale: null,
      ...overrides,
    },
    tenant: {
      id: '01900000-0000-7000-8000-0000000000aa',
      slug: 'sky-motors',
      name: 'Sky Motors',
      defaultLocale: 'ar',
      functionalCurrency: 'AAA',
    },
    permissions,
  };
}

export const ALL: Permission[] = [
  'audit.read',
  'catalog.import',
  'catalog.manage',
  'cost.view',
  'devices.manage',
  'prices.manage',
  'roles.manage',
  'sessions.manage',
  'settings.manage',
  'users.manage',
];

export const ROLES: Role[] = [
  {
    id: '01900000-0000-7000-8000-0000000000r1',
    code: 'owner',
    name: 'Owner',
    isSystem: true,
    permissions: ALL,
  },
  {
    id: '01900000-0000-7000-8000-0000000000r2',
    code: 'cashier',
    name: 'Cashier',
    isSystem: true,
    permissions: [],
  },
];

export const USERS: User[] = [
  {
    id: '01900000-0000-7000-8000-000000000001',
    username: 'owner',
    displayName: 'سامي',
    email: null,
    locale: null,
    archivedAt: null,
    lastLoginAt: null,
    roleIds: [ROLES[0]?.id ?? ''],
  },
];

export async function renderApp(route: string, lng?: string) {
  localStorage.clear();
  // An explicit language means this browser chose it; otherwise the tenant default applies.
  if (lng !== undefined) localStorage.setItem(LANGUAGE_KEY, lng);
  const i18n = await setupI18n(lng);
  const utils = render(
    <Providers i18n={i18n} queryClient={createQueryClient()} env="test">
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </Providers>,
  );
  return { ...utils, i18n };
}
