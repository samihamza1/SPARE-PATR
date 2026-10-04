import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import type { DB } from '../src/types.generated';
import { ownerDb } from './helpers';

/** A pool or an open transaction; checks run on either (self-tests use a rolled-back one). */
type Executor = Kysely<DB>;

/**
 * Catalog-level guard for invariant 4. Every new table must either be tenant-scoped with
 * forced RLS, or be listed here explicitly as global. This test fails for any table that
 * is neither, so a forgotten policy cannot reach production.
 */
/**
 * Shared tables mix platform rows (tenant_id IS NULL, readable by every tenant) with
 * tenant-local rows (ADR 0013). They get their own checks instead of the tenant ones.
 */
const SHARED_TABLES = new Set(['vehicles']);
const APP_ROLE_NAME = 'autoparts_app';
const OWNER_ROLE_NAME = 'autoparts_owner';

const GLOBAL_TABLES = new Set([
  'schema_migrations',
  // slug -> tenant id for login; unreadable by the app role (ADR 0008).
  'tenant_directory',
]);

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

async function userTables(exec: Executor = db): Promise<TableRow[]> {
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
    ORDER BY 1, 2`.execute(exec);
  return rows;
}

interface PolicyRow {
  table: string;
  name: string;
  roles: string[];
  permissive: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

async function policies(exec: Executor = db): Promise<PolicyRow[]> {
  const { rows } = await sql<PolicyRow>`
    SELECT tablename AS table, policyname AS name, roles::text[] AS roles, permissive, cmd, qual,
           with_check
    FROM pg_policies WHERE schemaname = 'public'`.execute(exec);
  return rows;
}

const TENANT_PREDICATE = 'current_tenant_id()';

// Each check returns its offenders; the tests below expect none, and the self-tests
// build a broken object in a rolled-back transaction and expect the check to flag it.

async function unclassifiedTables(exec: Executor = db): Promise<string[]> {
  return (await userTables(exec))
    .filter((t) => !t.has_tenant_id && t.table !== 'tenants' && !GLOBAL_TABLES.has(t.table))
    .map((t) => t.table);
}

async function tablesWithoutForcedRls(exec: Executor = db): Promise<string[]> {
  return (await userTables(exec))
    .filter((t) => !GLOBAL_TABLES.has(t.table))
    .filter((t) => !t.rls_enabled || !t.rls_forced)
    .map((t) => t.table);
}

async function tablesWithoutTenantPolicy(exec: Executor = db): Promise<string[]> {
  const all = await policies(exec);
  return (await userTables(exec))
    .filter((t) => !GLOBAL_TABLES.has(t.table) && !SHARED_TABLES.has(t.table))
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
}

async function leakyPolicies(exec: Executor = db): Promise<PolicyRow[]> {
  return (await policies(exec)).filter(
    (p) =>
      !SHARED_TABLES.has(p.table) &&
      p.permissive === 'PERMISSIVE' &&
      (p.qual?.includes(TENANT_PREDICATE) !== true ||
        (p.with_check !== null && !p.with_check.includes(TENANT_PREDICATE))),
  );
}

interface IndexRow {
  table: string;
  index: string;
  first_column: string;
}

async function multiColumnTenantIndexes(exec: Executor = db): Promise<IndexRow[]> {
  const { rows } = await sql<IndexRow>`
    SELECT c.relname AS table, i.indexrelid::regclass::text AS index, a.attname AS first_column
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
    WHERE n.nspname = 'public'
      AND i.indnkeyatts > 1
      AND EXISTS (SELECT 1 FROM pg_attribute t
                  WHERE t.attrelid = c.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped)`.execute(
    exec,
  );
  return rows.filter((r) => !SHARED_TABLES.has(r.table));
}

/**
 * Foreign keys between two tenant tables must match tenant_id on both sides. FK checks
 * bypass RLS, so a key on id alone would let a row point at another tenant's row.
 */
async function foreignKeysWithoutTenant(exec: Executor = db): Promise<string[]> {
  const { rows } = await sql<{ constraint: string }>`
    SELECT format('%s.%s', con.conrelid::regclass, con.conname) AS constraint
    FROM pg_constraint con
    JOIN pg_namespace n ON n.oid = con.connamespace
    WHERE con.contype = 'f' AND n.nspname = 'public'
      AND con.conrelid::regclass::text <> ALL (${[...SHARED_TABLES]}::text[])
      AND con.confrelid::regclass::text <> ALL (${[...SHARED_TABLES]}::text[])
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid
                  AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid
                  AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      AND NOT EXISTS (
        SELECT 1 FROM unnest(con.conkey, con.confkey) AS k(src, dst)
        JOIN pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = k.src
        JOIN pg_attribute da ON da.attrelid = con.confrelid AND da.attnum = k.dst
        WHERE sa.attname = 'tenant_id' AND da.attname = 'tenant_id')
    ORDER BY 1`.execute(exec);
  return rows.map((r) => r.constraint);
}

/**
 * Shared tables: the app role may read platform rows but must never write one, and any
 * broader policy is reserved for the owner role (operator tooling).
 */
async function sharedPolicyViolations(exec: Executor = db): Promise<string[]> {
  const problems: string[] = [];
  const all = await policies(exec);
  for (const table of SHARED_TABLES) {
    const own = all.filter((p) => p.table === table);
    if (own.length === 0) problems.push(`${table}: no policies`);
    for (const p of own) {
      const forApp = p.roles.includes('public') || p.roles.includes(APP_ROLE_NAME);
      if (!forApp) {
        if (p.roles.some((r) => r !== OWNER_ROLE_NAME)) {
          problems.push(`${table}.${p.name}: broad policy for ${p.roles.join(',')}`);
        }
        continue;
      }
      if (p.qual !== null && !p.qual.includes(TENANT_PREDICATE)) {
        problems.push(`${table}.${p.name}: USING ignores the tenant`);
      }
      if (
        p.with_check !== null &&
        (!p.with_check.includes(TENANT_PREDICATE) || /IS NULL/i.test(p.with_check))
      ) {
        problems.push(`${table}.${p.name}: WITH CHECK lets the app write platform rows`);
      }
      if (p.cmd !== 'SELECT' && p.with_check === null && p.cmd !== 'DELETE') {
        problems.push(`${table}.${p.name}: write policy without WITH CHECK`);
      }
    }
  }
  return problems;
}

/**
 * A tenant table cannot use a composite FK into a shared table (platform rows have no
 * tenant_id), so it needs a trigger checking the target is global or its own (ADR 0013).
 */
async function sharedReferencesWithoutVisibilityCheck(exec: Executor = db): Promise<string[]> {
  const { rows } = await sql<{ constraint: string }>`
    SELECT format('%s.%s', con.conrelid::regclass, con.conname) AS constraint
    FROM pg_constraint con
    WHERE con.contype = 'f'
      AND con.confrelid::regclass::text = ANY (${[...SHARED_TABLES]}::text[])
      AND con.conrelid <> con.confrelid
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
        WHERE t.tgrelid = con.conrelid AND NOT t.tgisinternal
          AND f.proname LIKE 'check_visible_%'
          AND t.tgtype & 2 <> 0   -- BEFORE
          AND t.tgtype & 4 <> 0)  -- INSERT
    ORDER BY 1`.execute(exec);
  return rows.map((r) => r.constraint);
}

/** Views run with their owner's rights unless security_invoker is set, which skips RLS checks for the caller. */
async function viewsWithoutSecurityInvoker(exec: Executor = db): Promise<string[]> {
  const { rows } = await sql<{ view: string }>`
    SELECT c.relname AS view
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('v', 'm')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_%'
      AND NOT coalesce(c.reloptions && ARRAY['security_invoker=true', 'security_invoker=on'], false)
    ORDER BY 1`.execute(exec);
  return rows.map((r) => r.view);
}

/**
 * SECURITY DEFINER functions run with the owner's rights; without a pinned search_path a
 * caller could shadow tables or operators with objects of its own.
 */
async function definersWithoutSearchPath(exec: Executor = db): Promise<string[]> {
  const { rows } = await sql<{ fn: string }>`
    SELECT p.oid::regprocedure::text AS fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef AND n.nspname = 'public'
      AND NOT coalesce(EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search\\_path=%'), false)
    ORDER BY 1`.execute(exec);
  return rows.map((r) => r.fn);
}

/** Invariant 5: every uuid `id` column must be checked to be a UUID v7 by the database. */
async function idsWithoutV7Check(exec: Executor = db): Promise<string[]> {
  const { rows } = await sql<{ table: string }>`
    SELECT c.relname AS table
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public'
      AND a.atttypid = 'uuid'::regtype
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint k
        WHERE k.conrelid = c.oid AND k.contype = 'c' AND k.convalidated
          AND pg_get_constraintdef(k.oid) LIKE '%is_uuid_v7(id)%')
    ORDER BY 1`.execute(exec);
  return rows.map((r) => r.table);
}

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
    expect(
      await unclassifiedTables(),
      'tables with no tenant_id that are not in GLOBAL_TABLES',
    ).toEqual([]);
  });

  it('enables and FORCEs row-level security on every tenant table', async () => {
    expect(
      await tablesWithoutForcedRls(),
      'tenant tables without ENABLE + FORCE ROW LEVEL SECURITY',
    ).toEqual([]);
  });

  it('gives every tenant table an ALL-commands policy on current_tenant_id()', async () => {
    expect(await tablesWithoutTenantPolicy(), 'tenant tables without a tenant policy').toEqual([]);
  });

  it('has no permissive policy that ignores the tenant (e.g. USING (true))', async () => {
    expect(await leakyPolicies()).toEqual([]);
  });

  it('starts every multi-column index on a tenant table with tenant_id', async () => {
    const rows = await multiColumnTenantIndexes();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.first_column !== 'tenant_id')).toEqual([]);
  });

  it('includes tenant_id in every foreign key between tenant tables', async () => {
    expect(await foreignKeysWithoutTenant()).toEqual([]);
  });

  it('creates every view with security_invoker', async () => {
    expect(await viewsWithoutSecurityInvoker()).toEqual([]);
  });

  it('pins search_path on every SECURITY DEFINER function', async () => {
    expect(await definersWithoutSearchPath()).toEqual([]);
  });

  it('keeps shared tables read-only for platform rows (ADR 0013)', async () => {
    expect(await sharedPolicyViolations()).toEqual([]);
  });

  it('guards every reference into a shared table with a visibility trigger', async () => {
    expect(await sharedReferencesWithoutVisibilityCheck()).toEqual([]);
  });

  it('checks that every uuid id is a UUID v7 (invariant 5)', async () => {
    expect(await idsWithoutV7Check()).toEqual([]);
  });
});

describe('tenant isolation catalog self-tests (each check can fail)', () => {
  class Rollback extends Error {}

  /** Apply `ddl` in a transaction, run `check` inside it, then roll everything back. */
  async function probe<T>(ddl: string, check: (trx: Executor) => Promise<T>): Promise<T> {
    let result: T | undefined;
    await db
      .transaction()
      .execute(async (trx) => {
        await sql.raw(ddl).execute(trx);
        result = await check(trx);
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
    return result as T;
  }

  const probeTable =
    'CREATE TABLE guard_probe (tenant_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (tenant_id, id));';

  it('flags a table with neither tenant_id nor a GLOBAL_TABLES entry', async () => {
    expect(
      await probe('CREATE TABLE guard_probe (id uuid PRIMARY KEY);', unclassifiedTables),
    ).toContain('guard_probe');
  });

  it('flags a tenant table without RLS, or with RLS enabled but not forced', async () => {
    expect(await probe(probeTable, tablesWithoutForcedRls)).toContain('guard_probe');
    expect(
      await probe(
        `${probeTable} ALTER TABLE guard_probe ENABLE ROW LEVEL SECURITY;`,
        tablesWithoutForcedRls,
      ),
    ).toContain('guard_probe');
  });

  it('flags a forced tenant table without a tenant policy', async () => {
    expect(
      await probe(
        `${probeTable} ALTER TABLE guard_probe ENABLE ROW LEVEL SECURITY;
         ALTER TABLE guard_probe FORCE ROW LEVEL SECURITY;`,
        tablesWithoutTenantPolicy,
      ),
    ).toContain('guard_probe');
  });

  it('flags an extra permissive policy that opens a table', async () => {
    const leaky = await probe(
      'CREATE POLICY open_read ON users FOR SELECT USING (true);',
      leakyPolicies,
    );
    expect(leaky.map((p) => p.table)).toContain('users');
  });

  it('flags a multi-column index that does not start with tenant_id', async () => {
    const rows = await probe(
      'CREATE INDEX guard_probe_idx ON users (username, tenant_id);',
      multiColumnTenantIndexes,
    );
    expect(rows).toContainEqual({
      table: 'users',
      index: 'guard_probe_idx',
      first_column: 'username',
    });
  });

  it('flags a foreign key between tenant tables that skips tenant_id', async () => {
    expect(
      await probe(
        `ALTER TABLE users ADD CONSTRAINT guard_probe_users_id UNIQUE (id);
         CREATE TABLE guard_probe (tenant_id uuid NOT NULL, id uuid NOT NULL, user_id uuid,
           PRIMARY KEY (tenant_id, id),
           CONSTRAINT guard_probe_user_fk FOREIGN KEY (user_id) REFERENCES users (id));`,
        foreignKeysWithoutTenant,
      ),
    ).toEqual(['guard_probe.guard_probe_user_fk']);
  });

  it('flags a uuid id without a UUID v7 check, and accepts one with it', async () => {
    expect(await probe(probeTable, idsWithoutV7Check)).toContain('guard_probe');
    expect(
      await probe(
        `${probeTable} ALTER TABLE guard_probe ADD CHECK (is_uuid_v7(id));`,
        idsWithoutV7Check,
      ),
    ).not.toContain('guard_probe');
  });

  it('flags a shared-table policy that lets the app write platform rows', async () => {
    const problems = await probe(
      `CREATE POLICY loose_write ON vehicles FOR INSERT TO autoparts_app
         WITH CHECK (tenant_id IS NULL OR tenant_id = current_tenant_id());`,
      sharedPolicyViolations,
    );
    expect(problems).toContain('vehicles.loose_write: WITH CHECK lets the app write platform rows');
  });

  it('flags a reference into a shared table without a visibility trigger', async () => {
    expect(
      await probe(
        `CREATE TABLE guard_probe (tenant_id uuid NOT NULL, id uuid NOT NULL,
           vehicle_id uuid REFERENCES vehicles (id), PRIMARY KEY (tenant_id, id));`,
        sharedReferencesWithoutVisibilityCheck,
      ),
    ).toEqual(['guard_probe.guard_probe_vehicle_id_fkey']);
  });

  it('flags a SECURITY DEFINER function without a pinned search_path', async () => {
    expect(
      await probe(
        'CREATE FUNCTION guard_probe_fn() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;',
        definersWithoutSearchPath,
      ),
    ).toEqual(['guard_probe_fn()']);
  });

  it('flags a view without security_invoker, and accepts one with it', async () => {
    expect(
      await probe(
        'CREATE VIEW guard_probe_view AS SELECT id FROM users;',
        viewsWithoutSecurityInvoker,
      ),
    ).toEqual(['guard_probe_view']);
    expect(
      await probe(
        'CREATE VIEW guard_probe_view WITH (security_invoker = true) AS SELECT id FROM users;',
        viewsWithoutSecurityInvoker,
      ),
    ).toEqual([]);
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
