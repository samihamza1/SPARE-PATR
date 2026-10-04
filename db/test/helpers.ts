import { newId } from '@autoparts/shared';
import type { Insertable, Kysely } from 'kysely';
import { createDb, withTenant } from '../src';
import { loadRootEnv, requireEnv } from '../src/env';
import type { DB, Tenants } from '../src/types.generated';

loadRootEnv();

/** Connects as autoparts_owner (runs migrations; still subject to FORCE RLS). */
export function ownerDb(): Kysely<DB> {
  return createDb({ connectionString: requireEnv('TEST_DATABASE_URL'), max: 2 });
}

/** Connects as autoparts_app, the role the API uses. */
export function appDb(max = 2): Kysely<DB> {
  return createDb({ connectionString: requireEnv('TEST_APP_DATABASE_URL'), max });
}

/** Provisions a tenant through the owner role, the only role allowed to insert tenants. */
export async function createTenant(
  db: Kysely<DB>,
  overrides: Partial<Insertable<Tenants>> = {},
): Promise<string> {
  const id = overrides.id ?? newId();
  const functionalCurrency = overrides.functional_currency ?? 'AAA';
  await withTenant(db, id, async (trx) => {
    await trx
      .insertInto('tenants')
      .values({
        id,
        slug: `t-${id.slice(-12)}`,
        name: 'Test tenant',
        functional_currency: functionalCurrency,
        timezone: 'UTC',
        default_locale: 'ar',
        ...overrides,
      })
      .execute();
    // The functional currency must exist as an active tenant currency (checked at commit).
    // Neutral test data: placeholder code and minor units, not a business rule.
    await trx
      .insertInto('tenant_currencies')
      .values({ id: newId(), tenant_id: id, code: functionalCurrency, minor_units: 2 })
      .execute();
  });
  return id;
}

export async function createUser(
  db: Kysely<DB>,
  tenantId: string,
  username = 'user',
): Promise<string> {
  const id = newId();
  await withTenant(db, tenantId, (trx) =>
    trx
      .insertInto('users')
      .values({ id, tenant_id: tenantId, username, display_name: username })
      .execute(),
  );
  return id;
}

export async function createRole(
  db: Kysely<DB>,
  tenantId: string,
  code = 'cashier',
): Promise<string> {
  const id = newId();
  await withTenant(db, tenantId, (trx) =>
    trx.insertInto('roles').values({ id, tenant_id: tenantId, code, name: code }).execute(),
  );
  return id;
}

/** Postgres SQLSTATE codes used in assertions. */
export const SQLSTATE = {
  insufficientPrivilege: '42501',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  raiseException: 'P0001',
} as const;
