import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import { createDatabase, withTenant } from '@autoparts/db';
import { newId } from '@autoparts/shared/ids';

const urls = inject('db');
const owner = createDatabase({ connectionString: urls.ownerUrl, max: 1 });
// A single pooled connection makes any leak of the tenant setting observable.
const app = createDatabase({ connectionString: urls.appUrl, max: 1 });

const tenantA = newId();
const tenantB = newId();

async function provision(tenantId: string, slug: string): Promise<void> {
  await withTenant(owner, tenantId, async (trx) => {
    await trx
      .insertInto('tenants')
      .values({
        id: tenantId,
        name: slug,
        slug,
        timezone: 'UTC',
        functional_currency: 'XTS',
        default_locale: 'ar',
      })
      .execute();
    await trx
      .insertInto('users')
      .values({ tenant_id: tenantId, id: newId(), username: 'admin', display_name: 'Admin' })
      .execute();
  });
}

beforeAll(async () => {
  await provision(tenantA, `api-a-${tenantA}`);
  await provision(tenantB, `api-b-${tenantB}`);
});

afterAll(async () => {
  await owner.destroy();
  await app.destroy();
});

describe('withTenant', () => {
  it('scopes every query to the given tenant', async () => {
    const users = await withTenant(app, tenantA, (trx) =>
      trx.selectFrom('users').select(['tenant_id']).execute(),
    );
    expect(users).toEqual([{ tenant_id: tenantA }]);
  });

  it('does not leak the tenant to the next user of the pooled connection', async () => {
    await withTenant(app, tenantA, (trx) => trx.selectFrom('users').selectAll().execute());
    const leaked = await sql<{ tenant: string | null }>`
      SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant`.execute(app);
    expect(leaked.rows).toEqual([{ tenant: null }]);
    expect(await app.selectFrom('users').selectAll().execute()).toEqual([]);
  });

  it('does not leak the tenant after a failed transaction', async () => {
    await expect(
      withTenant(app, tenantA, async (trx) => {
        await trx.selectFrom('users').selectAll().execute();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const users = await withTenant(app, tenantB, (trx) =>
      trx.selectFrom('users').select(['tenant_id']).execute(),
    );
    expect(users).toEqual([{ tenant_id: tenantB }]);
  });

  it('rejects values that are not UUIDs before touching the database', async () => {
    await expect(withTenant(app, "x' OR true --", () => Promise.resolve())).rejects.toThrow(
      RangeError,
    );
  });
});
