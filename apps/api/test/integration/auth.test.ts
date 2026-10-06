import { withTenant } from '@autoparts/db';
import type { MeResponse } from '@autoparts/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { fastifyTrustProxy } from '../../src/config';
import { buildServer } from '../../src/server';
import type { Shop } from './harness';
import {
  Client,
  HOUR,
  MINUTE,
  OWNER_PASSWORD,
  errorCode,
  holdLock,
  loggedIn,
  provisionShop,
  setupEnv,
  waitForLockWaiters,
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
  const attempt = (s: Shop, password: string) =>
    new Client(env.app).login(s.slug, 'owner', password);
  const failWrong = async (s: Shop, times: number) => {
    for (let i = 0; i < times; i++) {
      expect((await attempt(s, `wrong ${String(i)} password`)).statusCode).toBe(401);
    }
  };
  const lockState = (s: Shop) =>
    withTenant(env.ownerDb, s.tenantId, (trx) =>
      trx
        .selectFrom('users')
        .select(['failed_login_count', 'locked_until'])
        .where('id', '=', s.ownerUserId)
        .executeTakeFirstOrThrow(),
    );

  it('answers a locked account exactly like a wrong password, whatever the password', async () => {
    const s = await provisionShop(env);
    await failWrong(s, 5);
    // Locked: the right password must not be distinguishable from a wrong one.
    for (const password of [OWNER_PASSWORD, 'still wrong 1']) {
      const res = await attempt(s, password);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'auth.invalid_credentials' } });
      expect(res.cookies).toEqual([]);
    }
    const actions = await auditActions(s.tenantId);
    expect(actions.filter((a) => a === 'auth.lockout')).toHaveLength(1);
    const reasons = await withTenant(env.ownerDb, s.tenantId, (trx) =>
      trx
        .selectFrom('audit_log')
        .select('after')
        .where('action', '=', 'auth.login_failed')
        .orderBy('id')
        .execute(),
    );
    expect(reasons.map((r) => (r.after as { reason: string }).reason)).toEqual([
      'bad_password',
      'bad_password',
      'bad_password',
      'bad_password',
      'locked',
      'locked',
    ]);
  });

  it('counts attempts during the lock and extends it', async () => {
    const s = await provisionShop(env);
    await failWrong(s, 5);
    env.clock.advance(10 * MINUTE);
    await failWrong(s, 1);
    // 20 minutes after the lock: past the first 15, but the attempt at 10 extended it.
    env.clock.advance(10 * MINUTE);
    expect((await attempt(s, OWNER_PASSWORD)).statusCode).toBe(401);
    expect((await lockState(s)).failed_login_count).toBe(7);
    env.clock.advance(16 * MINUTE);
    expect((await attempt(s, OWNER_PASSWORD)).statusCode).toBe(200);
  });

  it('a correct password after the lock expires works and resets the counter', async () => {
    const s = await provisionShop(env);
    await failWrong(s, 5);
    env.clock.advance(16 * MINUTE);
    expect((await attempt(s, OWNER_PASSWORD)).statusCode).toBe(200);
    expect(await lockState(s)).toEqual({ failed_login_count: 0, locked_until: null });
    // Fewer than 5 new failures do not lock (10 attempts: the per-minute rate limit).
    await failWrong(s, 3);
    expect((await attempt(s, OWNER_PASSWORD)).statusCode).toBe(200);
  });

  it('locks again on the next failure after a lock expires, until a successful sign-in', async () => {
    const s = await provisionShop(env);
    await failWrong(s, 5);
    env.clock.advance(16 * MINUTE);
    await failWrong(s, 1);
    expect((await attempt(s, OWNER_PASSWORD)).statusCode).toBe(401);
    env.clock.advance(16 * MINUTE);
    expect((await attempt(s, OWNER_PASSWORD)).statusCode).toBe(200);
  });

  it('decides the lock atomically: a correct password queued behind the locking failure fails', async () => {
    const s = await provisionShop(env);
    await failWrong(s, 4);
    // Hold the user row so both attempts are past the password check and wait to record.
    const held = await holdLock(env, s.tenantId, (trx) =>
      trx.selectFrom('users').select('id').where('id', '=', s.ownerUserId).forUpdate().execute(),
    );
    const fifthFailure = attempt(s, 'wrong 4 password');
    await waitForLockWaiters(env, 1);
    const correct = attempt(s, OWNER_PASSWORD);
    await waitForLockWaiters(env, 2);
    await held.release();
    expect((await fifthFailure).statusCode).toBe(401);
    expect((await correct).statusCode).toBe(401);
    expect((await lockState(s)).failed_login_count).toBe(6);
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

  it('applies a shorter absolute limit to existing sessions', async () => {
    const s = await provisionShop(env);
    const owner = await loggedIn(env, s);
    const other = await loggedIn(env, s);
    for (let i = 0; i < 2; i++) {
      env.clock.advance(20 * MINUTE);
      expect((await owner.get('/auth/me')).statusCode).toBe(200);
      expect((await other.get('/auth/me')).statusCode).toBe(200);
    }
    const { settings } = (await owner.get('/settings')).json<{ settings: object }>();
    const shorter = { ...settings, session: { idleMinutes: 30, absoluteHours: 1 } };
    expect((await owner.put('/settings', { settings: shorter })).statusCode).toBe(200);
    expect((await other.get('/auth/me')).statusCode).toBe(200);
    env.clock.advance(20 * MINUTE);
    // Signed in 60 minutes ago, with a 12-hour limit at the time; now the limit is 1 hour.
    expect((await other.get('/auth/me')).statusCode).toBe(401);
    expect((await owner.get('/auth/me')).statusCode).toBe(401);
    expect((await loggedIn(env, s).then((c) => c.get('/auth/me'))).statusCode).toBe(200);
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

describe('per-IP credential throttle', () => {
  it('limits attempts from one address across different accounts', async () => {
    const app = buildServer({
      checkDatabase: () => Promise.resolve(),
      platform: {
        db: env.appDb,
        allowedOrigins: [],
        cookieSecure: true,
        now: () => env.clock.now,
        ipAttemptsPerMinute: 5,
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { tenant: shop.slug, username: `spray${String(i)}`, password: 'whatever pass' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    // Enrollment shares the same per-IP bucket.
    const enroll = await app.inject({
      method: 'POST',
      url: '/devices/enroll',
      payload: { tenant: shop.slug, code: 'ABCDE-12345' },
    });
    expect(enroll.statusCode).toBe(429);
    await app.close();
  });
});

describe('client address', () => {
  it('signs in even when a misconfigured proxy hop count yields a non-IP client address', async () => {
    // Two trusted hops behind one real proxy: the client's own X-Forwarded-For entry wins.
    const app = buildServer(
      {
        checkDatabase: () => Promise.resolve(),
        platform: {
          db: env.appDb,
          allowedOrigins: [],
          cookieSecure: true,
          now: () => env.clock.now,
          ipAttemptsPerMinute: 10_000,
        },
      },
      { trustProxy: fastifyTrustProxy(2) },
    );
    const s = await provisionShop(env);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-forwarded-for': 'not-an-ip, 198.51.100.7' },
      payload: { tenant: s.slug, username: 'owner', password: OWNER_PASSWORD },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const sessions = await withTenant(env.ownerDb, s.tenantId, (trx) =>
      trx.selectFrom('sessions').select('ip').execute(),
    );
    expect(sessions).toEqual([{ ip: null }]);
  });
});
