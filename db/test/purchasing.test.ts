import { readFileSync } from 'node:fs';
import { newId } from '@autoparts/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src';
import { SQLSTATE, appDb, createRole, createTenant, createUser, ownerDb } from './helpers';

const owner = ownerDb();
const app = appDb();

let tenant: string;
let other: string;
let user: string;
/** Any 32 bytes: these tests do not replay creates. */
const HASH = Buffer.alloc(32);

async function rejects(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'resolved';
}

async function newPart(tenantId: string): Promise<string> {
  const id = newId();
  const sku = `P-${id.slice(-8)}`;
  await withTenant(app, tenantId, (trx) =>
    trx.insertInto('parts').values({ id, tenant_id: tenantId, sku, name_en: sku }).execute(),
  );
  return id;
}

async function newSupplier(tenantId: string, name = `S ${newId().slice(-8)}`): Promise<string> {
  const id = newId();
  await withTenant(app, tenantId, (trx) =>
    trx
      .insertInto('suppliers')
      .values({ id, tenant_id: tenantId, name, request_hash: HASH })
      .execute(),
  );
  return id;
}

function mapNumber(supplierId: string, partId: string, number: string, id = newId()) {
  return withTenant(app, tenant, (trx) =>
    trx
      .insertInto('supplier_parts')
      .values({
        id,
        tenant_id: tenant,
        supplier_id: supplierId,
        part_id: partId,
        number,
        created_by: user,
        request_hash: HASH,
      })
      .execute(),
  );
}

beforeAll(async () => {
  tenant = await createTenant(owner);
  other = await createTenant(owner);
  user = await createUser(owner, tenant);
});

afterAll(async () => {
  await owner.destroy();
  await app.destroy();
});

describe('suppliers', () => {
  it('keep active names distinct per tenant, after normalisation', async () => {
    await newSupplier(tenant, 'Gulf Parts');
    expect(await rejects(newSupplier(tenant, ' gulf  PARTS'))).toBe(SQLSTATE.uniqueViolation);
    // Another tenant may use the same name.
    expect(await rejects(newSupplier(other, 'Gulf Parts'))).toBe('resolved');
  });

  it('are invisible to other tenants', async () => {
    const id = await newSupplier(tenant);
    const seen = await withTenant(app, other, (trx) =>
      trx.selectFrom('suppliers').select('id').where('id', '=', id).execute(),
    );
    expect(seen).toEqual([]);
  });

  it('need a tenant currency as default', async () => {
    const res = rejects(
      withTenant(app, tenant, (trx) =>
        trx
          .insertInto('suppliers')
          .values({
            id: newId(),
            tenant_id: tenant,
            name: 'Money',
            default_currency: 'ZZZ',
            request_hash: HASH,
          })
          .execute(),
      ),
    );
    expect(await res).toBe(SQLSTATE.foreignKeyViolation);
  });

  it('cannot be deleted by the app', async () => {
    const id = await newSupplier(tenant);
    const res = rejects(
      withTenant(app, tenant, (trx) => trx.deleteFrom('suppliers').where('id', '=', id).execute()),
    );
    expect(await res).toBe(SQLSTATE.insufficientPrivilege);
  });
});

describe('supplier part numbers', () => {
  it('map one active number to one part per supplier, whatever the spelling', async () => {
    const supplier = await newSupplier(tenant);
    const a = await newPart(tenant);
    const b = await newPart(tenant);
    await mapNumber(supplier, a, 'GP-0042');
    expect(await rejects(mapNumber(supplier, b, 'gp 0042'))).toBe(SQLSTATE.uniqueViolation);
    // Another supplier may print the same number for another part.
    const second = await newSupplier(tenant);
    expect(await rejects(mapNumber(second, b, 'GP-0042'))).toBe('resolved');
    // A part may carry several numbers from one supplier.
    expect(await rejects(mapNumber(supplier, a, 'GP-0043'))).toBe('resolved');
  });

  it('refuse a number made only of separators', async () => {
    const supplier = await newSupplier(tenant);
    const part = await newPart(tenant);
    expect(await rejects(mapNumber(supplier, part, ' -/. '))).toBe(SQLSTATE.checkViolation);
  });

  it('stay removed once removed, which frees the number', async () => {
    const supplier = await newSupplier(tenant);
    const a = await newPart(tenant);
    const b = await newPart(tenant);
    const id = newId();
    await mapNumber(supplier, a, 'RM-1', id);
    const remove = (removedAt: Date | null, removedBy: string | null) =>
      withTenant(app, tenant, (trx) =>
        trx
          .updateTable('supplier_parts')
          .set({ removed_at: removedAt, removed_by: removedBy })
          .where('id', '=', id)
          .execute(),
      );
    // Both removal columns are set together.
    expect(await rejects(remove(new Date(), null))).toBe(SQLSTATE.checkViolation);
    await remove(new Date(), user);
    expect(await rejects(remove(null, null))).toBe(SQLSTATE.checkViolation);
    expect(await rejects(mapNumber(supplier, b, 'RM-1'))).toBe('resolved');
  });

  it('only let the app change the removal columns', async () => {
    const supplier = await newSupplier(tenant);
    const part = await newPart(tenant);
    const id = newId();
    await mapNumber(supplier, part, 'FX-1', id);
    const res = rejects(
      withTenant(app, tenant, (trx) =>
        trx.updateTable('supplier_parts').set({ number: 'FX-2' }).where('id', '=', id).execute(),
      ),
    );
    expect(await res).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('point only at parts and suppliers of the same tenant', async () => {
    const supplier = await newSupplier(tenant);
    const foreignPart = await newPart(other);
    expect(await rejects(mapNumber(supplier, foreignPart, 'XT-1'))).toBe(
      SQLSTATE.foreignKeyViolation,
    );
  });
});

describe('purchasing permissions data migration', () => {
  it("adds purchasing to existing tenants' system roles as agreed", async () => {
    const t = await createTenant(owner);
    const roles = {
      owner: await createRole(owner, t, 'owner'),
      supervisor: await createRole(owner, t, 'supervisor'),
      accountant: await createRole(owner, t, 'accountant'),
      cashier: await createRole(owner, t, 'cashier'),
      custom: await createRole(owner, t, 'buyer'),
    };
    await withTenant(owner, t, (trx) =>
      trx
        .updateTable('roles')
        .set({ is_system: sql`code <> 'buyer'`, permissions: ['audit.read'] })
        .execute(),
    );
    const file = new URL(
      '../migrations/20261017082627_purchasing_permissions.sql',
      import.meta.url,
    );
    const up = readFileSync(file, 'utf8').split('-- migrate:down')[0] ?? '';
    await owner.transaction().execute((trx) => sql.raw(up).execute(trx));

    const after = await withTenant(owner, t, (trx) =>
      trx.selectFrom('roles').select(['id', 'permissions']).execute(),
    );
    const of = (id: string) => after.find((r) => r.id === id)?.permissions;
    expect(of(roles.owner)).toEqual([
      'audit.read',
      'purchases.manage',
      'purchases.post',
      'purchases.view',
      'stock.revalue',
    ]);
    expect(of(roles.supervisor)).toEqual([
      'audit.read',
      'purchases.manage',
      'purchases.post',
      'purchases.view',
    ]);
    expect(of(roles.accountant)).toEqual(['audit.read', 'purchases.view']);
    expect(of(roles.cashier)).toEqual(['audit.read']);
    expect(of(roles.custom)).toEqual(['audit.read']);
  });
});
