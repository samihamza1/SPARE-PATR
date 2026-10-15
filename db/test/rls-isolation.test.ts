import { newId } from '@autoparts/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src';
import { SQLSTATE, appDb, createRole, createTenant, createUser, ownerDb } from './helpers';

const owner = ownerDb();
// A single connection, so leaks between transactions on a pooled connection would show.
const app = appDb(1);

let tenantA: string;
let tenantB: string;
let userB: string;
let roleB: string;
let userA: string;

beforeAll(async () => {
  tenantA = await createTenant(owner);
  tenantB = await createTenant(owner);
  userA = await createUser(owner, tenantA, 'alice');
  userB = await createUser(owner, tenantB, 'bob');
  await createRole(owner, tenantA);
  roleB = await createRole(owner, tenantB);
});

afterAll(async () => {
  await app.destroy();
  await owner.destroy();
});

describe('tenant isolation as the app role (invariant 4)', () => {
  it('sees only its own tenant row and its own users', async () => {
    const { tenants, users } = await withTenant(app, tenantA, async (trx) => ({
      tenants: await trx.selectFrom('tenants').select('id').execute(),
      users: await trx.selectFrom('users').select(['id', 'tenant_id']).execute(),
    }));
    expect(tenants).toEqual([{ id: tenantA }]);
    expect(users).toEqual([{ id: userA, tenant_id: tenantA }]);
  });

  it('cannot read another tenant row even by primary key', async () => {
    const rows = await withTenant(app, tenantA, (trx) =>
      trx.selectFrom('users').selectAll().where('id', '=', userB).execute(),
    );
    expect(rows).toEqual([]);
  });

  it('cannot insert rows for another tenant', async () => {
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx
          .insertInto('users')
          .values({ id: newId(), tenant_id: tenantB, username: 'mallory', display_name: 'm' })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
  });

  it('cannot update rows of another tenant, nor move a row to another tenant', async () => {
    const result = await withTenant(app, tenantA, (trx) =>
      trx.updateTable('users').set({ display_name: 'pwned' }).where('id', '=', userB).execute(),
    );
    expect(result[0]?.numUpdatedRows).toBe(0n);

    await expect(
      withTenant(app, tenantA, (trx) =>
        trx.updateTable('users').set({ tenant_id: tenantB }).where('id', '=', userA).execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });

    const [bob] = await withTenant(owner, tenantB, (trx) =>
      trx.selectFrom('users').select('display_name').where('id', '=', userB).execute(),
    );
    expect(bob?.display_name).toBe('bob');
  });

  it('fails closed when no tenant is set', async () => {
    expect(await app.selectFrom('users').selectAll().execute()).toEqual([]);
    expect(await app.selectFrom('tenants').selectAll().execute()).toEqual([]);
    await expect(
      app
        .insertInto('users')
        .values({ id: newId(), tenant_id: tenantA, username: 'x', display_name: 'x' })
        .execute(),
    ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
  });

  it('does not leak the tenant to the next use of a pooled connection', async () => {
    await withTenant(app, tenantA, (trx) => trx.selectFrom('users').selectAll().execute());
    const { rows } = await sql<{ tenant: string | null }>`
      SELECT current_tenant_id() AS tenant`.execute(app);
    expect(rows).toEqual([{ tenant: null }]);
    expect(await app.selectFrom('users').selectAll().execute()).toEqual([]);
  });

  it('rolls the tenant context back with the transaction on error', async () => {
    await expect(withTenant(app, tenantA, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    const { rows } = await sql<{ tenant: string | null }>`
      SELECT current_tenant_id() AS tenant`.execute(app);
    expect(rows).toEqual([{ tenant: null }]);
  });

  it('rejects a malformed tenant id before touching the database', async () => {
    await expect(withTenant(app, 'not-a-uuid', () => Promise.resolve(1))).rejects.toThrow(
      TypeError,
    );
    await expect(withTenant(app, '', () => Promise.resolve(1))).rejects.toThrow(TypeError);
  });

  it('cannot reference another tenant through a foreign key', async () => {
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx
          .insertInto('user_roles')
          .values({ id: newId(), tenant_id: tenantA, user_id: userA, role_id: roleB })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.foreignKeyViolation });
  });

  it('cannot create tenants', async () => {
    const id = newId();
    await expect(
      withTenant(app, id, (trx) =>
        trx
          .insertInto('tenants')
          .values({
            id,
            slug: 'rogue',
            name: 'Rogue',
            functional_currency: 'AAA',
            timezone: 'UTC',
            default_locale: 'en',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
  });

  it('cannot hard-delete operational data (invariant 7)', async () => {
    await expect(
      withTenant(app, tenantA, (trx) => trx.deleteFrom('users').where('id', '=', userA).execute()),
    ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
  });

  it('cannot create objects in the public schema', async () => {
    await expect(sql`CREATE TABLE sneaky (id int)`.execute(app)).rejects.toMatchObject({
      code: SQLSTATE.insufficientPrivilege,
    });
  });
});

describe('tenant configuration', () => {
  it('rejects an unknown time zone', async () => {
    await expect(createTenant(owner, { timezone: 'Mars/Olympus_Mons' })).rejects.toMatchObject({
      code: SQLSTATE.checkViolation,
    });
  });

  it('rejects a malformed currency code', async () => {
    await expect(createTenant(owner, { functional_currency: 'aaa' })).rejects.toMatchObject({
      code: SQLSTATE.checkViolation,
    });
  });

  it('keeps usernames unique per tenant, case-insensitively', async () => {
    await expect(createUser(owner, tenantA, 'ALICE')).rejects.toMatchObject({ code: '23505' });
    await expect(createUser(owner, tenantB, 'alice')).resolves.toBeTypeOf('string');
  });

  it('maintains updated_at on change', async () => {
    const before = await withTenant(owner, tenantA, (trx) =>
      trx.selectFrom('tenants').select('updated_at').executeTakeFirstOrThrow(),
    );
    await withTenant(owner, tenantA, (trx) =>
      trx.updateTable('tenants').set({ name: 'Renamed' }).execute(),
    );
    const after = await withTenant(owner, tenantA, (trx) =>
      trx.selectFrom('tenants').select('updated_at').executeTakeFirstOrThrow(),
    );
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});
