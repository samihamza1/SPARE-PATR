import pg from 'pg';
import { afterAll, inject } from 'vitest';

import { newId } from '@autoparts/shared/ids';

export const urls = inject('db');

/** One client per role, closed after the file. */
export function connect(url: string): pg.Client {
  const client = new pg.Client({ connectionString: url });
  const ready = client.connect();
  afterAll(async () => {
    await ready;
    await client.end();
  });
  return client;
}

/** Run `fn` inside a transaction with app.tenant_id set (as withTenant does), then roll back or commit. */
export async function inTenant<T>(
  client: pg.Client,
  tenantId: string | null,
  fn: () => Promise<T>,
  { commit = false } = {},
): Promise<T> {
  await client.query('BEGIN');
  try {
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await fn();
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export interface SeededTenant {
  tenantId: string;
  userId: string;
  roleId: string;
}

/**
 * Provision a tenant with one user and one role, as the owner role does in production
 * (context set to the new tenant). Values are neutral test data, not business rules.
 */
export async function seedTenant(owner: pg.Client, slug: string): Promise<SeededTenant> {
  const tenantId = newId();
  const userId = newId();
  const roleId = newId();
  await inTenant(
    owner,
    tenantId,
    async () => {
      await owner.query(
        `INSERT INTO tenants (id, name, slug, timezone, functional_currency, default_locale)
         VALUES ($1, $2, $3, 'UTC', 'XTS', 'ar')`,
        [tenantId, `Tenant ${slug}`, slug],
      );
      await owner.query(
        `INSERT INTO users (tenant_id, id, username, display_name) VALUES ($1, $2, 'admin', 'Admin')`,
        [tenantId, userId],
      );
      await owner.query(
        `INSERT INTO roles (tenant_id, id, code, name) VALUES ($1, $2, 'cashier', 'Cashier')`,
        [tenantId, roleId],
      );
    },
    { commit: true },
  );
  return { tenantId, userId, roleId };
}

export async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error('Expected the query to fail');
}
