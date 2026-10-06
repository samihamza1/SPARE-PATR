import { withTenant } from '@autoparts/db';
import { newId } from '@autoparts/shared';
import type { Permission, Role, User } from '@autoparts/shared';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Shop } from './harness';
import {
  Client,
  OWNER_PASSWORD,
  whileLocked,
  loggedIn,
  provisionShop,
  setupEnv,
  waitForLockWaiters,
} from './harness';

/** ADR 0017: no privilege escalation, and the last administrator cannot be raced away. */
const env = setupEnv();

async function createRole(client: Client, code: string, permissions: Permission[]) {
  const id = newId();
  const res = await client.post('/roles', { id, code, name: code, permissions });
  expect(res.statusCode).toBe(201);
  return id;
}

async function createUser(client: Client, username: string, roleId?: string) {
  const id = newId();
  const res = await client.post('/users', {
    id,
    username,
    displayName: username,
    password: `${username} passphrase`,
  });
  expect(res.statusCode).toBe(201);
  if (roleId !== undefined) {
    expect((await client.post(`/users/${id}/roles`, { roleId })).statusCode).toBe(200);
  }
  return id;
}

const roleOf = async (client: Client, code: string) => {
  const role = (await client.get('/roles')).json<Role[]>().find((r) => r.code === code);
  if (role === undefined) throw new Error(`no role ${code}`);
  return role;
};

const expectRefused = (res: { statusCode: number; json: () => unknown }) => {
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: { code: 'auth.exceeds_own_permissions' } });
};

describe('users.manage without the other permissions', () => {
  let shop: Shop;
  let owner: Client;
  let manager: Client;
  let managerId: string;
  let managerRoleId: string;
  let ownerRole: Role;

  beforeAll(async () => {
    shop = await provisionShop(env);
    owner = await loggedIn(env, shop);
    ownerRole = await roleOf(owner, 'owner');
    managerRoleId = await createRole(owner, 'store_manager', ['users.manage']);
    managerId = await createUser(owner, 'manager', managerRoleId);
    manager = await loggedIn(env, shop, 'manager', 'manager passphrase');
  });

  it('cannot grant a role holding permissions it lacks, to itself or anyone', async () => {
    expectRefused(await manager.post(`/users/${managerId}/roles`, { roleId: ownerRole.id }));
    const cashierId = await createUser(manager, 'cash_a');
    expectRefused(await manager.post(`/users/${cashierId}/roles`, { roleId: ownerRole.id }));
    const supervisor = await roleOf(owner, 'supervisor');
    expectRefused(await manager.post(`/users/${cashierId}/roles`, { roleId: supervisor.id }));
    const me = (await manager.get('/auth/me')).json<{ permissions: string[] }>();
    expect(me.permissions).toEqual(['users.manage']);
  });

  it("cannot set the owner's password, archive the owner or change the owner's roles", async () => {
    expectRefused(
      await manager.post(`/users/${shop.ownerUserId}/password`, { password: 'taken over pass 1' }),
    );
    expectRefused(await manager.post(`/users/${shop.ownerUserId}/archive`));
    expectRefused(await manager.post(`/users/${shop.ownerUserId}/roles/${ownerRole.id}/revoke`));
    const cashier = await roleOf(owner, 'cashier');
    expectRefused(await manager.post(`/users/${shop.ownerUserId}/roles`, { roleId: cashier.id }));
    expectRefused(await manager.patch(`/users/${shop.ownerUserId}`, { email: 'me@evil.test' }));
    // Nothing changed: the owner still signs in with the old password and keeps the session.
    expect((await owner.get('/auth/me')).statusCode).toBe(200);
    await loggedIn(env, shop, 'owner', OWNER_PASSWORD);
    const audit = await withTenant(env.ownerDb, shop.tenantId, (trx) =>
      trx
        .selectFrom('audit_log')
        .select('action')
        .where('actor_user_id', '=', managerId)
        .where('entity_id', '=', shop.ownerUserId)
        .execute(),
    );
    expect(audit).toEqual([]);
  });

  it('still manages users whose permissions it holds', async () => {
    const cashier = await roleOf(owner, 'cashier');
    const id = await createUser(manager, 'cash_b', cashier.id);
    expect((await manager.post(`/users/${id}/roles`, { roleId: managerRoleId })).statusCode).toBe(
      200,
    );
    expect((await manager.patch(`/users/${id}`, { displayName: 'Cashier B' })).statusCode).toBe(
      200,
    );
    expect(
      (await manager.post(`/users/${id}/password`, { password: 'fresh passphrase 2' })).statusCode,
    ).toBe(204);
    expect((await manager.post(`/users/${id}/roles/${managerRoleId}/revoke`)).statusCode).toBe(200);
    expect((await manager.post(`/users/${id}/archive`)).statusCode).toBe(200);
    const users = (await owner.get('/users')).json<User[]>();
    expect(users.find((u) => u.id === id)?.archivedAt).not.toBeNull();
  });

  it('owners are unaffected', async () => {
    const id = await createUser(owner, 'second_owner', ownerRole.id);
    expect(
      (await owner.post(`/users/${id}/password`, { password: 'owner two passphrase' })).statusCode,
    ).toBe(204);
    expect(
      (await owner.post(`/users/${managerId}/roles`, { roleId: ownerRole.id })).statusCode,
    ).toBe(200);
    // Now the manager holds every permission and may act on the owner like any owner.
    const promoted = await loggedIn(env, shop, 'manager', 'manager passphrase');
    expect((await promoted.patch(`/users/${id}`, { displayName: 'Owner 2' })).statusCode).toBe(200);
  });
});

describe('roles.manage without the other permissions', () => {
  let shop: Shop;
  let owner: Client;
  let roleAdmin: Client;
  let roleAdminRoleId: string;

  beforeAll(async () => {
    shop = await provisionShop(env);
    owner = await loggedIn(env, shop);
    roleAdminRoleId = await createRole(owner, 'role_admin', ['roles.manage']);
    await createUser(owner, 'roleadmin', roleAdminRoleId);
    roleAdmin = await loggedIn(env, shop, 'roleadmin', 'roleadmin passphrase');
  });

  it('cannot add a permission it lacks to its own role or any other', async () => {
    expectRefused(
      await roleAdmin.patch(`/roles/${roleAdminRoleId}`, {
        permissions: ['roles.manage', 'users.manage'],
      }),
    );
    const cashier = await roleOf(owner, 'cashier');
    expectRefused(await roleAdmin.patch(`/roles/${cashier.id}`, { permissions: ['audit.read'] }));
    expectRefused(
      await roleAdmin.post('/roles', {
        id: newId(),
        code: 'sneaky',
        name: 'Sneaky',
        permissions: ['settings.manage'],
      }),
    );
    expect((await roleOf(owner, 'role_admin')).permissions).toEqual(['roles.manage']);
    expect((await roleOf(owner, 'cashier')).permissions).toEqual([]);
  });

  it('cannot change a role that holds permissions it lacks', async () => {
    const ownerRole = await roleOf(owner, 'owner');
    expectRefused(await roleAdmin.patch(`/roles/${ownerRole.id}`, { name: 'Cashier (basic)' }));
    expectRefused(await roleAdmin.patch(`/roles/${ownerRole.id}`, { permissions: [] }));
    expect((await roleOf(owner, 'owner')).name).toBe(ownerRole.name);
  });

  it('still manages roles within its own permissions', async () => {
    const id = await createRole(roleAdmin, 'helpers', ['roles.manage']);
    expect((await roleAdmin.patch(`/roles/${id}`, { permissions: [] })).statusCode).toBe(200);
    const cashier = await roleOf(owner, 'cashier');
    expect((await roleAdmin.patch(`/roles/${cashier.id}`, { name: 'Till' })).statusCode).toBe(200);
  });
});

describe('last administrator', () => {
  /**
   * Both requests pass their own check before either commits: the test holds a lock that
   * blocks their audit inserts (after the check) until both have arrived.
   */
  async function race(s: Shop, first: () => Promise<{ statusCode: number }>, second: typeof first) {
    const [a, b] = await whileLocked(
      env,
      s.tenantId,
      (trx) => sql`LOCK TABLE audit_log IN SHARE MODE`.execute(trx),
      async (release) => {
        const x = first();
        await waitForLockWaiters(env, 1);
        const y = second();
        await waitForLockWaiters(env, 2);
        await release();
        return Promise.all([x, y]);
      },
    );
    return [a.statusCode, b.statusCode];
  }

  async function twoOwners() {
    const s = await provisionShop(env);
    const owner = await loggedIn(env, s);
    const ownerRole = await roleOf(owner, 'owner');
    const secondId = await createUser(owner, 'owner2', ownerRole.id);
    return { s, owner, ownerRole, secondId };
  }

  const adminsLeft = (s: Shop) =>
    withTenant(env.ownerDb, s.tenantId, (trx) =>
      trx
        .selectFrom('users as u')
        .innerJoin('user_roles as ur', 'ur.user_id', 'u.id')
        .innerJoin('roles as r', 'r.id', 'ur.role_id')
        .select('u.id')
        .where('u.archived_at', 'is', null)
        .where('ur.revoked_at', 'is', null)
        .where('r.code', '=', 'owner')
        .execute(),
    );

  it('serialises two concurrent role revocations that would each leave the other admin', async () => {
    const { s, owner, ownerRole, secondId } = await twoOwners();
    const statuses = await race(
      s,
      () => owner.post(`/users/${secondId}/roles/${ownerRole.id}/revoke`),
      () => owner.post(`/users/${s.ownerUserId}/roles/${ownerRole.id}/revoke`),
    );
    expect(statuses).toEqual([200, 409]);
    expect(await adminsLeft(s)).toHaveLength(1);
  });

  it('serialises an archive racing a role revocation', async () => {
    const { s, owner, ownerRole, secondId } = await twoOwners();
    const statuses = await race(
      s,
      () => owner.post(`/users/${secondId}/archive`),
      () => owner.post(`/users/${s.ownerUserId}/roles/${ownerRole.id}/revoke`),
    );
    expect(statuses).toEqual([200, 409]);
    expect(await adminsLeft(s)).toHaveLength(1);
  });
});
