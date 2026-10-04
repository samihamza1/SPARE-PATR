import { randomBytes } from 'node:crypto';
import { newId } from '@autoparts/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src';
import { SQLSTATE, appDb, createTenant, createUser, ownerDb } from './helpers';

const owner = ownerDb();
const app = appDb(1);

let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;
const slugA = `shop-a-${Date.now().toString(36)}`;

const hash32 = () => randomBytes(32);

beforeAll(async () => {
  tenantA = await createTenant(owner, { slug: slugA });
  tenantB = await createTenant(owner);
  userA = await createUser(owner, tenantA, 'alice');
  userB = await createUser(owner, tenantB, 'bob');
});

afterAll(async () => {
  await app.destroy();
  await owner.destroy();
});

const resolve = async (slug: string) => {
  const { rows } = await sql<{
    id: string | null;
  }>`SELECT resolve_tenant_slug(${slug}) AS id`.execute(app);
  return rows[0]?.id ?? null;
};

describe('tenant directory (login before tenant context)', () => {
  it('resolves an active shop code without any tenant context', async () => {
    expect(await resolve(slugA)).toBe(tenantA);
    expect(await resolve(slugA.toUpperCase())).toBe(tenantA);
  });

  it('returns NULL for unknown and archived shop codes alike', async () => {
    expect(await resolve('no-such-shop')).toBeNull();
    const archived = await createTenant(owner);
    const { slug } = await withTenant(owner, archived, async (trx) => {
      await trx.updateTable('tenants').set({ archived_at: new Date() }).execute();
      return trx.selectFrom('tenants').select('slug').executeTakeFirstOrThrow();
    });
    expect(await resolve(slug)).toBeNull();
  });

  it('follows slug changes', async () => {
    const t = await createTenant(owner);
    const renamed = `renamed-${Date.now().toString(36)}`;
    await withTenant(owner, t, (trx) =>
      trx.updateTable('tenants').set({ slug: renamed }).execute(),
    );
    expect(await resolve(renamed)).toBe(t);
  });

  it('cannot be read or enumerated by the app role', async () => {
    await expect(sql`SELECT * FROM tenant_directory`.execute(app)).rejects.toMatchObject({
      code: SQLSTATE.insufficientPrivilege,
    });
  });
});

describe('tenant configuration columns', () => {
  it('lets the app edit name, locale and settings only', async () => {
    await withTenant(app, tenantA, (trx) =>
      trx
        .updateTable('tenants')
        .set({ name: 'Renamed', default_locale: 'en', settings: JSON.stringify({ a: 1 }) })
        .execute(),
    );
    for (const set of [
      { functional_currency: 'BBB' },
      { timezone: 'Asia/Dubai' },
      { slug: 'hijack' },
      { archived_at: new Date() },
    ]) {
      await expect(
        withTenant(app, tenantA, (trx) => trx.updateTable('tenants').set(set).execute()),
        JSON.stringify(set),
      ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
    }
  });
});

describe('sessions', () => {
  const newSession = (tenantId: string, userId: string) => ({
    id: newId(),
    tenant_id: tenantId,
    user_id: userId,
    secret_hash: hash32(),
    expires_at: new Date(Date.now() + 3_600_000),
  });

  it('are created, touched and revoked by the app role, never deleted', async () => {
    const s = newSession(tenantA, userA);
    await withTenant(app, tenantA, async (trx) => {
      await trx.insertInto('sessions').values(s).execute();
      await trx
        .updateTable('sessions')
        .set({ last_seen_at: new Date(), revoked_at: new Date(), revoked_reason: 'logout' })
        .where('id', '=', s.id)
        .execute();
    });
    await expect(
      withTenant(app, tenantA, (trx) => trx.deleteFrom('sessions').execute()),
    ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
  });

  it('cannot have their secret or expiry changed by the app role', async () => {
    const s = newSession(tenantA, userA);
    await withTenant(app, tenantA, (trx) => trx.insertInto('sessions').values(s).execute());
    for (const set of [{ secret_hash: hash32() }, { expires_at: new Date(Date.now() + 1e9) }]) {
      await expect(
        withTenant(app, tenantA, (trx) =>
          trx.updateTable('sessions').set(set).where('id', '=', s.id).execute(),
        ),
      ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
    }
  });

  it('cannot belong to another tenant user', async () => {
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx.insertInto('sessions').values(newSession(tenantA, userB)).execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.foreignKeyViolation });
  });

  it('are invisible across tenants', async () => {
    await withTenant(app, tenantB, (trx) =>
      trx.insertInto('sessions').values(newSession(tenantB, userB)).execute(),
    );
    const rows = await withTenant(app, tenantA, (trx) =>
      trx.selectFrom('sessions').select('user_id').distinct().execute(),
    );
    expect(rows).toEqual([{ user_id: userA }]);
  });
});

describe('devices', () => {
  const newDevice = (name: string, createdBy = userA) => ({
    id: newId(),
    tenant_id: tenantA,
    name,
    created_by: createdBy,
    enrollment_code_hash: hash32(),
    enrollment_expires_at: new Date(Date.now() + 600_000),
  });

  it('enforce unique names among active devices, case-insensitively', async () => {
    await withTenant(app, tenantA, (trx) =>
      trx.insertInto('devices').values(newDevice('Till 1')).execute(),
    );
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx.insertInto('devices').values(newDevice('till 1')).execute(),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('keep enrollment and revocation consistent', async () => {
    const d = newDevice('Till 2');
    await withTenant(app, tenantA, (trx) => trx.insertInto('devices').values(d).execute());
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx
          .updateTable('devices')
          .set({ enrolled_at: new Date() })
          .where('id', '=', d.id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx.updateTable('devices').set({ revoked_at: new Date() }).where('id', '=', d.id).execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
  });

  it('cannot be attributed to another tenant user', async () => {
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx.insertInto('devices').values(newDevice('Till 3', userB)).execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.foreignKeyViolation });
  });
});

describe('tenant currencies', () => {
  it('a tenant cannot be created without its functional currency', async () => {
    const id = newId();
    await expect(
      withTenant(owner, id, (trx) =>
        trx
          .insertInto('tenants')
          .values({
            id,
            slug: `nocur-${id.slice(-8)}`,
            name: 'x',
            functional_currency: 'CCC',
            timezone: 'UTC',
            default_locale: 'ar',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
  });

  it('the functional currency cannot be deactivated', async () => {
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx
          .updateTable('tenant_currencies')
          .set({ is_active: false })
          .where('code', '=', 'AAA')
          .execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
  });

  it('other currencies can be added and deactivated; code and minor units are fixed', async () => {
    const id = newId();
    await withTenant(app, tenantA, async (trx) => {
      await trx
        .insertInto('tenant_currencies')
        .values({ id, tenant_id: tenantA, code: 'BBB', minor_units: 0 })
        .execute();
      await trx
        .updateTable('tenant_currencies')
        .set({ is_active: false })
        .where('id', '=', id)
        .execute();
    });
    for (const set of [{ minor_units: 3 }, { code: 'DDD' }]) {
      await expect(
        withTenant(app, tenantA, (trx) =>
          trx.updateTable('tenant_currencies').set(set).where('id', '=', id).execute(),
        ),
      ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
    }
  });

  it('rejects a cash increment finer than the minor unit', async () => {
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx
          .insertInto('tenant_currencies')
          .values({
            id: newId(),
            tenant_id: tenantA,
            code: 'EEE',
            minor_units: 1,
            cash_increment: '0.05',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
  });
});
