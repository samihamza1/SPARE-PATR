import { beforeAll, describe, expect, it } from 'vitest';

import { APP_ROLE, OWNER_ROLE } from '../src/config.js';
import { findTenancyViolations } from '../src/guard.js';
import { connect, urls } from './helpers.js';

const owner = connect(urls.ownerUrl);

describe('tenancy guard (CI fails if any tenant table lacks isolation)', () => {
  it('finds no violations in the migrated schema', async () => {
    expect(await findTenancyViolations(owner)).toEqual([]);
  });

  describe('self-test: the guard really fails', () => {
    // Each case builds a broken object inside a transaction that is rolled back.
    const cases: [string, string, RegExp][] = [
      [
        'tenant table without policy',
        'CREATE TABLE guard_probe (tenant_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (tenant_id, id))',
        /row level security is not enabled/,
      ],
      [
        'RLS enabled but not forced',
        `CREATE TABLE guard_probe (tenant_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (tenant_id, id));
         ALTER TABLE guard_probe ENABLE ROW LEVEL SECURITY;
         CREATE POLICY tenant_isolation ON guard_probe USING (tenant_id = current_tenant_id())
           WITH CHECK (tenant_id = current_tenant_id());`,
        /not forced/,
      ],
      [
        'forced RLS without any policy',
        `CREATE TABLE guard_probe (tenant_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (tenant_id, id));
         ALTER TABLE guard_probe ENABLE ROW LEVEL SECURITY;
         ALTER TABLE guard_probe FORCE ROW LEVEL SECURITY;`,
        /no FOR ALL policy/,
      ],
      [
        'an extra permissive policy that opens the table',
        `CREATE POLICY open_read ON users FOR SELECT USING (true)`,
        /permissive policy open_read USING does not isolate/,
      ],
      [
        'unclassified table without tenant_id',
        'CREATE TABLE guard_probe (id uuid PRIMARY KEY)',
        /not in GLOBAL_TABLES/,
      ],
      [
        'index not led by tenant_id',
        'CREATE INDEX guard_probe_idx ON users (username, tenant_id)',
        /index guard_probe_idx does not start with tenant_id/,
      ],
      [
        'foreign key between tenant tables without tenant_id',
        `CREATE TABLE guard_probe (tenant_id uuid NOT NULL, id uuid NOT NULL, user_id uuid,
            PRIMARY KEY (tenant_id, id));
         ALTER TABLE users ADD CONSTRAINT users_id_only UNIQUE (id);
         ALTER TABLE guard_probe ADD CONSTRAINT guard_probe_user_fk FOREIGN KEY (user_id) REFERENCES users (id);`,
        /foreign key guard_probe_user_fk does not include tenant_id/,
      ],
      [
        'view without security_invoker',
        'CREATE VIEW guard_probe_view AS SELECT id FROM users',
        /security_invoker/,
      ],
    ];

    it.each(cases)('%s', async (_label, ddl, expected) => {
      await owner.query('BEGIN');
      try {
        await owner.query(ddl);
        const problems = (await findTenancyViolations(owner)).map((v) => v.problem);
        expect(problems.some((p) => expected.test(p))).toBe(true);
      } finally {
        await owner.query('ROLLBACK');
      }
    });
  });
});

describe('database roles', () => {
  let roles: { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[];
  beforeAll(async () => {
    ({ rows: roles } = await owner.query(
      'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1)',
      [[APP_ROLE, OWNER_ROLE]],
    ));
  });

  it('app and owner roles are not superusers and cannot bypass RLS', () => {
    expect(roles).toHaveLength(2);
    for (const r of roles) {
      expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false });
    }
  });

  it('the app role has no DELETE or TRUNCATE on any table and owns nothing', async () => {
    const { rows } = await owner.query<{ table: string; privilege: string }>(
      `SELECT c.relname AS table, p.privilege
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest(ARRAY['DELETE', 'TRUNCATE']) AS p(privilege)
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND has_table_privilege($1, c.oid, p.privilege)`,
      [APP_ROLE],
    );
    expect(rows).toEqual([]);
    const { rows: owned } = await owner.query(
      `SELECT relname FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
      [APP_ROLE],
    );
    expect(owned).toEqual([]);
  });

  it('the app role cannot UPDATE the audit log or touch schema_migrations', async () => {
    const { rows } = await owner.query<{ update: boolean; migrations: boolean }>(
      `SELECT has_table_privilege($1, 'audit_log', 'UPDATE') AS update,
              has_table_privilege($1, 'schema_migrations', 'SELECT,INSERT,UPDATE,DELETE') AS migrations`,
      [APP_ROLE],
    );
    expect(rows[0]).toEqual({ update: false, migrations: false });
  });

  it('the app role cannot create objects in the public schema', async () => {
    const { rows } = await owner.query<{ create: boolean }>(
      `SELECT has_schema_privilege($1, 'public', 'CREATE') AS create`,
      [APP_ROLE],
    );
    expect(rows[0]?.create).toBe(false);
  });
});
