import { withTenant } from '@autoparts/db';
import type { MeResponse } from '@autoparts/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Shop } from './harness';
import {
  Client,
  HOUR,
  MINUTE,
  OWNER_PASSWORD,
  errorCode,
  loggedIn,
  provisionShop,
  setupEnv,
} from './harness';

const env = setupEnv();
let shop: Shop;
let other: Shop;

beforeAll(async () => {
  shop = await provisionShop(env);
  other = await provisionShop(env);
});

const auditActions = (tenantId: string) =>
  withTenant(env.ownerDb, tenantId, (trx) =>
    trx.selectFrom('audit_log').select('action').orderBy('id').execute(),
  ).then((rows) => rows.map((r) => r.action));

describe('login', () => {
  it('signs in with shop code, username and password and sets a hardened cookie', async () => {
    const client = new Client(env.app);
    const res = await client.login(shop.slug.toUpperCase(), 'OWNER', OWNER_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: { id: shop.ownerUserId, username: 'owner' },
      tenant: { id: shop.tenantId, slug: shop.slug, functionalCurrency: 'AAA' },
    });
    expect(res.json<MeResponse>().permissions).toContain('users.manage');
    const cookie = res.cookies.find((c) => c.name === 'sid');
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect((await client.get('/auth/me')).statusCode).toBe(200);
  });

  it('gives the same answer for unknown shop, unknown user and wrong password', async () => {
    const answers = await Promise.all([
      new Client(env.app).login('no-such-shop', 'owner', OWNER_PASSWORD),
      new Client(env.app).login(shop.slug, 'nobody', OWNER_PASSWORD),
      new Client(env.app).login(shop.slug, 'owner', 'wrong password 1'),
    ]);
    for (const res of answers) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'auth.invalid_credentials' } });
      expect(res.cookies).toEqual([]);
    }
  });

  it('records successful and failed logins in the audit log', async () => {
    const actions = await auditActions(shop.tenantId);
    expect(actions).toContain('auth.login');
    expect(actions).toContain('auth.login_failed');
  });

  it('rejects malformed input with request.invalid', async () => {
    const res = await new Client(env.app).post('/auth/login', { tenant: 'x' });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('request.invalid');
  });
});

describe('lockout', () => {
  it('locks after 5 failures for 15 minutes, then recovers', async () => {
    const s = await provisionShop(env);
    for (let i = 0; i < 5; i++) {
      expect(
        (await new Client(env.app).login(s.slug, 'owner', `wrong ${String(i)} password`))
          .statusCode,
      ).toBe(401);
    }
    const locked = await new Client(env.app).login(s.slug, 'owner', OWNER_PASSWORD);
    expect(locked.statusCode).toBe(423);
    expect(errorCode(locked)).toBe('auth.locked');
    // A wrong password while locked does not reveal the lock.
    expect(errorCode(await new Client(env.app).login(s.slug, 'owner', 'still wrong 1'))).toBe(
      'auth.invalid_credentials',
    );
    expect(await auditActions(s.tenantId)).toContain('auth.lockout');

    env.clock.advance(15 * MINUTE);
    expect((await new Client(env.app).login(s.slug, 'owner', OWNER_PASSWORD)).statusCode).toBe(200);
  });
});

describe('session lifecycle', () => {
  it('expires after 30 idle minutes', async () => {
    const client = await loggedIn(env, shop);
    env.clock.advance(29 * MINUTE);
    expect((await client.get('/auth/me')).statusCode).toBe(200);
    env.clock.advance(29 * MINUTE);
    expect((await client.get('/auth/me')).statusCode).toBe(200);
    env.clock.advance(30 * MINUTE);
    const res = await client.get('/auth/me');
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('auth.unauthenticated');
  });

  it('expires after 12 hours even when active', async () => {
    const client = await loggedIn(env, shop);
    for (let elapsed = 0; elapsed < 12 * HOUR - 20 * MINUTE; elapsed += 20 * MINUTE) {
      env.clock.advance(20 * MINUTE);
      expect((await client.get('/auth/me')).statusCode).toBe(200);
    }
    env.clock.advance(20 * MINUTE);
    expect((await client.get('/auth/me')).statusCode).toBe(401);
  });

  it('logout revokes the session server-side', async () => {
    const client = await loggedIn(env, shop);
    const token = client.cookie;
    expect((await client.post('/auth/logout')).statusCode).toBe(204);
    expect(client.cookie).toBeUndefined();
    client.cookie = token;
    expect((await client.get('/auth/me')).statusCode).toBe(401);
  });

  it('rejects tampered tokens, including another tenant id', async () => {
    const client = await loggedIn(env, shop);
    const [tenantId = '', sessionId = '', secret = ''] = (client.cookie ?? '').split('.');
    const forged = new Client(env.app);
    for (const token of [
      `${other.tenantId}.${sessionId}.${secret}`,
      `${tenantId}.${sessionId}.${'A'.repeat(43)}`,
      `${tenantId}.${sessionId}`,
      'garbage',
    ]) {
      forged.cookie = token;
      expect((await forged.get('/auth/me')).statusCode, token).toBe(401);
    }
  });

  it('changing the password keeps this session and ends the others', async () => {
    const s = await provisionShop(env);
    const a = await loggedIn(env, s);
    const b = await loggedIn(env, s);
    const res = await a.post('/me/password', {
      currentPassword: OWNER_PASSWORD,
      newPassword: 'a brand new passphrase',
    });
    expect(res.statusCode).toBe(204);
    expect((await a.get('/auth/me')).statusCode).toBe(200);
    expect((await b.get('/auth/me')).statusCode).toBe(401);
    expect(
      errorCode(
        await a.post('/me/password', {
          currentPassword: 'nope',
          newPassword: 'another passphrase',
        }),
      ),
    ).toBe('auth.wrong_password');
  });
});

describe('CSRF origin check', () => {
  it('refuses state-changing requests with the cookie but without an allowed Origin', async () => {
    const client = await loggedIn(env, shop);
    for (const origin of [null, 'https://evil.example']) {
      const res = await env.app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie: `sid=${client.cookie ?? ''}`, ...(origin !== null && { origin }) },
      });
      expect(res.statusCode).toBe(403);
      expect(errorCode(res)).toBe('auth.bad_origin');
    }
    expect((await client.get('/auth/me')).statusCode).toBe(200);
  });
});

describe('rate limiting', () => {
  it('slows repeated login attempts for one account from one address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (await new Client(env.app).login(other.slug, 'ratelimited', `x${String(i)} password`))
          .statusCode,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
