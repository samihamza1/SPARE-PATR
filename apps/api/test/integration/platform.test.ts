import { withTenant } from '@autoparts/db';
import { newId } from '@autoparts/shared';
import type { MeResponse, Role, User } from '@autoparts/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Shop } from './harness';
import { Client, MINUTE, errorCode, loggedIn, provisionShop, setupEnv } from './harness';

const env = setupEnv();
let shop: Shop;
let owner: Client;
let roles: Role[];
const role = (code: string) => {
  const r = roles.find((x) => x.code === code);
  if (r === undefined) throw new Error(`no role ${code}`);
  return r;
};

async function createUser(client: Client, username: string, roleCode?: string) {
  const id = newId();
  const res = await client.post('/users', {
    id,
    username,
    displayName: username,
    password: `${username} passphrase`,
  });
  expect(res.statusCode).toBe(201);
  if (roleCode !== undefined) {
    expect(
      (await client.post(`/users/${id}/roles`, { roleId: role(roleCode).id })).statusCode,
    ).toBe(200);
  }
  return id;
}

const auditOf = (tenantId: string, action: string) =>
  withTenant(env.ownerDb, tenantId, (trx) =>
    trx.selectFrom('audit_log').selectAll().where('action', '=', action).orderBy('id').execute(),
  );

beforeAll(async () => {
  shop = await provisionShop(env);
  owner = await loggedIn(env, shop);
  roles = (await owner.get('/roles')).json<Role[]>();
});

describe('provisioning', () => {
  it('creates the BRIEF system roles and an owner holding the owner role', async () => {
    expect(roles.map((r) => r.code).sort()).toEqual([
      'accountant',
      'cashier',
      'owner',
      'supervisor',
    ]);
    expect(role('cashier').permissions).not.toContain('cost.view');
    const users = (await owner.get('/users')).json<User[]>();
    expect(users).toHaveLength(1);
    expect(users[0]?.roleIds).toEqual([role('owner').id]);
  });
});

describe('users and roles', () => {
  it('creates a user, grants a role, and the new user signs in with those permissions', async () => {
    await createUser(owner, 'sara', 'supervisor');
    const sara = await loggedIn(env, shop, 'sara', 'sara passphrase');
    expect((await sara.get('/auth/me')).json<MeResponse>().permissions).toEqual([
      'audit.read',
      'cost.view',
      'sessions.manage',
      'stock.adjust',
      'stock.approve_count',
      'stock.count',
      'stock.review',
      'stock.transfer',
    ]);
    expect((await sara.get('/audit-log')).statusCode).toBe(200);
    expect((await sara.get('/users')).statusCode).toBe(403);
  });

  it('rejects weak passwords and duplicate usernames', async () => {
    const weak = await owner.post('/users', {
      id: newId(),
      username: 'w',
      displayName: 'w',
      password: 'short',
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json<{ error: { issues: unknown[] } }>().error.issues[0]).toMatchObject({
      path: 'password',
      message: 'password.too_short',
    });
    const dup = await owner.post('/users', {
      id: newId(),
      username: 'SARA',
      displayName: 'x',
      password: 'long enough pass',
    });
    expect(dup.statusCode).toBe(409);
  });

  it('applies role permission changes on the next request', async () => {
    await createUser(owner, 'acc1', 'accountant');
    const acc = await loggedIn(env, shop, 'acc1', 'acc1 passphrase');
    expect((await acc.get('/audit-log')).statusCode).toBe(200);
    const res = await owner.patch(`/roles/${role('accountant').id}`, {
      permissions: ['cost.view'],
    });
    expect(res.statusCode).toBe(200);
    expect((await acc.get('/audit-log')).statusCode).toBe(403);
    expect(await auditOf(shop.tenantId, 'role.update')).toHaveLength(1);
  });

  it('archiving a user ends their sessions immediately', async () => {
    const id = await createUser(owner, 'temp1', 'cashier');
    const temp = await loggedIn(env, shop, 'temp1', 'temp1 passphrase');
    expect((await owner.post(`/users/${id}/archive`)).statusCode).toBe(200);
    expect((await temp.get('/auth/me')).statusCode).toBe(401);
    expect(
      (await new Client(env.app).login(shop.slug, 'temp1', 'temp1 passphrase')).statusCode,
    ).toBe(401);
  });

  it('an admin password reset unlocks the account and ends its sessions', async () => {
    const id = await createUser(owner, 'reset1', 'cashier');
    const before = await loggedIn(env, shop, 'reset1', 'reset1 passphrase');
    expect(
      (await owner.post(`/users/${id}/password`, { password: 'fresh passphrase 9' })).statusCode,
    ).toBe(204);
    expect((await before.get('/auth/me')).statusCode).toBe(401);
    await loggedIn(env, shop, 'reset1', 'fresh passphrase 9');
  });

  it('never leaves the tenant without an administrator', async () => {
    const res = await owner.post(`/users/${shop.ownerUserId}/roles/${role('owner').id}/revoke`);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('users.last_admin');
    const strip = await owner.patch(`/roles/${role('owner').id}`, { permissions: ['audit.read'] });
    expect(errorCode(strip)).toBe('users.last_admin');
    expect(errorCode(await owner.post(`/users/${shop.ownerUserId}/archive`))).toBe(
      'resource.conflict',
    );
  });

  it('cannot see or touch another tenant users', async () => {
    const otherShop = await provisionShop(env);
    const otherOwner = await loggedIn(env, otherShop);
    expect((await otherOwner.get('/users')).json<User[]>()).toHaveLength(1);
    expect(
      (await otherOwner.patch(`/users/${shop.ownerUserId}`, { displayName: 'pwned' })).statusCode,
    ).toBe(404);
    expect(
      (
        await otherOwner.post(`/users/${otherShop.ownerUserId}/roles`, {
          roleId: role('cashier').id,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('settings and currencies', () => {
  it('returns provisioned settings and audits changes with before/after', async () => {
    const got = (await owner.get('/settings')).json<{ settings: Record<string, unknown> }>();
    expect(got.settings).toMatchObject({
      money: { roundingMode: 'HALF_EVEN' },
      inventory: { allowNegativeStock: false },
      session: { idleMinutes: 30, absoluteHours: 12 },
    });
    const updated = { ...got.settings, session: { idleMinutes: 15, absoluteHours: 8 } };
    expect((await owner.put('/settings', { settings: updated })).statusCode).toBe(200);
    const [entry] = await auditOf(shop.tenantId, 'settings.change');
    expect(entry?.before).toMatchObject({ settings: { session: { idleMinutes: 30 } } });
    expect(entry?.after).toMatchObject({ settings: { session: { idleMinutes: 15 } } });
  });

  it('refuses settings missing the required business rules', async () => {
    const res = await owner.put('/settings', {
      settings: { session: { idleMinutes: 30, absoluteHours: 12 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('applies a shorter idle timeout to existing sessions', async () => {
    const client = await loggedIn(env, shop);
    env.clock.advance(16 * MINUTE);
    expect((await client.get('/auth/me')).statusCode).toBe(401);
    owner = await loggedIn(env, shop);
  });

  it('adds a currency, keeps the functional one active, and lists currencies for everyone', async () => {
    const id = newId();
    const add = await owner.post('/currencies', {
      id,
      code: 'BBB',
      minorUnits: 0,
      cashIncrement: '5',
    });
    expect(add.statusCode).toBe(201);
    expect(add.json()).toMatchObject({ code: 'BBB', isFunctional: false, isActive: true });
    const functional = (await owner.get('/currencies'))
      .json<{ id: string; isFunctional: boolean }[]>()
      .find((c) => c.isFunctional);
    expect(
      (await owner.patch(`/currencies/${functional?.id ?? ''}`, { isActive: false })).statusCode,
    ).toBe(400);
    expect((await owner.patch(`/currencies/${id}`, { isActive: false })).statusCode).toBe(200);
  });
});

describe('devices', () => {
  it('enrolls a device with a one-time code and binds sessions to it', async () => {
    const id = newId();
    const created = await owner.post('/devices', { id, name: 'Till 1' });
    expect(created.statusCode).toBe(201);
    const { enrollmentCode } = created.json<{ enrollmentCode: string }>();
    expect(enrollmentCode).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

    const device = new Client(env.app, null);
    expect(
      errorCode(await device.post('/devices/enroll', { tenant: shop.slug, code: 'WRONG-CODE0' })),
    ).toBe('device.invalid_code');
    const typed = enrollmentCode.toLowerCase().replace('-', ' ');
    const enrolled = await device.post('/devices/enroll', { tenant: shop.slug, code: typed });
    expect(enrolled.statusCode).toBe(200);
    const { credential } = enrolled.json<{ credential: string }>();
    // One-time: the same code no longer works.
    expect(
      (await device.post('/devices/enroll', { tenant: shop.slug, code: enrollmentCode }))
        .statusCode,
    ).toBe(400);

    const till = new Client(env.app);
    await till.login(shop.slug, 'owner', 'owner passphrase 1', {
      'x-device-credential': credential,
    });
    expect((await till.get('/auth/me')).statusCode).toBe(200);

    expect((await owner.post(`/devices/${id}/revoke`)).statusCode).toBe(200);
    expect((await till.get('/auth/me')).statusCode).toBe(401);
    expect((await owner.get('/auth/me')).statusCode).toBe(200);
  });

  it('expires unused enrollment codes after 30 minutes', async () => {
    const created = await owner.post('/devices', { id: newId(), name: 'Till 2' });
    const { enrollmentCode } = created.json<{ enrollmentCode: string }>();
    env.clock.advance(29 * MINUTE);
    owner = await loggedIn(env, shop);
    env.clock.advance(2 * MINUTE);
    const res = await new Client(env.app, null).post('/devices/enroll', {
      tenant: shop.slug,
      code: enrollmentCode,
    });
    expect(errorCode(res)).toBe('device.invalid_code');
  });
});

describe('sessions and audit log', () => {
  it('lists own sessions and lets a supervisor revoke someone else', async () => {
    await createUser(owner, 'sup2', 'supervisor');
    const sup = await loggedIn(env, shop, 'sup2', 'sup2 passphrase');
    const mine = (await owner.get('/me/sessions')).json<{ id: string; current: boolean }[]>();
    const current = mine.find((s) => s.current);
    expect(current).toBeDefined();
    expect((await sup.post(`/sessions/${current?.id ?? ''}/revoke`)).statusCode).toBe(204);
    expect((await owner.get('/auth/me')).statusCode).toBe(401);
    owner = await loggedIn(env, shop);
  });

  it('pages through the audit log newest first', async () => {
    const page1 = (await owner.get('/audit-log?limit=5')).json<{ id: string }[]>();
    expect(page1).toHaveLength(5);
    const page2 = (await owner.get(`/audit-log?limit=5&before=${page1[4]?.id ?? ''}`)).json<
      { id: string }[]
    >();
    expect(page2.length).toBeGreaterThan(0);
    expect((page2[0]?.id ?? '') < (page1[4]?.id ?? '')).toBe(true);
    const logins = (await owner.get('/audit-log?entityType=session')).json<{ action: string }[]>();
    expect(
      logins.every((e) => e.action.startsWith('auth.') || e.action.startsWith('session.')),
    ).toBe(true);
  });

  it('never exposes password hashes or secrets', async () => {
    const body = JSON.stringify([
      (await owner.get('/users')).json(),
      (await owner.get('/audit-log?limit=200')).json(),
      (await owner.get('/devices')).json(),
      (await owner.get('/me/sessions')).json(),
    ]);
    expect(body).not.toMatch(/argon2|password_hash|secret_hash|credential_hash/);
  });
});
