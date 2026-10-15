import { uuidSchema } from '@autoparts/shared';
import { Kysely, PostgresDialect, sql } from 'kysely';
import type { Transaction } from 'kysely';
import pg from 'pg';
import type { DB } from './types.generated';

export interface CreateDbOptions {
  connectionString: string;
  /** Pool size. */
  max?: number;
  applicationName?: string;
}

/**
 * Creates a Kysely client. node-postgres returns NUMERIC and BIGINT as strings, which is
 * what invariant 1 needs; do not register float parsers for them. Sessions run in UTC.
 */
export function createDb({
  connectionString,
  max = 10,
  applicationName = 'autoparts',
}: CreateDbOptions): Kysely<DB> {
  const pool = new pg.Pool({
    connectionString,
    max,
    application_name: applicationName,
    options: '-c TimeZone=UTC',
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Runs `fn` in a transaction scoped to one tenant (invariant 4). The tenant id is set with
 * set_config(..., is_local => true), i.e. SET LOCAL, so it ends with the transaction and
 * never leaks to the next user of a pooled connection.
 */
export async function withTenant<T>(
  db: Kysely<DB>,
  tenantId: string,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (!uuidSchema.safeParse(tenantId).success) {
    throw new TypeError('withTenant requires a UUID tenant id');
  }
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}
