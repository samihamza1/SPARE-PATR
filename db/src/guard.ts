import type pg from 'pg';

/**
 * Tables that intentionally have no tenant_id. Adding a table here is a security
 * decision and must be justified in review.
 */
export const GLOBAL_TABLES: readonly string[] = ['public.schema_migrations'];

/** The tenant root table: isolated on its primary key instead of tenant_id. */
const TENANT_ROOT = 'public.tenants';

const TENANT_CALL = 'current_tenant_id()';

export interface Violation {
  table: string;
  problem: string;
}

type Queryable = Pick<pg.ClientBase, 'query'>;

interface TableRow {
  table: string;
  has_tenant_id: boolean;
  rls: boolean;
  force_rls: boolean;
}

interface PolicyRow {
  table: string;
  name: string;
  cmd: string;
  permissive: boolean;
  qual: string | null;
  with_check: string | null;
}

interface IndexRow {
  table: string;
  index: string;
  leading_column: string | null;
}

interface ForeignKeyRow {
  table: string;
  constraint: string;
  includes_tenant_id: boolean;
}

interface ViewRow {
  view: string;
  security_invoker: boolean;
}

const USER_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;

/**
 * Inspect the catalog and report every way a table could leak data across tenants.
 * Used by the CI test; returns an empty list when the schema is sound.
 */
export async function findTenancyViolations(db: Queryable): Promise<Violation[]> {
  const violations: Violation[] = [];
  const add = (table: string, problem: string) => violations.push({ table, problem });

  const { rows: tables } = await db.query<TableRow>(`
    SELECT format('%s.%s', n.nspname, c.relname) AS table,
           EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
                  ) AS has_tenant_id,
           c.relrowsecurity AS rls,
           c.relforcerowsecurity AS force_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND ${USER_SCHEMAS}
     ORDER BY 1`);

  const { rows: policies } = await db.query<PolicyRow>(`
    SELECT format('%s.%s', n.nspname, c.relname) AS table, p.polname AS name,
           p.polcmd::text AS cmd, p.polpermissive AS permissive,
           pg_get_expr(p.polqual, p.polrelid) AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace`);

  const tenantTables = new Set<string>();
  for (const t of tables) {
    const isTenantTable = t.has_tenant_id || t.table === TENANT_ROOT;
    if (!isTenantTable) {
      if (!GLOBAL_TABLES.includes(t.table)) {
        add(t.table, 'has no tenant_id and is not in GLOBAL_TABLES (classify it explicitly)');
      }
      continue;
    }
    tenantTables.add(t.table);
    if (!t.rls) add(t.table, 'row level security is not enabled');
    if (!t.force_rls) add(t.table, 'row level security is not forced (FORCE)');

    const key = t.table === TENANT_ROOT ? 'id' : 'tenant_id';
    const own = policies.filter((p) => p.table === t.table);
    const isolates = (expr: string | null) =>
      expr !== null && expr.includes(TENANT_CALL) && expr.includes(key);

    if (!own.some((p) => p.cmd === '*' && isolates(p.qual) && isolates(p.with_check))) {
      add(t.table, `no FOR ALL policy with USING and WITH CHECK on ${key} = ${TENANT_CALL}`);
    }
    // Permissive policies are OR-ed: a single loose one would open the table.
    for (const p of own.filter((p) => p.permissive)) {
      if (p.qual !== null && !isolates(p.qual)) {
        add(t.table, `permissive policy ${p.name} USING does not isolate by tenant`);
      }
      if (p.with_check !== null && !isolates(p.with_check)) {
        add(t.table, `permissive policy ${p.name} WITH CHECK does not isolate by tenant`);
      }
    }
  }

  const { rows: indexes } = await db.query<IndexRow>(`
    SELECT format('%s.%s', n.nspname, c.relname) AS table, ic.relname AS index,
           a.attname AS leading_column
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class ic ON ic.oid = i.indexrelid
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
     WHERE ${USER_SCHEMAS}`);
  for (const ix of indexes) {
    if (!tenantTables.has(ix.table) || ix.table === TENANT_ROOT) continue;
    if (ix.leading_column !== 'tenant_id') {
      add(ix.table, `index ${ix.index} does not start with tenant_id`);
    }
  }

  // A foreign key between two tenant tables must carry tenant_id on both sides,
  // so a row can never reference another tenant's row.
  const { rows: fks } = await db.query<ForeignKeyRow>(`
    SELECT format('%s.%s', n.nspname, c.relname) AS table, con.conname AS constraint,
           EXISTS (
             SELECT 1 FROM unnest(con.conkey, con.confkey) AS k(src, dst)
               JOIN pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = k.src
               JOIN pg_attribute da ON da.attrelid = con.confrelid AND da.attnum = k.dst
              WHERE sa.attname = 'tenant_id' AND da.attname = 'tenant_id'
           ) AS includes_tenant_id
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class fc ON fc.oid = con.confrelid
     WHERE con.contype = 'f' AND ${USER_SCHEMAS}
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = con.conrelid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = con.confrelid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
  for (const fk of fks) {
    if (!fk.includes_tenant_id)
      add(fk.table, `foreign key ${fk.constraint} does not include tenant_id`);
  }

  // Views run with their owner's privileges unless security_invoker is set.
  const { rows: views } = await db.query<ViewRow>(`
    SELECT format('%s.%s', n.nspname, c.relname) AS view,
           coalesce('security_invoker=true' = ANY (c.reloptions)
                 OR 'security_invoker=on' = ANY (c.reloptions), false) AS security_invoker
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('v', 'm') AND ${USER_SCHEMAS}`);
  for (const v of views) {
    if (!v.security_invoker) add(v.view, 'view must be created WITH (security_invoker = true)');
  }

  return violations;
}
