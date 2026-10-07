import { withTenant } from '@autoparts/db';
import { dec, newId } from '@autoparts/shared';
import type {
  CountLine,
  Device,
  ImportBatchDetail,
  Location,
  OpeningDraft,
  OpeningLine,
  PartDetail,
  PartStock,
  ReviewItem,
  SearchResult,
  Role,
  StockCount,
  StockDocument,
} from '@autoparts/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { postStockDocument } from '../../src/inventory/engine';
import { requestHash } from '../../src/inventory/idempotency';
import { readMoneySettings } from '../../src/tenant-settings';
import { buildXlsx } from '../xlsx';
import type { Client, Shop } from './harness';
import { errorCode, loggedIn, provisionShop, setupEnv } from './harness';

const env = setupEnv();
let shop: Shop;
let owner: Client;
let supervisor: Client;
let cashier: Client;
let mainShop: Location;
let storeroom: Location;

async function createPart(sku: string): Promise<string> {
  const res = await owner.post('/catalog/parts', { id: newId(), sku, nameEn: sku });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<PartDetail>().id;
}

async function user(username: string, roleCode: string): Promise<Client> {
  const roles = (await owner.get('/roles')).json<Role[]>();
  const id = newId();
  const password = `${username} passphrase 1`;
  expect(
    (await owner.post('/users', { id, username, displayName: username, password })).statusCode,
  ).toBe(201);
  const role = roles.find((r) => r.code === roleCode);
  expect((await owner.post(`/users/${id}/roles`, { roleId: role?.id })).statusCode).toBe(200);
  return loggedIn(env, shop, username, password);
}

const stockOf = async (partId: string) =>
  (await owner.get(`/stock/parts/${partId}`)).json<PartStock>();
const qtyAt = (s: PartStock, locationId: string) =>
  s.locations.find((l) => l.locationId === locationId)?.quantity ?? 0;

beforeAll(async () => {
  shop = await provisionShop(env);
  owner = await loggedIn(env, shop);
  supervisor = await user('sup', 'supervisor');
  cashier = await user('cash', 'cashier');
  expect(
    (await owner.post('/currencies', { id: newId(), code: 'BBB', minorUnits: 2 })).statusCode,
  ).toBe(201);
  expect(
    (await owner.post('/fx-rates', { id: newId(), base: 'AAA', quote: 'BBB', rate: '3.6725' }))
      .statusCode,
  ).toBe(201);
  mainShop = (await owner.get('/locations')).json<Location[]>()[0]!;
  const res = await owner.post('/locations', { id: newId(), name: 'Storeroom', kind: 'warehouse' });
  storeroom = res.json<Location>();
});

describe('adjustments', () => {
  let part: string;

  beforeAll(async () => {
    part = await createPart(`ADJ-${newId().slice(-6)}`);
  });

  it('adds found units at an entered cost in another currency, converted at the rate', async () => {
    const body = {
      id: newId(),
      locationId: mainShop.id,
      reason: 'found',
      note: 'Shelf check',
      lines: [{ partId: part, quantity: 2, unitCost: { amount: '36.725', currency: 'BBB' } }],
    };
    const res = await supervisor.post('/stock/adjustments', body);
    expect(res.statusCode, res.body).toBe(200);
    const doc = res.json<StockDocument>();
    // 2 x 36.725 = 73.45 BBB; 73.45 / 3.6725 = 20.00 AAA.
    expect(doc.moves).toEqual([
      expect.objectContaining({
        kind: 'adjustment',
        reason: 'found',
        quantity: 2,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest matcher
        cost: expect.objectContaining({
          amount: '73.45',
          currency: 'BBB',
          functionalAmount: '20.00',
        }),
      }),
    ]);
    // The same request again returns the same document; another request with that id is refused.
    const again = await supervisor.post('/stock/adjustments', body);
    expect(again.json<StockDocument>().id).toBe(doc.id);
    expect((await stockOf(part)).total).toBe(2);
    const changed = await supervisor.post('/stock/adjustments', { ...body, note: 'Other' });
    expect(errorCode(changed)).toBe('idempotency.conflict');
  });

  it('takes lost units out at the average and refuses going below zero', async () => {
    const res = await supervisor.post('/stock/adjustments', {
      id: newId(),
      locationId: mainShop.id,
      reason: 'lost',
      lines: [{ partId: part, quantity: -1 }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<StockDocument>().moves[0]?.cost?.functionalAmount).toBe('-10.00');
    const tooMany = await supervisor.post('/stock/adjustments', {
      id: newId(),
      locationId: mainShop.id,
      reason: 'damaged',
      lines: [{ partId: part, quantity: -5 }],
    });
    expect(errorCode(tooMany)).toBe('stock.insufficient');
  });

  it('checks the direction, the cost and the permission', async () => {
    const wrongWay = await supervisor.post('/stock/adjustments', {
      id: newId(),
      locationId: mainShop.id,
      reason: 'lost',
      lines: [{ partId: part, quantity: 1 }],
    });
    expect(wrongWay.statusCode).toBe(400);
    const fresh = await createPart(`ADJ-${newId().slice(-6)}`);
    const noCost = await supervisor.post('/stock/adjustments', {
      id: newId(),
      locationId: mainShop.id,
      reason: 'found',
      lines: [{ partId: fresh, quantity: 1 }],
    });
    expect(errorCode(noCost)).toBe('stock.cost_required');
    const asCashier = await cashier.post('/stock/adjustments', {
      id: newId(),
      locationId: mainShop.id,
      reason: 'found',
      lines: [{ partId: part, quantity: 1 }],
    });
    expect(asCashier.statusCode).toBe(403);
  });
});

describe('transfers', () => {
  it('moves stock between locations at the average, never beyond what is there', async () => {
    const part = await createPart(`TRF-${newId().slice(-6)}`);
    await supervisor.post('/stock/adjustments', {
      id: newId(),
      locationId: mainShop.id,
      reason: 'found',
      lines: [{ partId: part, quantity: 3, unitCost: { amount: '5', currency: 'AAA' } }],
    });
    const res = await supervisor.post('/stock/transfers', {
      id: newId(),
      fromLocationId: mainShop.id,
      toLocationId: storeroom.id,
      lines: [{ partId: part, quantity: 2 }],
    });
    expect(res.statusCode, res.body).toBe(200);
    const s = await stockOf(part);
    expect([qtyAt(s, mainShop.id), qtyAt(s, storeroom.id), s.cost?.value]).toEqual([1, 2, '15.00']);
    const tooMany = await supervisor.post('/stock/transfers', {
      id: newId(),
      fromLocationId: mainShop.id,
      toLocationId: storeroom.id,
      lines: [{ partId: part, quantity: 2 }],
    });
    expect(errorCode(tooMany)).toBe('stock.insufficient');
    const same = await supervisor.post('/stock/transfers', {
      id: newId(),
      fromLocationId: mainShop.id,
      toLocationId: mainShop.id,
      lines: [{ partId: part, quantity: 1 }],
    });
    expect(same.statusCode).toBe(400);
  });
});

describe('moving stock to a replacement part', () => {
  it('moves every positive balance to the active replacement, on request', async () => {
    const old = await createPart(`OLD-${newId().slice(-6)}`);
    const next = await createPart(`NEW-${newId().slice(-6)}`);
    const none = await supervisor.post('/stock/part-transfers', { id: newId(), partId: old });
    expect(errorCode(none)).toBe('stock.no_replacement');
    for (const locationId of [mainShop.id, storeroom.id]) {
      await supervisor.post('/stock/adjustments', {
        id: newId(),
        locationId,
        reason: 'found',
        lines: [{ partId: old, quantity: 2, unitCost: { amount: '4', currency: 'AAA' } }],
      });
    }
    expect(
      (await owner.post(`/catalog/parts/${old}/supersede`, { id: newId(), newPartId: next }))
        .statusCode,
    ).toBe(200);
    const res = await supervisor.post('/stock/part-transfers', { id: newId(), partId: old });
    expect(res.statusCode, res.body).toBe(200);
    const [o, n] = [await stockOf(old), await stockOf(next)];
    expect([o.total, o.cost?.value, n.total, n.cost?.value]).toEqual([0, '0.00', 4, '16.00']);
  });
});

describe('opening stock from an applied import', () => {
  let batchId: string;
  let draft: OpeningDraft;
  const n = (v: string) => ({ n: v });

  beforeAll(async () => {
    // Synthetic sheet shaped like a shop's stock list (no real data).
    const content = buildXlsx({
      Stock: [
        ['No', 'Part', 'Name', 'Code', 'Cost', 'Qty'],
        [n('1'), 'A-100', 'Oil filter', 'LC', n('36.725'), n('2')],
        [n('2'), 'A-100', 'Oil filter', 'LC', n('40'), n('1')],
        [n('3'), 'B-200', 'Brake pad', 'LC', n('0'), n('4')],
        [n('4'), 'C-300', 'Spark plug', 'LC', null, n('2.5')],
        [n('5'), 'D-400', 'Wiper', 'LC', n('10'), n('0')],
        [n('6'), 'E-500', 'Bulb', 'LC', n('3.6725'), n('10')],
      ],
    }).toString('base64');
    const staged = await owner.post('/catalog/imports', {
      id: newId(),
      fileName: 'opening.xlsx',
      contentBase64: content,
      sheet: 'Stock',
      headerRow: 1,
      mapping: {
        columns: { partNumber: 1, nameEn: 2, vehicleCode: 3, cost: 4, quantity: 5 },
        numberKind: 'oem',
        priceListId: null,
        costCurrency: 'BBB',
        skuPrefix: 'OP',
      },
    });
    expect(staged.statusCode, staged.body).toBe(201);
    batchId = staged.json<ImportBatchDetail>().id;
    const applied = await owner.post(`/catalog/imports/${batchId}/apply`);
    expect(applied.statusCode, applied.body).toBe(200);
  });

  it('needs stock.opening and cost.view', async () => {
    expect((await supervisor.post('/stock/opening', { id: newId(), batchId })).statusCode).toBe(
      403,
    );
  });

  it('builds one line per part: repeats summed, gaps marked', async () => {
    const res = await owner.post('/stock/opening', { id: newId(), batchId });
    expect(res.statusCode, res.body).toBe(201);
    draft = res.json<OpeningDraft>();
    expect(draft).toMatchObject({
      locationId: mainShop.id,
      costCurrency: 'BBB',
      fxRate: { base: 'AAA', quote: 'BBB', rate: '3.6725' },
      counts: { ready: 2, needs_cost: 1, needs_quantity: 1, excluded: 1 },
    });
    const lines = (await owner.get(`/stock/opening/${draft.id}/lines`)).json<OpeningLine[]>();
    const byName = new Map(lines.map((l) => [l.nameEn, l]));
    // Two rows of A-100: 3 units, 2 x 36.725 + 40 = 113.45 BBB, weighted exactly.
    expect(byName.get('Oil filter')).toMatchObject({
      rows: 2,
      quantity: 3,
      amount: '113.45',
      status: 'ready',
    });
    expect(byName.get('Brake pad')).toMatchObject({
      quantity: 4,
      amount: null,
      status: 'needs_cost',
    });
    expect(byName.get('Spark plug')).toMatchObject({
      fileQuantity: '2.5',
      quantity: null,
      status: 'needs_quantity',
    });
    expect(byName.get('Wiper')).toMatchObject({ status: 'excluded', exclusion: 'no_quantity' });
    expect(errorCode(await owner.post(`/stock/opening/${draft.id}/post`))).toBe(
      'opening.not_ready',
    );
    expect(errorCode(await owner.post('/stock/opening', { id: newId(), batchId }))).toBe(
      'opening.exists',
    );
  });

  it('posts once the owner completes costs and quantities; totals match to the cent', async () => {
    const lines = (await owner.get(`/stock/opening/${draft.id}/lines`)).json<OpeningLine[]>();
    const pad = lines.find((l) => l.nameEn === 'Brake pad');
    const plug = lines.find((l) => l.nameEn === 'Spark plug');
    await owner.patch(`/stock/opening/${draft.id}/lines/${pad?.partId ?? ''}`, {
      unitCost: '18.3625',
    });
    let res = await owner.patch(`/stock/opening/${draft.id}/lines/${plug?.partId ?? ''}`, {
      quantity: 3,
      unitCost: '7.345',
    });
    draft = res.json<OpeningDraft>();
    expect(draft.counts).toMatchObject({ ready: 4, needs_cost: 0, needs_quantity: 0 });
    const expected = draft.totals.functionalAmount;
    res = await owner.post(`/stock/opening/${draft.id}/post`);
    expect(res.statusCode, res.body).toBe(200);
    const doc = res.json<StockDocument>();
    expect(doc).toMatchObject({ id: draft.id, kind: 'opening' });
    expect(doc.moves).toHaveLength(4);
    const posted = doc.moves.reduce(
      (s, m) => s.plus(dec(m.cost?.functionalAmount ?? '0')),
      dec('0'),
    );
    expect(posted.toFixed(2)).toBe(expected);
    // Posting again returns the same document.
    expect((await owner.post(`/stock/opening/${draft.id}/post`)).json<StockDocument>().id).toBe(
      draft.id,
    );
    const after = (await owner.get(`/stock/opening/${draft.id}`)).json<OpeningDraft>();
    expect(after.status).toBe('posted');
    const list = (await owner.get('/stock/opening')).json<{ id: string; status: string }[]>();
    expect(list).toEqual([expect.objectContaining({ id: draft.id, status: 'posted' })]);
  });

  it('allows one opening move per part and location', async () => {
    const code = await withTenant(env.appDb, shop.tenantId, async (trx) => {
      const part = (await owner.get(`/stock/opening/${draft.id}/lines?status=ready`)).json<
        OpeningLine[]
      >()[0];
      const m = await readMoneySettings(trx);
      try {
        await postStockDocument(
          trx,
          shop.tenantId,
          {
            id: newId(),
            kind: 'opening',
            requestHash: requestHash('x'),
            note: null,
            occurredAt: env.clock.now,
            origin: 'online',
            deviceId: null,
            postedBy: shop.ownerUserId,
          },
          [
            {
              op: 'receive',
              partId: part?.partId ?? '',
              locationId: mainShop.id,
              quantity: 1,
              kind: 'opening',
              value: {
                amount: '1.00',
                currency: 'AAA',
                fxRate: '1',
                fxBase: 'AAA',
                fxQuote: 'AAA',
                functionalAmount: '1.00',
                fxRateId: null,
              },
            },
          ],
          m,
        );
        return 'posted';
      } catch (e) {
        return (e as { code?: string }).code;
      }
    });
    expect(code).toBe('23505');
  });
});

describe('counts', () => {
  let part: string;
  let other: string;
  let count: StockCount;

  beforeAll(async () => {
    part = await createPart(`CNT-${newId().slice(-6)}`);
    other = await createPart(`CNT-${newId().slice(-6)}`);
    await supervisor.post('/stock/adjustments', {
      id: newId(),
      locationId: storeroom.id,
      reason: 'found',
      lines: [
        { partId: part, quantity: 3, unitCost: { amount: '2', currency: 'AAA' } },
        { partId: other, quantity: 10, unitCost: { amount: '1', currency: 'AAA' } },
      ],
    });
  });

  it('is opened by a supervisor for the parts with stock at a location', async () => {
    expect(
      (await cashier.post('/stock/counts', { id: newId(), locationId: storeroom.id, scope: 'all' }))
        .statusCode,
    ).toBe(403);
    const res = await supervisor.post('/stock/counts', {
      id: newId(),
      locationId: storeroom.id,
      scope: 'all',
    });
    expect(res.statusCode, res.body).toBe(201);
    count = res.json<StockCount>();
    expect(count).toMatchObject({ status: 'open', counted: 0 });
    expect(count.lines).toBeGreaterThanOrEqual(2);
    const twice = await supervisor.post('/stock/counts', {
      id: newId(),
      locationId: storeroom.id,
      scope: 'all',
    });
    expect(errorCode(twice)).toBe('count.open_exists');
  });

  it('is blind for counters; moves after counting are not differences', async () => {
    expect(
      (await cashier.put(`/stock/counts/${count.id}/lines/${part}`, { counted: 2 })).statusCode,
    ).toBe(200);
    expect(
      (await cashier.put(`/stock/counts/${count.id}/lines/${other}`, { counted: 10 })).statusCode,
    ).toBe(200);
    const blind = (await cashier.get(`/stock/counts/${count.id}/lines`)).json<CountLine[]>();
    expect(blind.find((l) => l.partId === part)).not.toHaveProperty('expected');
    // One unit is lost after it was counted: not part of the count's difference.
    await supervisor.post('/stock/adjustments', {
      id: newId(),
      locationId: storeroom.id,
      reason: 'lost',
      lines: [{ partId: part, quantity: -1 }],
    });
    const seen = (await supervisor.get(`/stock/counts/${count.id}/lines`)).json<CountLine[]>();
    expect(seen.find((l) => l.partId === part)).toMatchObject({
      counted: 2,
      expected: 3,
      variance: -1,
    });
    expect(seen.find((l) => l.partId === other)).toMatchObject({ variance: 0 });
  });

  it('posts the differences when a supervisor approves', async () => {
    const documentId = newId();
    expect(
      (await cashier.post(`/stock/counts/${count.id}/approve`, { documentId })).statusCode,
    ).toBe(403);
    const res = await supervisor.post(`/stock/counts/${count.id}/approve`, { documentId });
    expect(res.statusCode, res.body).toBe(200);
    // 3 found - 1 lost - 1 counted short = 1 left.
    expect(qtyAt(await stockOf(part), storeroom.id)).toBe(1);
    expect(qtyAt(await stockOf(other), storeroom.id)).toBe(10);
    const doc = (await owner.get(`/stock/documents/${documentId}`)).json<StockDocument>();
    expect(doc.moves.map((m) => [m.kind, m.quantity])).toEqual([['count', -1]]);
    expect(
      (await supervisor.post(`/stock/counts/${count.id}/approve`, { documentId })).statusCode,
    ).toBe(200);
    expect(
      errorCode(
        await supervisor.post(`/stock/counts/${count.id}/approve`, { documentId: newId() }),
      ),
    ).toBe('count.not_open');
    expect(
      errorCode(await cashier.put(`/stock/counts/${count.id}/lines/${part}`, { counted: 1 })),
    ).toBe('count.not_open');
  });
});

describe('review items', () => {
  it('list offline shortfalls and resolve only once the problem is gone', async () => {
    const part = await createPart(`REV-${newId().slice(-6)}`);
    const device = (await owner.post('/devices', { id: newId(), name: 'Till' })).json<{
      device: Device;
    }>().device;
    // An offline sale beyond stock, as POS sync will post it.
    await withTenant(env.appDb, shop.tenantId, async (trx) => {
      const m = await readMoneySettings(trx);
      await postStockDocument(
        trx,
        shop.tenantId,
        {
          id: newId(),
          kind: 'adjustment',
          requestHash: requestHash('offline'),
          note: null,
          occurredAt: env.clock.now,
          origin: 'offline',
          deviceId: device.id,
          postedBy: shop.ownerUserId,
        },
        [
          {
            op: 'issue',
            partId: part,
            locationId: mainShop.id,
            quantity: 1,
            kind: 'adjustment',
            reason: 'lost',
          },
        ],
        m,
      );
    });
    expect((await cashier.get('/stock/review-items')).statusCode).toBe(403);
    const items = (await supervisor.get('/stock/review-items'))
      .json<ReviewItem[]>()
      .filter((i) => i.partId === part);
    expect(items.map((i) => [i.kind, i.quantity]).sort()).toEqual([
      ['cost_unknown', -1],
      ['negative_stock', -1],
    ]);
    const negative = items.find((i) => i.kind === 'negative_stock');
    const early = await supervisor.post(`/stock/review-items/${negative?.id ?? ''}/resolve`, {
      note: 'checked',
    });
    expect(errorCode(early)).toBe('stock.review_unresolved');
    await supervisor.post('/stock/adjustments', {
      id: newId(),
      locationId: mainShop.id,
      reason: 'found',
      lines: [{ partId: part, quantity: 1, unitCost: { amount: '7', currency: 'AAA' } }],
    });
    for (const item of items) {
      const res = await supervisor.post(`/stock/review-items/${item.id}/resolve`, {
        note: 'found on shelf',
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    const open = (await supervisor.get('/stock/review-items'))
      .json<ReviewItem[]>()
      .filter((i) => i.partId === part);
    expect(open).toEqual([]);
  });
});

describe('search shows quantities (ADR 0023)', () => {
  it('lists stock per location without cost, and offers alternatives in stock first', async () => {
    const tag = newId().slice(-6);
    const make = async (sku: string, grade: string) => {
      const res = await owner.post('/catalog/parts', {
        id: newId(),
        sku: `${sku}-${tag}`,
        nameEn: `Search stock ${sku}`,
        qualityGrade: grade,
      });
      return res.json<PartDetail>().id;
    };
    const base = await make('BASE', 'oem');
    const premium = await make('PRM', 'premium');
    const economy = await make('ECO', 'economy');
    const oemOut = await make('OEM', 'oem');
    for (const other of [premium, economy, oemOut]) {
      await owner.post(`/catalog/parts/${base}/interchange`, { partId: other });
    }
    const found = async (locationId: string, partId: string, quantity: number) => {
      const res = await owner.post('/stock/adjustments', {
        id: newId(),
        locationId,
        reason: 'found',
        lines: [{ partId, quantity, unitCost: { amount: '5.00', currency: 'AAA' } }],
      });
      expect(res.statusCode, res.body).toBe(200);
    };
    await found(storeroom.id, premium, 3);
    await found(mainShop.id, economy, 2);
    await found(storeroom.id, economy, 1);

    for (const client of [owner, cashier]) {
      const res = await client.get(`/catalog/search?q=${encodeURIComponent(`BASE-${tag}`)}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain('"cost"');
      const [top] = res.json<SearchResult>().results;
      expect(top?.stock).toEqual({ total: 0, locations: [] });
      // In stock first (premium before economy by grade), then the OEM part that is out.
      expect(top?.alternatives.map((a) => [a.part.sku, a.stock.total])).toEqual([
        [`PRM-${tag}`, 3],
        [`ECO-${tag}`, 3],
        [`OEM-${tag}`, 0],
      ]);
      const eco = top?.alternatives.find((a) => a.part.id === economy);
      expect(eco?.stock.locations.sort((a, b) => a.quantity - b.quantity)).toEqual([
        { locationId: storeroom.id, quantity: 1 },
        { locationId: mainShop.id, quantity: 2 },
      ]);
    }
  });
});
