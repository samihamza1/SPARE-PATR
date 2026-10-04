import { randomBytes } from 'node:crypto';
import { newId } from '@autoparts/shared';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src';
import type { DB } from '../src/types.generated';
import { SQLSTATE, appDb, createTenant, createUser, ownerDb } from './helpers';

const owner = ownerDb();
const app = appDb(1);

let tenantA: string;
let tenantB: string;
let userA: string;
let globalModel: string;
let localA: string;
let localB: string;

/** Platform rows are written by the owner role (operator tooling), not by tenants. */
async function globalVehicle(db: Kysely<DB>, level: string, name: string, parentId: string | null) {
  const id = newId();
  await db
    .transaction()
    .execute((trx) =>
      trx
        .insertInto('vehicles')
        .values({ id, tenant_id: null, parent_id: parentId, level, name })
        .execute(),
    );
  return id;
}

async function part(tenantId: string, sku: string, nameEn = sku) {
  const id = newId();
  await withTenant(app, tenantId, (trx) =>
    trx.insertInto('parts').values({ id, tenant_id: tenantId, sku, name_en: nameEn }).execute(),
  );
  return id;
}

beforeAll(async () => {
  tenantA = await createTenant(owner);
  tenantB = await createTenant(owner);
  userA = await createUser(owner, tenantA, 'cat-user');
  const type = await globalVehicle(owner, 'type', `Car ${newId().slice(-6)}`, null);
  const make = await globalVehicle(owner, 'make', 'Toyota', type);
  globalModel = await globalVehicle(owner, 'model', 'Land Cruiser', make);
  localA = newId();
  localB = newId();
  await withTenant(app, tenantA, (trx) =>
    trx
      .insertInto('vehicles')
      .values({
        id: localA,
        tenant_id: tenantA,
        parent_id: globalModel,
        level: 'generation',
        name: 'LC79 (A)',
        year_from: 2007,
      })
      .execute(),
  );
  await withTenant(app, tenantB, (trx) =>
    trx
      .insertInto('vehicles')
      .values({
        id: localB,
        tenant_id: tenantB,
        parent_id: globalModel,
        level: 'generation',
        name: 'LC79 (B)',
      })
      .execute(),
  );
});

afterAll(async () => {
  await app.destroy();
  await owner.destroy();
});

describe('shared vehicle tree', () => {
  it('shows platform rows and own local rows, never another tenant local rows', async () => {
    const ids = await withTenant(app, tenantA, (trx) =>
      trx
        .selectFrom('vehicles')
        .select('id')
        .where('id', 'in', [globalModel, localA, localB])
        .execute(),
    );
    expect(ids.map((r) => r.id).sort()).toEqual([globalModel, localA].sort());
  });

  it('does not let a tenant create or change platform rows', async () => {
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx
          .insertInto('vehicles')
          .values({
            id: newId(),
            tenant_id: null,
            parent_id: globalModel,
            level: 'generation',
            name: 'Fake',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
    const [res] = await withTenant(app, tenantA, (trx) =>
      trx.updateTable('vehicles').set({ name: 'Hacked' }).where('id', '=', globalModel).execute(),
    );
    expect(res?.numUpdatedRows).toBe(0n);
  });

  it('enforces the level order and parent visibility', async () => {
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx
          .insertInto('vehicles')
          .values({
            id: newId(),
            tenant_id: tenantA,
            parent_id: globalModel,
            level: 'engine',
            name: '1VD',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx
          .insertInto('vehicles')
          .values({
            id: newId(),
            tenant_id: tenantA,
            parent_id: localB,
            level: 'engine',
            name: '1VD',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.foreignKeyViolation });
  });

  it('lets fitments point at platform rows or own rows, not another tenant rows', async () => {
    const p = await part(tenantA, `FIT-${newId().slice(-6)}`);
    const fit = (vehicleId: string) =>
      withTenant(app, tenantA, (trx) =>
        trx
          .insertInto('fitments')
          .values({ id: newId(), tenant_id: tenantA, part_id: p, vehicle_id: vehicleId })
          .execute(),
      );
    await fit(globalModel);
    await fit(localA);
    await expect(fit(localB)).rejects.toMatchObject({ code: SQLSTATE.foreignKeyViolation });
  });
});

describe('parts and numbers', () => {
  it('normalises search text and part numbers in generated columns', async () => {
    const id = newId();
    await withTenant(app, tenantA, async (trx) => {
      await trx
        .insertInto('parts')
        .values({
          id,
          tenant_id: tenantA,
          sku: `N-${newId().slice(-6)}`,
          name_en: 'Filter , Oil',
          name_ar: 'فِلْتَر زيتٍ',
        })
        .execute();
      await trx
        .insertInto('part_numbers')
        .values({
          id: newId(),
          tenant_id: tenantA,
          part_id: id,
          number: '90915- yzzd2',
          kind: 'oem',
        })
        .execute();
    });
    const row = await withTenant(app, tenantA, (trx) =>
      trx
        .selectFrom('parts as p')
        .innerJoin('part_numbers as n', 'n.part_id', 'p.id')
        .select(['p.search_text', 'n.number_norm'])
        .where('p.id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    expect(row.search_text).toContain('فلتر زيت');
    expect(row.search_text).toContain('filter oil');
    expect(row.number_norm).toBe('90915YZZD2');
  });

  it('allows the same OEM number on several parts (alternatives), once per part', async () => {
    const a = await part(tenantA, `ALT-A-${newId().slice(-6)}`);
    const b = await part(tenantA, `ALT-B-${newId().slice(-6)}`);
    const add = (partId: string, number: string) =>
      withTenant(app, tenantA, (trx) =>
        trx
          .insertInto('part_numbers')
          .values({ id: newId(), tenant_id: tenantA, part_id: partId, number, kind: 'oem' })
          .execute(),
      );
    await add(a, '04465-60280');
    await add(b, '0446560280');
    await expect(add(a, '04465 60280')).rejects.toMatchObject({ code: '23505' });
  });

  it('keeps SKUs unique per tenant regardless of case, but not across tenants', async () => {
    const sku = `DUP-${newId().slice(-6)}`;
    await part(tenantA, sku);
    await expect(part(tenantA, sku.toLowerCase())).rejects.toMatchObject({ code: '23505' });
    await part(tenantB, sku);
  });

  it('refuses supersession cycles', async () => {
    const [x, y, z] = [
      await part(tenantA, `S1-${newId().slice(-6)}`),
      await part(tenantA, `S2-${newId().slice(-6)}`),
      await part(tenantA, `S3-${newId().slice(-6)}`),
    ];
    const supersede = (oldId: string, newIdValue: string) =>
      withTenant(app, tenantA, (trx) =>
        trx
          .insertInto('supersessions')
          .values({
            id: newId(),
            tenant_id: tenantA,
            old_part_id: oldId,
            new_part_id: newIdValue,
            effective_at: new Date(),
            created_by: userA,
          })
          .execute(),
      );
    await supersede(x, y);
    await supersede(y, z);
    await expect(supersede(z, x)).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
  });

  it('cannot delete catalog rows (no hard deletes)', async () => {
    await expect(
      withTenant(app, tenantA, (trx) => trx.deleteFrom('parts').execute()),
    ).rejects.toMatchObject({
      code: SQLSTATE.insufficientPrivilege,
    });
  });
});

describe('prices', () => {
  let listId: string;
  let partId: string;

  beforeAll(async () => {
    listId = newId();
    partId = await part(tenantA, `PR-${newId().slice(-6)}`);
    await withTenant(app, tenantA, (trx) =>
      trx
        .insertInto('price_lists')
        .values({
          id: listId,
          tenant_id: tenantA,
          name: 'Retail',
          currency: 'AAA',
          is_default: true,
        })
        .execute(),
    );
  });

  const price = (value: string) =>
    withTenant(app, tenantA, (trx) =>
      trx
        .insertInto('part_prices')
        .values({
          id: newId(),
          tenant_id: tenantA,
          price_list_id: listId,
          part_id: partId,
          price: value,
          effective_at: new Date(),
          source: 'manual',
          recorded_by: userA,
        })
        .execute(),
    );

  it('records price changes as new rows and never edits history', async () => {
    await price('10.50');
    await price('12.00');
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx.updateTable('part_prices').set({ price: '1' }).execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
    await expect(
      withTenant(owner, tenantA, (trx) =>
        trx.updateTable('part_prices').set({ price: '1' }).execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.raiseException });
  });

  it('refuses more decimals than the list currency allows (2 for the test currency)', async () => {
    await expect(price('1.005')).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
  });

  it('allows one default list per currency', async () => {
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx
          .insertInto('price_lists')
          .values({
            id: newId(),
            tenant_id: tenantA,
            name: 'Other',
            currency: 'AAA',
            is_default: true,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('only accepts tenant currencies', async () => {
    await expect(
      withTenant(app, tenantA, (trx) =>
        trx
          .insertInto('price_lists')
          .values({ id: newId(), tenant_id: tenantA, name: 'Foreign', currency: 'ZZZ' })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.foreignKeyViolation });
  });
});

describe('import batches', () => {
  it('applies the same file and sheet at most once', async () => {
    const sha = randomBytes(32);
    const batch = (status: 'applied' | 'draft') =>
      withTenant(app, tenantA, (trx) =>
        trx
          .insertInto('import_batches')
          .values({
            id: newId(),
            tenant_id: tenantA,
            kind: 'catalog',
            file_name: 'stock.xlsx',
            file_sha256: sha,
            sheet_name: 'LAND',
            created_by: userA,
            status,
            ...(status === 'applied' && { applied_at: new Date(), applied_by: userA }),
          })
          .execute(),
      );
    await batch('applied');
    await batch('draft');
    await expect(batch('applied')).rejects.toMatchObject({ code: '23505' });
  });
});
