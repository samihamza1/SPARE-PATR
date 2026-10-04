import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { ownerDb } from './helpers';

/**
 * Catalog-level guard for invariant 4. Every new table must either be tenant-scoped with
 * forced RLS, or be listed here explicitly as global. This test fails for any table that
 * is neither, so a forgotten policy cannot reach production.
 */
const GLOBAL_TABLES = new Set(['schema_migrations']);

/** Invariant 3: the app role may never UPDATE or DELETE these (journal/stock tables join later). */
const APPEND_ONLY_TABLES = ['audit_log'];

const APP_ROLE = 'autoparts_app';

const db = ownerDb();
afterAll(() => db.destroy());

interface TableRow {
  schema: string;
  table: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  has_tenant_id: boolean;
  owner: string;
}

async function userTables(): Promise<TableRow[]> {
  const { rows } = await sql<TableRow>`
    SELECT n.nspname AS schema,
           c.relname AS table,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           EXISTS (SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
             AS has_tenant_id,
           pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_%'
    ORDER BY 1, 2`.execute(db);
  return rows;
}

interface PolicyRow {
  table: string;
  permissive: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

async function policies(): Promise<PolicyRow[]> {
  const { rows } = await sql<PolicyRow>`
    SELECT tablename AS table, permissive, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = 'public'`.execute(db);
  return rows;
}

const TENANT_PREDICATE = 'current_tenant_id()';

describe('tenant isolation catalog (invariant 4)', () => {
  it('finds the expected tables (sanity check for the queries below)', async () => {
    const names = (await userTables()).map((t) => t.table);
    expect(names).toEqual(
      expect.arrayContaining(['tenants', 'users', 'roles', 'user_roles', 'audit_log']),
    );
  });

  it('keeps every table in the public schema', async () => {
    const elsewhere = (await userTables()).filter((t) => t.schema !== 'public');
    expect(elsewhere).toEqual([]);
  });

  it('classifies every table as tenant-scoped or explicitly global', async () => {
    const unclassified = (await userTables())
      .filter((t) => !t.has_tenant_id && t.table !== 'tenants' && !GLOBAL_TABLES.has(t.table))
      .map((t) => t.table);
    expect(unclassified, 'tables with no tenant_id that are not in GLOBAL_TABLES').toEqual([]);
  });

  it('enables and FORCEs row-level security on every tenant table', async () => {
    const offenders = (await userTables())
      .filter((t) => !GLOBAL_TABLES.has(t.table))
      .filter((t) => !t.rls_enabled || !t.rls_forced)
      .map((t) => t.table);
    expect(offenders, 'tenant tables without ENABLE + FORCE ROW LEVEL SECURITY').toEqual([]);
  });

  it('gives every tenant table an ALL-commands policy on current_tenant_id()', async () => {
    const all = await policies();
    const offenders = (await userTables())
      .filter((t) => !GLOBAL_TABLES.has(t.table))
      .filter(
        (t) =>
          !all.some(
            (p) =>
              p.table === t.table &&
              p.permissive === 'PERMISSIVE' &&
              p.cmd === 'ALL' &&
              p.qual?.includes(TENANT_PREDICATE) === true &&
              p.with_check?.includes(TENANT_PREDICATE) === true,
          ),
      )
      .map((t) => t.table);
    expect(offenders, 'tenant tables without a tenant policy').toEqual([]);
  });

  it('has no permissive policy that ignores the tenant (e.g. USING (true))', async () => {
    const leaky = (await policies()).filter(
      (p) =>
        p.permissive === 'PERMISSIVE' &&
        (p.qual?.includes(TENANT_PREDICATE) !== true ||
          (p.with_check !== null && !p.with_check.includes(TENANT_PREDICATE))),
    );
    expect(leaky).toEqual([]);
  });

  it('starts every multi-column index on a tenant table with tenant_id', async () => {
    const { rows } = await sql<{ index: string; first_column: string }>`
      SELECT i.indexrelid::regclass::text AS index, a.attname AS first_column
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
      WHERE n.nspname = 'public'
        AND i.indnkeyatts > 1
        AND EXISTS (SELECT 1 FROM pg_attribute t
                    WHERE t.attrelid = c.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped)`.execute(
      db,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.first_column !== 'tenant_id')).toEqual([]);
  });
});

describe('database roles', () => {
  it('the app role is not privileged', async () => {
    const { rows } = await sql<Record<string, boolean>>`
      SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
      FROM pg_roles WHERE rolname = ${APP_ROLE}`.execute(db);
    expect(rows).toEqual([
      { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false },
    ]);
  });

  it('the owner role is not a superuser and cannot bypass RLS', async () => {
    const { rows } = await sql<Record<string, boolean>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`.execute(db);
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it('the app role owns no table', async () => {
    const owned = (await userTables()).filter((t) => t.owner === APP_ROLE);
    expect(owned).toEqual([]);
  });

  it('the app role cannot DELETE or TRUNCATE anything (invariant 7)', async () => {
    const { rows } = await sql<{ table: string }>`
      SELECT c.relname AS table
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND (has_table_privilege(${APP_ROLE}, c.oid, 'DELETE')
             OR has_table_privilege(${APP_ROLE}, c.oid, 'TRUNCATE'))`.execute(db);
    expect(rows).toEqual([]);
  });

  it('the app role cannot UPDATE append-only tables (invariant 3)', async () => {
    for (const table of APPEND_ONLY_TABLES) {
      const { rows } = await sql<{ can_update: boolean }>`
        SELECT has_table_privilege(${APP_ROLE}, ${`public.${table}`}, 'UPDATE') AS can_update`.execute(
        db,
      );
      expect(rows, table).toEqual([{ can_update: false }]);
    }
  });

  it('append-only tables reject UPDATE, DELETE and TRUNCATE by trigger, for any role', async () => {
    for (const table of APPEND_ONLY_TABLES) {
      const { rows } = await sql<{ events: string[] }>`
        SELECT array_agg(DISTINCT e ORDER BY e) AS events
        FROM pg_trigger t
        CROSS JOIN LATERAL (VALUES
          (CASE WHEN t.tgtype & 16 <> 0 THEN 'UPDATE' END),
          (CASE WHEN t.tgtype & 8 <> 0 THEN 'DELETE' END),
          (CASE WHEN t.tgtype & 32 <> 0 THEN 'TRUNCATE' END)) AS v(e)
        WHERE t.tgrelid = ${`public.${table}`}::regclass
          AND t.tgfoid = 'forbid_mutation'::regproc
          AND e IS NOT NULL`.execute(db);
      expect(rows, table).toEqual([{ events: ['DELETE', 'TRUNCATE', 'UPDATE'] }]);
    }
  });

  it('the app role has no privileges on global tables', async () => {
    for (const table of GLOBAL_TABLES) {
      const { rows } = await sql<{ any_privilege: boolean }>`
        SELECT has_table_privilege(${APP_ROLE}, ${`public.${table}`},
          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS any_privilege`.execute(
        db,
      );
      expect(rows, table).toEqual([{ any_privilege: false }]);
    }
  });
});
