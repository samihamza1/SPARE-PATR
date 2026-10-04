import { beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@autoparts/shared/ids';

import { connect, errorCode, inTenant, seedTenant, urls } from './helpers.js';
import type { SeededTenant } from './helpers.js';

const owner = connect(urls.ownerUrl);
const app = connect(urls.appUrl);

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';

let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  a = await seedTenant(owner, `tenant-a-${Date.now().toString()}`);
  b = await seedTenant(owner, `tenant-b-${Date.now().toString()}`);
});

const selectIds = async (table: string): Promise<string[]> =>
  (await app.query<{ id: string }>(`SELECT id FROM ${table}`)).rows.map((r) => r.id).sort();

describe('row level security (app role)', () => {
  it('sees only its own tenant rows', async () => {
    await inTenant(app, a.tenantId, async () => {
      expect(await selectIds('tenants')).toEqual([a.tenantId]);
      expect(await selectIds('users')).toEqual([a.userId]);
      expect(await selectIds('roles')).toEqual([a.roleId]);
    });
  });

  it('sees nothing when no tenant is set (fail closed)', async () => {
    await inTenant(app, null, async () => {
      for (const table of ['tenants', 'users', 'roles', 'user_roles', 'audit_log']) {
        const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0]).toEqual({ n: 0 });
      }
    });
  });

  it('cannot update another tenant row', async () => {
    await inTenant(app, a.tenantId, async () => {
      const result = await app.query("UPDATE users SET display_name = 'x' WHERE id = $1", [
        b.userId,
      ]);
      expect(result.rowCount).toBe(0);
    });
  });

  it('cannot insert a row for another tenant', async () => {
    await inTenant(app, a.tenantId, async () => {
      const code = await errorCode(
        app.query(
          `INSERT INTO users (tenant_id, id, username, display_name) VALUES ($1, $2, 'intruder', 'X')`,
          [b.tenantId, newId()],
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it('cannot move a row to another tenant', async () => {
    await inTenant(app, a.tenantId, async () => {
      const code = await errorCode(
        app.query('UPDATE users SET tenant_id = $1 WHERE id = $2', [b.tenantId, a.userId]),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it('cannot reference another tenant row through a foreign key', async () => {
    await inTenant(app, a.tenantId, async () => {
      const code = await errorCode(
        app.query(
          'INSERT INTO user_roles (tenant_id, id, user_id, role_id) VALUES ($1, $2, $3, $4)',
          [a.tenantId, newId(), a.userId, b.roleId],
        ),
      );
      expect(code).toBe(FOREIGN_KEY_VIOLATION);
    });
  });

  it('cannot DELETE (no hard deletes) or change tenant configuration columns', async () => {
    await inTenant(app, a.tenantId, async () => {
      expect(await errorCode(app.query('DELETE FROM users'))).toBe(INSUFFICIENT_PRIVILEGE);
    });
    await inTenant(app, a.tenantId, async () => {
      expect(await errorCode(app.query("UPDATE tenants SET functional_currency = 'XXX'"))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });

  it('can do normal work inside its tenant', async () => {
    await inTenant(app, a.tenantId, async () => {
      await app.query(
        'INSERT INTO user_roles (tenant_id, id, user_id, role_id, granted_by) VALUES ($1, $2, $3, $4, $3)',
        [a.tenantId, newId(), a.userId, a.roleId],
      );
      await app.query("UPDATE tenants SET name = 'Renamed'");
      const { rows } = await app.query('SELECT count(*)::int AS n FROM user_roles');
      expect(rows[0]).toEqual({ n: 1 });
    });
  });

  it('does not leak the tenant setting past the transaction', async () => {
    await inTenant(app, a.tenantId, () => Promise.resolve(), { commit: true });
    const { rows } = await app.query(
      "SELECT coalesce(current_setting('app.tenant_id', true), '') AS tenant",
    );
    expect(rows[0]).toEqual({ tenant: '' });
    expect((await app.query('SELECT count(*)::int AS n FROM users')).rows[0]).toEqual({ n: 0 });
  });

  it('rejects a malformed tenant setting instead of matching anything', async () => {
    await expect(
      inTenant(app, 'not-a-uuid', () => app.query('SELECT * FROM users')),
    ).rejects.toThrow(/invalid input syntax for type uuid/);
  });
});

describe('data integrity', () => {
  it('rejects ids that are not UUID v7', async () => {
    await inTenant(app, a.tenantId, async () => {
      const code = await errorCode(
        app.query(
          `INSERT INTO roles (tenant_id, id, code, name)
           VALUES ($1, '3f2c8e1a-5b6d-4c7e-8f90-123456789abc', 'v4', 'V4')`,
          [a.tenantId],
        ),
      );
      expect(code).toBe(CHECK_VIOLATION);
    });
  });

  it('rejects unknown time zones', async () => {
    const id = newId();
    const code = await errorCode(
      inTenant(owner, id, () =>
        owner.query(
          `INSERT INTO tenants (id, name, slug, timezone, functional_currency, default_locale)
           VALUES ($1, 'T', $2, 'Mars/Olympus', 'XTS', 'ar')`,
          [id, `tz-${id}`],
        ),
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('keeps deactivation consistent', async () => {
    await inTenant(app, a.tenantId, async () => {
      const code = await errorCode(
        app.query('UPDATE users SET is_active = false WHERE id = $1', [a.userId]),
      );
      expect(code).toBe(CHECK_VIOLATION);
    });
    await inTenant(app, a.tenantId, async () => {
      const result = await app.query(
        'UPDATE users SET is_active = false, deactivated_at = now() WHERE id = $1',
        [a.userId],
      );
      expect(result.rowCount).toBe(1);
    });
  });
});

describe('audit_log is append-only', () => {
  const insertAudit = (tenantId: string, actor: string) =>
    app.query(
      `INSERT INTO audit_log (tenant_id, id, actor_user_id, action, entity_type, entity_id, before, after, reason)
       VALUES ($1, $2, $3, 'price.change', 'product', $4, '{"price":"10.00"}', '{"price":"12.00"}', 'test')`,
      [tenantId, newId(), actor, newId()],
    );

  it('accepts inserts from the app role', async () => {
    await inTenant(app, a.tenantId, () => insertAudit(a.tenantId, a.userId), { commit: true });
  });

  it('denies UPDATE and DELETE to the app role', async () => {
    await inTenant(app, a.tenantId, async () => {
      expect(await errorCode(app.query("UPDATE audit_log SET reason = 'x'"))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
    await inTenant(app, a.tenantId, async () => {
      expect(await errorCode(app.query('DELETE FROM audit_log'))).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it('blocks UPDATE, DELETE and TRUNCATE even for the owner', async () => {
    for (const statement of [
      "UPDATE audit_log SET reason = 'x'",
      'DELETE FROM audit_log',
      'TRUNCATE audit_log',
    ]) {
      const code = await errorCode(inTenant(owner, a.tenantId, () => owner.query(statement)));
      expect(code).toBe(RESTRICT_VIOLATION);
    }
  });

  it('cannot attribute an entry to another tenant user', async () => {
    const code = await errorCode(
      inTenant(app, a.tenantId, () => insertAudit(a.tenantId, b.userId)),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });
});
