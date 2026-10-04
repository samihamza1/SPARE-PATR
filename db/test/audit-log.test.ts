import { newId } from '@autoparts/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src';
import { SQLSTATE, appDb, createTenant, createUser, ownerDb } from './helpers';

const owner = ownerDb();
const app = appDb();

let tenant: string;
let actor: string;
let entryId: string;

beforeAll(async () => {
  tenant = await createTenant(owner);
  actor = await createUser(owner, tenant, 'auditor');
  entryId = newId();
  await withTenant(app, tenant, (trx) =>
    trx
      .insertInto('audit_log')
      .values({
        id: entryId,
        tenant_id: tenant,
        actor_user_id: actor,
        action: 'price.change',
        entity_type: 'product',
        entity_id: newId(),
        before: JSON.stringify({ price: '10.00' }),
        after: JSON.stringify({ price: '12.50' }),
        reason: 'supplier increase',
      })
      .execute(),
  );
});

afterAll(async () => {
  await app.destroy();
  await owner.destroy();
});

describe('audit_log is append-only', () => {
  it('lets the app role insert and read entries', async () => {
    const rows = await withTenant(app, tenant, (trx) =>
      trx.selectFrom('audit_log').select(['id', 'action', 'after']).execute(),
    );
    expect(rows).toEqual([{ id: entryId, action: 'price.change', after: { price: '12.50' } }]);
  });

  it('denies UPDATE and DELETE to the app role', async () => {
    await expect(
      withTenant(app, tenant, (trx) =>
        trx.updateTable('audit_log').set({ reason: 'edited' }).execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
    await expect(
      withTenant(app, tenant, (trx) => trx.deleteFrom('audit_log').execute()),
    ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
  });

  it('rejects UPDATE, DELETE and TRUNCATE even from the owner role', async () => {
    await expect(
      withTenant(owner, tenant, (trx) =>
        trx.updateTable('audit_log').set({ reason: 'edited' }).execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.raiseException });
    await expect(
      withTenant(owner, tenant, (trx) => trx.deleteFrom('audit_log').execute()),
    ).rejects.toMatchObject({ code: SQLSTATE.raiseException });
    await expect(sql`TRUNCATE audit_log`.execute(owner)).rejects.toMatchObject({
      code: SQLSTATE.raiseException,
    });
  });

  it('validates the action format', async () => {
    await expect(
      withTenant(app, tenant, (trx) =>
        trx
          .insertInto('audit_log')
          .values({
            id: newId(),
            tenant_id: tenant,
            action: 'Price Change',
            entity_type: 'product',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
  });
});
