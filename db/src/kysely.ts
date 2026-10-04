import { Kysely, PostgresDialect, sql } from 'kysely';
import type { Transaction } from 'kysely';
import pg from 'pg';

import type { DB } from './generated/db.js';

export type Database = Kysely<DB>;
export type TenantTransaction = Transaction<DB>;

export interface CreateDatabaseOptions {
  connectionString: string;
  max?: number;
}

export function createDatabase({ connectionString, max = 10 }: CreateDatabaseOptions): Database {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max }) }),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` in a transaction scoped to one tenant. The setting is transaction-local
 * (equivalent to SET LOCAL), so it cannot leak to the next user of a pooled connection.
 */
export async function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (trx: TenantTransaction) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) throw new RangeError('withTenant needs a tenant UUID');
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}
