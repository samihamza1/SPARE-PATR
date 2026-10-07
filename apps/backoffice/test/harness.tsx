import { PERMISSIONS } from '@autoparts/shared';
import type {
  Currency,
  Location,
  MeResponse,
  PartDetail,
  PartSummary,
  Permission,
  Role,
  User,
} from '@autoparts/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { App } from '../src/App';
import { LANGUAGE_KEY } from '../src/auth';
import { setupI18n } from '../src/i18n';
import ar from '../src/locales/ar.json';
import { Providers, createQueryClient } from '../src/Providers';

type Handler = (body: unknown, query: URLSearchParams) => { status: number; body?: unknown };

/** A tiny fake of the API: "METHOD /path" -> handler. Unmatched requests fail the test. */
export class FakeApi {
  readonly calls: { method: string; path: string; query: string; body: unknown }[] = [];
  private readonly routes = new Map<string, Handler>();
  private readonly unreachable = new Set<string>();

  on(route: string, handler: Handler | { status: number; body?: unknown }): this {
    this.unreachable.delete(route);
    this.routes.set(route, typeof handler === 'function' ? handler : () => handler);
    return this;
  }

  /** The request never reaches the server (fetch rejects, as when the network is down). */
  offline(route: string): this {
    this.unreachable.add(route);
    return this;
  }

  install(): void {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET';
      const [path = '', query = ''] = url.replace(/^\/api/, '').split('?');
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      this.calls.push({ method, path, query, body });
      if (this.unreachable.has(`${method} ${path}`)) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      const handler = this.routes.get(`${method} ${path}`);
      if (handler === undefined) {
        return Promise.reject(new Error(`Unexpected request ${method} ${path}`));
      }
      const res = handler(body, new URLSearchParams(query));
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

/** Every permission, as an owner holds them. */
export const ALL: Permission[] = [...PERMISSIONS];

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

export const SETTINGS = {
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
};

export const CURRENCIES: Currency[] = [
  {
    id: '01900000-0000-7000-8000-0000000000c1',
    code: 'AAA',
    minorUnits: 2,
    cashIncrement: null,
    isActive: true,
    sortOrder: 0,
    isFunctional: true,
  },
];

export async function renderApp(route: string, lng?: string) {
  localStorage.clear();
  // An explicit language means this browser chose it; otherwise the tenant default applies.
  if (lng !== undefined) localStorage.setItem(LANGUAGE_KEY, lng);
  const i18n = await setupI18n(lng);
  const queryClient = createQueryClient();
  const utils = render(
    <Providers i18n={i18n} queryClient={queryClient} env="test">
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </Providers>,
  );
  return { ...utils, i18n, queryClient };
}

export const unauthenticated = { status: 401, body: { error: { code: 'auth.unauthenticated' } } };
export const notFound = { status: 404, body: { error: { code: 'resource.not_found' } } };
export const ok = (body: unknown) => ({ status: 200, body });

/** Deterministic UUIDs for fixtures. */
export const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const part = (
  n: number,
  sku: string,
  grade: PartSummary['qualityGrade'],
  nameAr: string,
  overrides: Partial<PartSummary> = {},
): PartSummary => ({
  id: id(n),
  sku,
  nameAr,
  nameEn: null,
  qualityGrade: grade,
  brandId: null,
  categoryId: null,
  unit: 'piece',
  archivedAt: null,
  ...overrides,
});

export const partDetail = (
  summary: PartSummary,
  overrides: Partial<PartDetail> = {},
): PartDetail => ({
  ...summary,
  notes: null,
  numbers: [],
  fitments: [],
  interchange: [],
  supersededBy: null,
  supersedes: [],
  prices: [],
  ...overrides,
});

/** The default shop (ADR 0018): every tenant has one. */
export const LOCATIONS: Location[] = [
  {
    id: '01900000-0000-7000-8000-0000000000f1',
    name: 'المحل',
    kind: 'shop',
    isDefault: true,
    sortOrder: 0,
    archivedAt: null,
  },
];

/** The part and the lookups its page loads (stock card included). */
export function onPartPage(api: FakeApi, detail: PartDetail): FakeApi {
  return api
    .on(`GET /catalog/parts/${detail.id}`, ok(detail))
    .on(`GET /stock/parts/${detail.id}`, ok({ partId: detail.id, total: 0, locations: [] }))
    .on('GET /stock/moves', ok([]))
    .on('GET /locations', ok(LOCATIONS))
    .on(`GET /catalog/parts/${detail.id}/prices`, ok([]))
    .on('GET /catalog/brands', ok([]))
    .on('GET /catalog/categories', ok([]))
    .on('GET /catalog/price-lists', ok([]));
}

/** A field's label as a regex: required fields add " *" to the label. */
export const labelled = (label: string) =>
  new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\*?$`);

/** Opens a Mantine Select by its label and picks an option, as a user would. */
export async function pick(label: string, option: string, scope: HTMLElement = document.body) {
  const user = userEvent.setup();
  await user.click(within(scope).getByLabelText(labelled(label), { selector: 'input' }));
  await user.click(await screen.findByRole('option', { name: option }));
}

/** Fills the sign-in form and submits it. */
export function signIn(username: string) {
  fireEvent.change(screen.getByLabelText(ar.auth.shopCode, { exact: false }), {
    target: { value: 'sky-motors' },
  });
  fireEvent.change(screen.getByLabelText(ar.auth.username, { exact: false }), {
    target: { value: username },
  });
  fireEvent.change(screen.getByLabelText(ar.auth.password, { exact: false }), {
    target: { value: 'a long passphrase' },
  });
  fireEvent.click(screen.getByRole('button', { name: ar.auth.submit }));
}
