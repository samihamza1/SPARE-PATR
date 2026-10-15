import { newId } from '@autoparts/shared';
import type { MeResponse } from '@autoparts/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server';
import type { Shop } from './harness';
import { Client, errorCode, loggedIn, provisionShop, setupEnv } from './harness';

/**
 * API-level counterpart of the RLS catalog guard: every route declares its access, every
 * non-public route rejects anonymous callers, and every permission-gated route rejects a
 * signed-in user without that permission.
 */
const env = setupEnv();
interface CollectedRoute {
  methods: string[];
  url: string;
  access: unknown;
}
const routes: CollectedRoute[] = [];
env.app.addHook('onRoute', (route) => {
  if (route.method === 'HEAD' || route.url === '*') return;
  routes.push({ methods: [route.method].flat(), url: route.url, access: route.config?.access });
});

let shop: Shop;
let cashier: Client;

const concrete = (url: string) => url.replace(/:[a-zA-Z]+/g, newId());

beforeAll(async () => {
  await env.app.ready();
  shop = await provisionShop(env);
  const owner = await loggedIn(env, shop);
  const roles = (await owner.get('/roles')).json<{ id: string; code: string }[]>();
  const cashierRole = roles.find((r) => r.code === 'cashier');
  const userId = newId();
  await owner.post('/users', {
    id: userId,
    username: 'cash1',
    displayName: 'Cashier',
    password: 'cashier passphrase 1',
  });
  await owner.post(`/users/${userId}/roles`, { roleId: cashierRole?.id });
  cashier = await loggedIn(env, shop, 'cash1', 'cashier passphrase 1');
});

describe('route access guard', () => {
  it('collects the platform routes', () => {
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.every((r) => r.access !== undefined)).toBe(true);
  });

  it('refuses to start when a route has no access declaration', async () => {
    const app = buildServer({
      checkDatabase: () => Promise.resolve(),
      platform: { db: env.appDb, allowedOrigins: [], cookieSecure: true, now: () => new Date() },
    });
    await app.after();
    expect(() => app.get('/oops', () => 'unguarded')).toThrow(/must declare config.access/);
    expect(() => app.get('/fine', { config: { access: 'public' } }, () => 'ok')).not.toThrow();
    await app.close();
  });

  it('rejects anonymous callers on every non-public route', async () => {
    const anonymous = new Client(env.app);
    for (const route of routes.filter((r) => r.access !== 'public')) {
      for (const method of route.methods) {
        const res = await anonymous.request(
          method as 'GET',
          concrete(route.url),
          method === 'GET' ? undefined : {},
        );
        expect(res.statusCode, `${method} ${route.url}`).toBe(401);
      }
    }
  });

  it('rejects a cashier (no platform permissions) on every permission-gated route', async () => {
    const gated = routes.filter((r) => r.access !== 'public' && r.access !== 'authenticated');
    expect(gated.length).toBeGreaterThan(10);
    for (const route of gated) {
      for (const method of route.methods) {
        const res = await cashier.request(
          method as 'GET',
          concrete(route.url),
          method === 'GET' ? undefined : {},
        );
        expect(res.statusCode, `${method} ${route.url}`).toBe(403);
        expect(errorCode(res)).toBe('auth.forbidden');
      }
    }
  });

  it('lets the cashier use routes open to any signed-in user', async () => {
    expect((await cashier.get('/auth/me')).json<MeResponse>().permissions).toEqual([]);
    expect((await cashier.get('/currencies')).statusCode).toBe(200);
  });
});
