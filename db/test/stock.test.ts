import type { CostState } from '@autoparts/shared';
import { EMPTY_COST_STATE, dec, issueCost, newId, receiveCost } from '@autoparts/shared';
import fc from 'fast-check';
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src';
import type { DB } from '../src/types.generated';
import { SQLSTATE, appDb, createTenant, createUser, ownerDb } from './helpers';

const owner = ownerDb();
const app = appDb(4);
const ctx = { spec: { code: 'AAA', minorUnits: 2 }, mode: 'HALF_UP' as const };

/** SQLSTATEs raised by the stock triggers (ADR 0019). */
const STOCK = {
  concurrentChange: '40001',
  insufficient: 'ST001',
  inactiveLocation: 'ST002',
  hasStock: 'ST003',
} as const;

let tenant: string;
let user: string;
let shop: string;
let store: string;

async function rejects(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'resolved';
}

async function newPart(tenantId: string, sku = `P-${newId().slice(-8)}`): Promise<string> {
  const id = newId();
  await withTenant(app, tenantId, (trx) =>
    trx.insertInto('parts').values({ id, tenant_id: tenantId, sku, name_en: sku }).execute(),
  );
  return id;
}

async function newLocation(
  tenantId: string,
  name: string,
  kind: 'shop' | 'warehouse',
  isDefault = false,
): Promise<string> {
  const id = newId();
  await withTenant(app, tenantId, (trx) =>
    trx
      .insertInto('locations')
      .values({ id, tenant_id: tenantId, name, kind, is_default: isDefault })
      .execute(),
  );
  return id;
}

async function lockCosts(trx: Transaction<DB>, partIds: string[]): Promise<Map<string, CostState>> {
  const { rows } = await sql<{
    part_id: string;
    quantity: number;
    value: string;
    ref_quantity: number | null;
    ref_value: string | null;
  }>`SELECT * FROM lock_stock_costs(${partIds}::uuid[])`.execute(trx);
  return new Map(
    rows.map((r) => [
      r.part_id,
      { quantity: r.quantity, value: r.value, refQuantity: r.ref_quantity, refValue: r.ref_value },
    ]),
  );
}

async function balance(trx: Transaction<DB>, partId: string, locationId: string): Promise<number> {
  const row = await trx
    .selectFrom('stock_balances')
    .select('quantity')
    .where('part_id', '=', partId)
    .where('location_id', '=', locationId)
    .executeTakeFirst();
  return row?.quantity ?? 0;
}

async function newDocument(
  trx: Transaction<DB>,
  tenantId: string,
  kind = 'adjustment',
  origin: 'online' | 'offline' = 'online',
  deviceId: string | null = null,
): Promise<string> {
  const id = newId();
  await trx
    .insertInto('stock_documents')
    .values({
      id,
      tenant_id: tenantId,
      kind,
      request_hash: Buffer.alloc(32, 1),
      occurred_at: new Date(),
      origin,
      device_id: deviceId,
      posted_by: user,
    })
    .execute();
  return id;
}

interface MoveInput {
  partId: string;
  locationId: string | null;
  kind: string;
  quantity: number;
  functionalAmount: string;
  before: CostState;
  prevLocation: number | null;
  documentId: string;
  lineNo?: number;
  reason?: string | null;
  costKnown?: boolean;
}

function moveRow(tenantId: string, m: MoveInput) {
  return {
    id: newId(),
    tenant_id: tenantId,
    part_id: m.partId,
    location_id: m.locationId,
    kind: m.kind,
    quantity: m.quantity,
    amount: m.functionalAmount,
    currency: 'AAA',
    fx_rate: '1',
    fx_base: 'AAA',
    fx_quote: 'AAA',
    functional_amount: m.functionalAmount,
    cost_known: m.costKnown ?? true,
    prev_part_quantity: m.before.quantity,
    prev_part_value: m.before.value,
    prev_location_quantity: m.prevLocation,
    document_id: m.documentId,
    line_no: m.lineNo ?? 0,
    reason: m.reason ?? null,
    occurred_at: new Date(),
  };
}

/**
 * Receives into a location the way the API engine does: lock, compute, insert. A receipt
 * that covers units sold below zero first posts their cost true-up (ADR 0020), so every
 * intermediate state stays consistent.
 */
async function receive(
  tenantId: string,
  partId: string,
  locationId: string,
  qty: number,
  value: string,
) {
  await withTenant(app, tenantId, async (trx) => {
    const before = (await lockCosts(trx, [partId])).get(partId) ?? EMPTY_COST_STATE;
    const r = receiveCost(before, qty, value, ctx);
    const documentId = await newDocument(trx, tenantId);
    let state = before;
    const rows = [];
    if (r.adjustment !== '0.00') {
      rows.push(
        moveRow(tenantId, {
          partId,
          locationId: null,
          kind: 'cost_adjustment',
          quantity: 0,
          functionalAmount: r.adjustment,
          before: state,
          prevLocation: null,
          documentId,
          lineNo: 0,
        }),
      );
      state = { ...state, value: dec(state.value).plus(dec(r.adjustment)).toFixed(2) };
    }
    rows.push(
      moveRow(tenantId, {
        partId,
        locationId,
        kind: 'adjustment',
        reason: 'found',
        quantity: qty,
        functionalAmount: value,
        before: state,
        prevLocation: await balance(trx, partId, locationId),
        documentId,
        lineNo: 1,
      }),
    );
    await trx.insertInto('stock_moves').values(rows).execute();
  });
}

beforeAll(async () => {
  tenant = await createTenant(owner);
  user = await createUser(owner, tenant, 'stock-user');
  shop = await newLocation(tenant, 'Shop', 'shop', true);
  store = await newLocation(tenant, 'Storeroom', 'warehouse');
});

afterAll(async () => {
  await app.destroy();
  await owner.destroy();
});

describe('locations', () => {
  it('allows one default location per tenant, and it must be an active shop', async () => {
    expect(await rejects(newLocation(tenant, 'Second default', 'shop', true))).toBe('23505');
    const t = await createTenant(owner);
    expect(await rejects(newLocation(t, 'Depot', 'warehouse', true))).toBe(SQLSTATE.checkViolation);
  });

  it('refuses, at commit, a tenant whose locations have no default', async () => {
    const t = await createTenant(owner);
    expect(await rejects(newLocation(t, 'Depot', 'warehouse'))).toBe(SQLSTATE.checkViolation);
  });

  it('does not let a location change kind, and keeps devices on active shops', async () => {
    const code = await rejects(
      withTenant(app, tenant, (trx) =>
        trx.updateTable('locations').set({ kind: 'warehouse' }).where('id', '=', shop).execute(),
      ),
    );
    expect(code).toBe(SQLSTATE.insufficientPrivilege);
    const device = newId();
    const insertDevice = (locationId: string) =>
      withTenant(app, tenant, (trx) =>
        trx
          .insertInto('devices')
          .values({
            id: newId(),
            tenant_id: tenant,
            name: `D-${newId().slice(-6)}`,
            created_by: user,
            location_id: locationId,
          })
          .execute(),
      );
    expect(await rejects(insertDevice(store))).toBe(SQLSTATE.checkViolation);
    await withTenant(app, tenant, (trx) =>
      trx
        .insertInto('devices')
        .values({
          id: device,
          tenant_id: tenant,
          name: `D-${device.slice(-6)}`,
          created_by: user,
          location_id: shop,
        })
        .execute(),
    );
  });

  it('refuses to archive a location that holds stock or is the default', async () => {
    const depot = await newLocation(tenant, `Depot ${newId().slice(-4)}`, 'warehouse');
    const p = await newPart(tenant);
    await receive(tenant, p, depot, 1, '1.00');
    const archive = (id: string) =>
      withTenant(app, tenant, (trx) =>
        trx
          .updateTable('locations')
          .set({ archived_at: new Date() })
          .where('id', '=', id)
          .execute(),
      );
    expect(await rejects(archive(depot))).toBe(STOCK.hasStock);
    expect(await rejects(archive(shop))).toBe(SQLSTATE.checkViolation);
  });
});

describe('fx rates', () => {
  async function addRate(base: string, quote: string, rate: string, tenantId = tenant) {
    await withTenant(app, tenantId, (trx) =>
      trx
        .insertInto('fx_rates')
        .values({
          id: newId(),
          tenant_id: tenantId,
          base_currency: base,
          quote_currency: quote,
          rate,
          rate_date: '2026-10-06',
          recorded_by: user,
        })
        .execute(),
    );
  }

  beforeAll(async () => {
    await withTenant(app, tenant, (trx) =>
      trx
        .insertInto('tenant_currencies')
        .values([
          { id: newId(), tenant_id: tenant, code: 'BBB', minor_units: 2 },
          { id: newId(), tenant_id: tenant, code: 'CCC', minor_units: 0 },
        ])
        .execute(),
    );
  });

  it('stores a quote with the functional currency on either side', async () => {
    await addRate('AAA', 'BBB', '3.6725');
    await addRate('CCC', 'AAA', '0.0004');
  });

  it('refuses pairs without the functional currency, same-currency pairs and bad rates', async () => {
    expect(await rejects(addRate('BBB', 'CCC', '2'))).toBe(SQLSTATE.checkViolation);
    expect(await rejects(addRate('AAA', 'AAA', '1'))).toBe(SQLSTATE.checkViolation);
    expect(await rejects(addRate('AAA', 'BBB', '0'))).toBe(SQLSTATE.checkViolation);
    expect(await rejects(addRate('AAA', 'BBB', '1.12345678901'))).toBe(SQLSTATE.checkViolation);
    expect(await rejects(addRate('AAA', 'ZZZ', '2'))).toBe(SQLSTATE.foreignKeyViolation);
  });

  it('is append-only', async () => {
    const code = await rejects(
      withTenant(app, tenant, (trx) => trx.updateTable('fx_rates').set({ rate: '4' }).execute()),
    );
    expect(code).toBe(SQLSTATE.insufficientPrivilege);
  });
});

describe('stock ledger', () => {
  it('applies moves to balances and costs, and nothing else may write them', async () => {
    const p = await newPart(tenant);
    await receive(tenant, p, shop, 3, '30.00');
    await withTenant(app, tenant, async (trx) => {
      expect(await balance(trx, p, shop)).toBe(3);
      const cost = await trx
        .selectFrom('stock_costs')
        .selectAll()
        .where('part_id', '=', p)
        .executeTakeFirstOrThrow();
      expect([cost.quantity, cost.value, cost.ref_quantity, cost.ref_value]).toEqual([
        3,
        '30.00',
        3,
        '30.00',
      ]);
    });
    const writes: ((trx: Transaction<DB>) => Promise<unknown>)[] = [
      (trx: Transaction<DB>) =>
        trx.updateTable('stock_balances').set({ quantity: 100 }).where('part_id', '=', p).execute(),
      (trx: Transaction<DB>) =>
        trx.updateTable('stock_costs').set({ value: '0' }).where('part_id', '=', p).execute(),
      (trx: Transaction<DB>) =>
        trx
          .insertInto('stock_costs')
          .values({ tenant_id: tenant, part_id: newId(), quantity: 1, value: '1' })
          .execute(),
      (trx: Transaction<DB>) =>
        trx.updateTable('stock_moves').set({ quantity: 9 }).where('part_id', '=', p).execute(),
      (trx: Transaction<DB>) => trx.deleteFrom('stock_moves').where('part_id', '=', p).execute(),
    ];
    for (const write of writes) {
      expect(await rejects(withTenant(app, tenant, write))).toBe(SQLSTATE.insufficientPrivilege);
    }
  });

  it('refuses a move computed from a state that has since changed', async () => {
    const p = await newPart(tenant);
    await receive(tenant, p, shop, 2, '20.00');
    const code = await rejects(
      withTenant(app, tenant, async (trx) => {
        await lockCosts(trx, [p]);
        const documentId = await newDocument(trx, tenant);
        const stale = { quantity: 1, value: '10.00', refQuantity: 1, refValue: '10.00' };
        await trx
          .insertInto('stock_moves')
          .values(
            moveRow(tenant, {
              partId: p,
              locationId: shop,
              kind: 'adjustment',
              reason: 'lost',
              quantity: -1,
              functionalAmount: '-10.00',
              before: stale,
              prevLocation: 1,
              documentId,
            }),
          )
          .execute();
      }),
    );
    expect(code).toBe(STOCK.concurrentChange);
  });

  it('enforces the sign rules of each kind and reason', async () => {
    const p = await newPart(tenant);
    const bad: Partial<MoveInput>[] = [
      { kind: 'adjustment', reason: 'lost', quantity: 1, functionalAmount: '1.00' },
      { kind: 'adjustment', reason: 'found', quantity: -1, functionalAmount: '-1.00' },
      { kind: 'adjustment', reason: null, quantity: 1, functionalAmount: '1.00' },
      { kind: 'opening', quantity: -1, functionalAmount: '-1.00' },
      { kind: 'transfer_in', quantity: -1, functionalAmount: '-1.00' },
      { kind: 'cost_adjustment', quantity: 1, functionalAmount: '1.00' },
      { kind: 'adjustment', reason: 'found', quantity: 1, functionalAmount: '-1.00' },
      { kind: 'adjustment', reason: 'found', quantity: 1, functionalAmount: '1.001' },
    ];
    for (const b of bad) {
      const code = await rejects(
        withTenant(app, tenant, async (trx) => {
          const before = (await lockCosts(trx, [p])).get(p) ?? EMPTY_COST_STATE;
          const documentId = await newDocument(trx, tenant);
          await trx
            .insertInto('stock_moves')
            .values(
              moveRow(tenant, {
                partId: p,
                locationId: shop,
                kind: 'adjustment',
                quantity: 1,
                functionalAmount: '1.00',
                before,
                prevLocation: 0,
                documentId,
                ...b,
              }),
            )
            .execute();
        }),
      );
      expect([b, code]).toEqual([b, SQLSTATE.checkViolation]);
    }
  });
});

describe('negative stock', () => {
  async function issue(
    tenantId: string,
    partId: string,
    locationId: string,
    qty: number,
    origin: 'online' | 'offline' = 'online',
    deviceId: string | null = null,
  ) {
    return withTenant(app, tenantId, async (trx) => {
      const before = (await lockCosts(trx, [partId])).get(partId) ?? EMPTY_COST_STATE;
      const r = issueCost(before, qty, ctx);
      const documentId = await newDocument(trx, tenantId, 'adjustment', origin, deviceId);
      await trx
        .insertInto('stock_moves')
        .values(
          moveRow(tenantId, {
            partId,
            locationId,
            kind: 'adjustment',
            reason: 'lost',
            quantity: -qty,
            functionalAmount: `-${r.cost}`,
            before,
            prevLocation: await balance(trx, partId, locationId),
            documentId,
            costKnown: r.costKnown,
          }),
        )
        .execute();
    });
  }

  async function reviewItems(tenantId: string, partId: string) {
    return withTenant(app, tenantId, (trx) =>
      trx
        .selectFrom('stock_review_items')
        .select(['kind', 'location_id', 'resolved_at'])
        .where('part_id', '=', partId)
        .orderBy('kind')
        .execute(),
    );
  }

  it('refuses an online move that takes a location below zero when the tenant denies it', async () => {
    const p = await newPart(tenant);
    await receive(tenant, p, store, 5, '50.00');
    // The part has stock (in the storeroom), but the shop has none.
    expect(await rejects(issue(tenant, p, shop, 1))).toBe(STOCK.insufficient);
  });

  it('accepts an offline move below zero and opens review items', async () => {
    const device = newId();
    await withTenant(app, tenant, (trx) =>
      trx
        .insertInto('devices')
        .values({
          id: device,
          tenant_id: tenant,
          name: `POS-${device.slice(-6)}`,
          created_by: user,
          location_id: shop,
        })
        .execute(),
    );
    const p = await newPart(tenant);
    await issue(tenant, p, shop, 2, 'offline', device);
    expect(await reviewItems(tenant, p)).toEqual([
      { kind: 'cost_unknown', location_id: shop, resolved_at: null },
      { kind: 'negative_stock', location_id: shop, resolved_at: null },
    ]);
  });

  it('accepts an online move below zero when the tenant allows it, with a review item', async () => {
    const t = await createTenant(owner, {
      settings: { inventory: { allowNegativeStock: true } },
    });
    const u = await createUser(owner, t, 'neg-user');
    const prevUser = user;
    user = u;
    try {
      const s = await newLocation(t, 'Shop', 'shop', true);
      const p = await newPart(t);
      await receive(t, p, s, 1, '10.00');
      await issue(t, p, s, 3);
      expect(await reviewItems(t, p)).toEqual([
        { kind: 'negative_stock', location_id: s, resolved_at: null },
      ]);
    } finally {
      user = prevUser;
    }
  });

  it('lets only the resolution of a review item be recorded, once', async () => {
    const p = await newPart(tenant);
    const device = newId();
    await withTenant(app, tenant, (trx) =>
      trx
        .insertInto('devices')
        .values({
          id: device,
          tenant_id: tenant,
          name: `POS-${device.slice(-6)}`,
          created_by: user,
          location_id: shop,
        })
        .execute(),
    );
    await issue(tenant, p, shop, 1, 'offline', device);
    // Still below zero and without a cost: the items cannot be resolved yet.
    const early = await rejects(
      withTenant(app, tenant, (trx) =>
        trx
          .updateTable('stock_review_items')
          .set({ resolved_at: new Date(), resolved_by: user, resolution_note: 'too early' })
          .where('part_id', '=', p)
          .execute(),
      ),
    );
    expect(early).toBe('ST004');
    await receive(tenant, p, shop, 1, '4.00');
    const resolve = () =>
      withTenant(app, tenant, (trx) =>
        trx
          .updateTable('stock_review_items')
          .set({ resolved_at: new Date(), resolved_by: user, resolution_note: 'counted' })
          .where('part_id', '=', p)
          .execute(),
      );
    await resolve();
    expect(await rejects(resolve())).toBe(SQLSTATE.checkViolation);
    const code = await rejects(
      withTenant(app, tenant, (trx) =>
        trx
          .updateTable('stock_review_items')
          .set({ kind: 'cost_unknown' })
          .where('part_id', '=', p)
          .execute(),
      ),
    );
    expect(code).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('lets two devices race for the last unit online: exactly one wins', async () => {
    const p = await newPart(tenant);
    await receive(tenant, p, shop, 1, '10.00');
    const results = await Promise.allSettled([
      issue(tenant, p, shop, 1),
      issue(tenant, p, shop, 1),
    ]);
    const codes = results.map((r) =>
      r.status === 'fulfilled' ? 'ok' : (r.reason as { code?: string }).code,
    );
    expect(codes.sort()).toEqual(['ST001', 'ok']);
    await withTenant(app, tenant, async (trx) => {
      expect(await balance(trx, p, shop)).toBe(0);
    });
  });
});

describe('catalog guards', () => {
  it('refuses to archive a part or change its unit while it has stock', async () => {
    const p = await newPart(tenant);
    await receive(tenant, p, store, 1, '1.00');
    for (const set of [{ archived_at: new Date() }, { unit: 'pair' }]) {
      const code = await rejects(
        withTenant(app, tenant, (trx) =>
          trx.updateTable('parts').set(set).where('id', '=', p).execute(),
        ),
      );
      expect(code).toBe(STOCK.hasStock);
    }
  });
});

describe('ledger queue', () => {
  it('can be appended to and read, not changed', async () => {
    await withTenant(app, tenant, async (trx) => {
      const documentId = await newDocument(trx, tenant);
      await trx
        .insertInto('ledger_queue')
        .values({
          id: newId(),
          tenant_id: tenant,
          document_id: documentId,
          event: 'stock.adjustment',
          payload: JSON.stringify({ functionalAmount: '1.00' }),
        })
        .execute();
    });
    const code = await rejects(
      withTenant(app, tenant, (trx) => trx.deleteFrom('ledger_queue').execute()),
    );
    expect(code).toBe(SQLSTATE.insufficientPrivilege);
  });
});

describe('reconciliation', () => {
  it('balances and costs always equal the sum of the moves', async () => {
    const p = await newPart(tenant);
    const locations = [shop, store];
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            in: fc.boolean(),
            loc: fc.integer({ min: 0, max: 1 }),
            qty: fc.integer({ min: 1, max: 5 }),
            cents: fc.integer({ min: 0, max: 10_000 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (ops) => {
          for (const op of ops) {
            const loc = locations[op.loc] ?? shop;
            if (op.in) {
              await receive(tenant, p, loc, op.qty, (op.cents / 100).toFixed(2));
            } else {
              await rejects(issueLocal(p, loc, op.qty));
            }
          }
          await withTenant(app, tenant, async (trx) => {
            const sums = await trx
              .selectFrom('stock_moves')
              .select([
                sql<number>`coalesce(sum(quantity), 0)::int`.as('q'),
                sql<string>`coalesce(sum(functional_amount), 0)::text`.as('v'),
              ])
              .where('part_id', '=', p)
              .executeTakeFirstOrThrow();
            // Refused issues roll back, so the part may not have a cost row yet.
            const cost = (await trx
              .selectFrom('stock_costs')
              .select(['quantity', 'value'])
              .where('part_id', '=', p)
              .executeTakeFirst()) ?? { quantity: 0, value: '0' };
            expect(cost.quantity).toBe(sums.q);
            expect(dec(cost.value).eq(dec(sums.v))).toBe(true);
            for (const loc of locations) {
              const s = await trx
                .selectFrom('stock_moves')
                .select(sql<number>`coalesce(sum(quantity), 0)::int`.as('q'))
                .where('part_id', '=', p)
                .where('location_id', '=', loc)
                .executeTakeFirstOrThrow();
              expect(await balance(trx, p, loc)).toBe(s.q);
            }
          });
        },
      ),
      { numRuns: 15 },
    );

    async function issueLocal(partId: string, loc: string, qty: number) {
      await withTenant(app, tenant, async (trx) => {
        const before = (await lockCosts(trx, [partId])).get(partId) ?? EMPTY_COST_STATE;
        const r = issueCost(before, qty, ctx);
        const documentId = await newDocument(trx, tenant);
        await trx
          .insertInto('stock_moves')
          .values(
            moveRow(tenant, {
              partId,
              locationId: loc,
              kind: 'adjustment',
              reason: 'lost',
              quantity: -qty,
              functionalAmount: r.cost === '0.00' ? '0.00' : `-${r.cost}`,
              before,
              prevLocation: await balance(trx, partId, loc),
              documentId,
              costKnown: r.costKnown,
            }),
          )
          .execute();
      });
    }
  });
});
