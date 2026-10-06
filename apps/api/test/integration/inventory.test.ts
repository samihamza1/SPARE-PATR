import { withTenant } from '@autoparts/db';
import { money, newId } from '@autoparts/shared';
import type {
  CurrentFxRates,
  Device,
  FxRateRecord,
  Location,
  PartDetail,
  PartStock,
  Role,
  StockMove,
} from '@autoparts/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { StockOp } from '../../src/inventory/engine';
import { postStockDocument } from '../../src/inventory/engine';
import { rateInEffect, valueAmount } from '../../src/inventory/fx';
import { requestHash } from '../../src/inventory/idempotency';
import { readMoneySettings } from '../../src/tenant-settings';
import type { Client, Shop } from './harness';
import { HOUR, errorCode, loggedIn, provisionShop, setupEnv } from './harness';

const env = setupEnv();
let shop: Shop;
let owner: Client;
let cashier: Client;
let mainShop: Location;
let storeroom: Location;

async function createPart(sku: string): Promise<string> {
  const res = await owner.post('/catalog/parts', { id: newId(), sku, nameEn: sku });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<PartDetail>().id;
}

/** Posts a stock document straight through the engine (the document routes come in 4b). */
async function post(
  ops: StockOp[],
  origin: 'online' | 'offline' = 'online',
  deviceId: string | null = null,
) {
  return withTenant(env.appDb, shop.tenantId, async (trx) => {
    const m = await readMoneySettings(trx);
    return postStockDocument(
      trx,
      shop.tenantId,
      {
        id: newId(),
        kind: 'adjustment',
        requestHash: requestHash(ops),
        note: null,
        occurredAt: env.clock.now,
        origin,
        deviceId,
        postedBy: shop.ownerUserId,
      },
      ops,
      m,
    );
  });
}

async function valued(amount: string, currency: string) {
  return withTenant(env.appDb, shop.tenantId, async (trx) => {
    const m = await readMoneySettings(trx);
    const rate = await rateInEffect(trx, m.functional.code, currency, '2100-01-01');
    return valueAmount(money(amount, currency), rate, m);
  });
}

beforeAll(async () => {
  shop = await provisionShop(env);
  owner = await loggedIn(env, shop);
  const roles = (await owner.get('/roles')).json<Role[]>();
  const cashierRole = roles.find((r) => r.code === 'cashier');
  const res = await owner.post('/users', {
    id: newId(),
    username: 'cash',
    displayName: 'Cashier',
    password: 'cashier passphrase 1',
    roleIds: [cashierRole?.id],
  });
  expect(res.statusCode, res.body).toBe(201);
  cashier = await loggedIn(env, shop, 'cash', 'cashier passphrase 1');
  const currency = await owner.post('/currencies', { id: newId(), code: 'BBB', minorUnits: 2 });
  expect(currency.statusCode, currency.body).toBe(201);
});

describe('locations', () => {
  it('starts with the default shop named at provisioning', async () => {
    const list = (await cashier.get('/locations')).json<Location[]>();
    expect(list).toEqual([
      expect.objectContaining({ name: 'Main shop', kind: 'shop', isDefault: true }),
    ]);
    mainShop = list[0]!;
  });

  it('lets the owner add a storeroom and warehouses, not the cashier', async () => {
    const body = { id: newId(), name: 'Storeroom', kind: 'warehouse' };
    expect((await cashier.post('/locations', body)).statusCode).toBe(403);
    const res = await owner.post('/locations', body);
    expect(res.statusCode, res.body).toBe(201);
    storeroom = res.json<Location>();
    expect(storeroom).toMatchObject({ kind: 'warehouse', isDefault: false });
    const depot = await owner.post('/locations', {
      id: newId(),
      name: 'Depot 2',
      kind: 'warehouse',
    });
    expect(depot.statusCode).toBe(201);
    expect((await owner.post('/locations', { ...body, id: newId() })).statusCode).toBe(409);
  });

  it('keeps the default an active shop', async () => {
    let res = await owner.patch(`/locations/${storeroom.id}`, { isDefault: true });
    expect(errorCode(res)).toBe('location.not_a_shop');
    res = await owner.patch(`/locations/${mainShop.id}`, { archived: true });
    expect(errorCode(res)).toBe('location.archived');
    const second = await owner.post('/locations', { id: newId(), name: 'Branch', kind: 'shop' });
    const branch = second.json<Location>();
    res = await owner.patch(`/locations/${branch.id}`, { isDefault: true });
    expect(res.json<Location>().isDefault).toBe(true);
    res = await owner.patch(`/locations/${mainShop.id}`, { isDefault: true, name: 'The shop' });
    expect(res.json<Location>()).toMatchObject({ isDefault: true, name: 'The shop' });
    const list = (await owner.get('/locations')).json<Location[]>();
    expect(list.filter((l) => l.isDefault).map((l) => l.id)).toEqual([mainShop.id]);
  });
});

describe('devices', () => {
  it('sell from the default shop unless told otherwise, and only from shops', async () => {
    const res = await owner.post('/devices', { id: newId(), name: 'Till 1' });
    expect(res.statusCode, res.body).toBe(201);
    const device = res.json<{ device: Device }>().device;
    expect(device.locationId).toBe(mainShop.id);
    const moved = await owner.patch(`/devices/${device.id}`, { locationId: storeroom.id });
    expect(errorCode(moved)).toBe('location.not_a_shop');
    // A shop with an active device cannot be archived.
    const branch = (await owner.get('/locations'))
      .json<Location[]>()
      .find((l) => l.name === 'Branch');
    const ok = await owner.patch(`/devices/${device.id}`, { locationId: branch?.id });
    expect(ok.json<Device>().locationId).toBe(branch?.id);
    expect(errorCode(await owner.patch(`/locations/${branch?.id ?? ''}`, { archived: true }))).toBe(
      'location.has_devices',
    );
  });
});

describe('exchange rates', () => {
  it('are recorded as quoted by fx.manage, read by everyone', async () => {
    const body = { id: newId(), base: 'AAA', quote: 'BBB', rate: '3.6725' };
    expect((await cashier.post('/fx-rates', body)).statusCode).toBe(403);
    const res = await owner.post('/fx-rates', body);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<FxRateRecord>()).toMatchObject({ base: 'AAA', quote: 'BBB', rate: '3.6725' });
    const current = (await cashier.get('/fx-rates/current')).json<CurrentFxRates>();
    const bbb = current.rates.find((r) => r.currency === 'BBB');
    expect(bbb).toMatchObject({ currency: 'BBB', enteredToday: true });
    expect(bbb?.rate?.rate).toBe('3.6725');
  });

  it('refuse future dates, unknown pairs and malformed rates', async () => {
    const tomorrow = new Date(env.clock.now.getTime() + 24 * HOUR).toISOString().slice(0, 10);
    let res = await owner.post('/fx-rates', {
      id: newId(),
      base: 'AAA',
      quote: 'BBB',
      rate: '3.7',
      rateDate: tomorrow,
    });
    expect(errorCode(res)).toBe('fx.future_date');
    res = await owner.post('/fx-rates', { id: newId(), base: 'AAA', quote: 'BBB', rate: '1e3' });
    expect(res.statusCode).toBe(400);
    res = await owner.post('/fx-rates', { id: newId(), base: 'AAA', quote: 'AAA', rate: '1' });
    expect(res.statusCode).toBe(400);
  });

  it('says when no rate was entered today', async () => {
    const created = await owner.post('/currencies', { id: newId(), code: 'CCC', minorUnits: 0 });
    expect(created.statusCode, created.body).toBe(201);
    const yesterday = new Date(env.clock.now.getTime() - 24 * HOUR).toISOString().slice(0, 10);
    const res = await owner.post('/fx-rates', {
      id: newId(),
      base: 'CCC',
      quote: 'AAA',
      rate: '0.0004',
      rateDate: yesterday,
    });
    expect(res.statusCode, res.body).toBe(201);
    const current = (await owner.get('/fx-rates/current')).json<CurrentFxRates>();
    const ccc = current.rates.find((r) => r.currency === 'CCC');
    expect(ccc).toMatchObject({ enteredToday: false });
    expect(ccc?.rate).toMatchObject({
      base: 'CCC',
      quote: 'AAA',
      rate: '0.0004',
      rateDate: yesterday,
    });
  });
});

describe('stock', () => {
  let part: string;

  beforeAll(async () => {
    part = await createPart(`STK-${newId().slice(-6)}`);
  });

  it('values a receipt in another currency at the quoted rate (invariant 2)', async () => {
    const value = await valued('100.00', 'BBB');
    expect(value).toMatchObject({
      amount: '100',
      currency: 'BBB',
      fxRate: '3.6725',
      fxBase: 'AAA',
      fxQuote: 'BBB',
      functionalAmount: '27.23',
    });
    const moves = await post([
      { op: 'receive', partId: part, locationId: mainShop.id, quantity: 3, kind: 'opening', value },
    ]);
    expect(moves).toHaveLength(1);
  });

  it('shows quantities to everyone and values only with cost.view', async () => {
    const asCashier = (await cashier.get(`/stock/parts/${part}`)).json<PartStock>();
    expect(asCashier).toMatchObject({
      total: 3,
      locations: [{ locationId: mainShop.id, quantity: 3 }],
    });
    expect(asCashier.cost).toBeUndefined();
    const asOwner = (await owner.get(`/stock/parts/${part}`)).json<PartStock>();
    expect(asOwner.cost).toEqual({ currency: 'AAA', value: '27.23', averageCost: '9.08' });
    const moves = (await cashier.get(`/stock/moves?partId=${part}`)).json<StockMove[]>();
    expect(moves[0]?.cost).toBeUndefined();
    const ownerMoves = (await owner.get(`/stock/moves?partId=${part}`)).json<StockMove[]>();
    expect(ownerMoves[0]?.cost).toMatchObject({ currency: 'BBB', functionalAmount: '27.23' });
  });

  it('transfers at the average cost without changing it', async () => {
    await post([
      {
        op: 'transfer',
        partId: part,
        fromLocationId: mainShop.id,
        toLocationId: storeroom.id,
        quantity: 2,
      },
    ]);
    const stock = (await owner.get(`/stock/parts/${part}`)).json<PartStock>();
    expect(stock.locations.map((l) => [l.locationId, l.quantity])).toEqual(
      expect.arrayContaining([
        [mainShop.id, 1],
        [storeroom.id, 2],
      ]),
    );
    expect(stock.cost).toEqual({ currency: 'AAA', value: '27.23', averageCost: '9.08' });
    await expect(
      post([
        {
          op: 'transfer',
          partId: part,
          fromLocationId: mainShop.id,
          toLocationId: storeroom.id,
          quantity: 5,
        },
      ]),
    ).rejects.toMatchObject({ code: 'stock.insufficient' });
  });

  it('refuses an online issue below zero, and the last unit goes to one of two racers', async () => {
    const issue = (): StockOp[] => [
      {
        op: 'issue',
        partId: part,
        locationId: mainShop.id,
        quantity: 1,
        kind: 'adjustment',
        reason: 'lost',
      },
    ];
    const results = await Promise.allSettled([post(issue()), post(issue())]);
    const outcomes = results.map((r) =>
      r.status === 'fulfilled' ? 'ok' : (r.reason as { code?: string }).code,
    );
    expect(outcomes.sort()).toEqual(['ST001', 'ok']);
  });

  it('moves stock from a superseded part to its replacement on request', async () => {
    const next = await createPart(`STK-${newId().slice(-6)}`);
    await post([
      {
        op: 'part_transfer',
        fromPartId: part,
        toPartId: next,
        locationId: storeroom.id,
        quantity: 2,
      },
    ]);
    const old = (await owner.get(`/stock/parts/${part}`)).json<PartStock>();
    const moved = (await owner.get(`/stock/parts/${next}`)).json<PartStock>();
    expect([old.total, old.cost?.value]).toEqual([0, '0.00']);
    // 27.23 - 9.08 (the unit lost above) = 18.15 for the two units that moved.
    expect([moved.total, moved.cost?.value]).toEqual([2, '18.15']);
  });

  it('needs a known cost to add units at the average', async () => {
    const fresh = await createPart(`STK-${newId().slice(-6)}`);
    await expect(
      post([
        {
          op: 'receive_at_average',
          partId: fresh,
          locationId: mainShop.id,
          quantity: 1,
          kind: 'adjustment',
          reason: 'found',
        },
      ]),
    ).rejects.toMatchObject({ code: 'stock.cost_required' });
  });

  it('queues valued documents for the ledger and leaves transfers out', async () => {
    const queue = await withTenant(env.appDb, shop.tenantId, (trx) =>
      trx.selectFrom('ledger_queue').select(['event', 'payload']).orderBy('created_at').execute(),
    );
    expect(queue.map((q) => q.event)).toEqual([
      'stock.adjustment',
      'stock.adjustment',
      'stock.adjustment',
    ]);
    expect(queue[0]?.payload).toMatchObject({
      currency: 'AAA',
      lines: [{ kind: 'opening', reason: null, functionalAmount: '27.23' }],
    });
  });

  it('refuses to archive a part or location that holds stock', async () => {
    // The replacement part's two units sit in the storeroom.
    const res = await owner.patch(`/locations/${storeroom.id}`, { archived: true });
    expect(errorCode(res)).toBe('stock.has_stock');
    const parts = (await owner.get(`/stock/balances?locationId=${storeroom.id}&nonZero=true`)).json<
      { partId: string }[]
    >();
    expect(parts).toHaveLength(1);
    const archive = await owner.patch(`/catalog/parts/${parts[0]?.partId ?? ''}`, {
      archived: true,
    });
    expect(errorCode(archive)).toBe('stock.has_stock');
    // The emptied old part can be archived.
    expect((await owner.patch(`/catalog/parts/${part}`, { archived: true })).statusCode).toBe(200);
  });
});
