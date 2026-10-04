import { withTenant } from '@autoparts/db';
import { newId } from '@autoparts/shared';
import type {
  Brand,
  PartDetail,
  PartSummary,
  PriceEntry,
  PriceList,
  SearchResult,
  Vehicle,
} from '@autoparts/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Client, Shop } from './harness';
import { MINUTE, errorCode, loggedIn, provisionShop, setupEnv } from './harness';

const env = setupEnv();
let shop: Shop;
let owner: Client;
let otherShop: Shop;
let otherOwner: Client;

// Platform vehicle tree (written by operator tooling, i.e. the owner DB role).
let make: string;
let model: string;
let gen2008: string;
let gen2022: string;
let retailList: string;

async function platformVehicle(
  level: string,
  name: string,
  parentId: string | null,
  extra: { name_ar?: string; year_from?: number; year_to?: number } = {},
) {
  const id = newId();
  await env.ownerDb.transaction().execute((trx) =>
    trx
      .insertInto('vehicles')
      .values({ id, tenant_id: null, parent_id: parentId, level, name, ...extra })
      .execute(),
  );
  return id;
}

async function createPart(
  client: Client,
  sku: string,
  fields: {
    nameAr?: string;
    nameEn?: string;
    qualityGrade?: string | null;
    numbers?: { number: string; kind?: string }[];
  } = {},
): Promise<PartDetail> {
  const res = await client.post('/catalog/parts', {
    id: newId(),
    sku,
    nameEn: fields.nameEn ?? (fields.nameAr === undefined ? sku : undefined),
    nameAr: fields.nameAr,
    qualityGrade: fields.qualityGrade ?? null,
    numbers: (fields.numbers ?? []).map((n) => ({
      id: newId(),
      number: n.number,
      kind: n.kind ?? 'oem',
    })),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<PartDetail>();
}

async function fit(client: Client, partId: string, vehicleId: string) {
  const res = await client.post(`/catalog/parts/${partId}/fitments`, {
    id: newId(),
    vehicleId,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<PartDetail>();
}

async function setPrice(client: Client, listId: string, partId: string, price: string) {
  const res = await client.post(`/catalog/price-lists/${listId}/prices`, {
    id: newId(),
    partId,
    price,
  });
  expect(res.statusCode, res.body).toBe(201);
}

const auditOf = (tenantId: string, action: string) =>
  withTenant(env.ownerDb, tenantId, (trx) =>
    trx.selectFrom('audit_log').selectAll().where('action', '=', action).execute(),
  );

beforeAll(async () => {
  shop = await provisionShop(env);
  owner = await loggedIn(env, shop);
  otherShop = await provisionShop(env);
  otherOwner = await loggedIn(env, otherShop);

  const type = await platformVehicle('type', `Car ${newId().slice(-6)}`, null);
  make = await platformVehicle('make', 'Toyota', type);
  model = await platformVehicle('model', 'Land Cruiser', make, { name_ar: 'لاندكروزر' });
  gen2008 = await platformVehicle('generation', 'J200', model, { year_from: 2008, year_to: 2021 });
  gen2022 = await platformVehicle('generation', 'J300', model, { year_from: 2022 });

  const list = await owner.post('/catalog/price-lists', {
    id: newId(),
    name: 'Retail',
    currency: 'AAA',
    isDefault: true,
  });
  expect(list.statusCode, list.body).toBe(201);
  retailList = list.json<PriceList>().id;
});

describe('vehicle tree and taxonomy', () => {
  it('shows platform rows to every tenant and keeps local additions private', async () => {
    const models = (await owner.get(`/catalog/vehicles?parentId=${make}`)).json<Vehicle[]>();
    expect(models.map((v) => [v.name, v.isLocal])).toEqual([['Land Cruiser', false]]);

    const local = await owner.post('/catalog/vehicles', {
      id: newId(),
      parentId: model,
      level: 'generation',
      name: 'LC79',
      yearFrom: 2007,
    });
    expect(local.statusCode, local.body).toBe(201);
    expect(local.json<Vehicle>().isLocal).toBe(true);

    const mine = (await owner.get(`/catalog/vehicles?parentId=${model}`)).json<Vehicle[]>();
    expect(mine.map((v) => v.name)).toEqual(['J200', 'J300', 'LC79']);
    const theirs = (await otherOwner.get(`/catalog/vehicles?parentId=${model}`)).json<Vehicle[]>();
    expect(theirs.map((v) => v.name)).toEqual(['J200', 'J300']);

    const found = (await owner.get('/catalog/vehicles?q=لاندكروزر')).json<Vehicle[]>();
    expect(found.map((v) => v.id)).toContain(model);
    expect(await auditOf(shop.tenantId, 'vehicle.create')).toHaveLength(1);
  });

  it('refuses to edit a platform row but edits the tenant own row', async () => {
    expect((await owner.patch(`/catalog/vehicles/${model}`, { name: 'X' })).statusCode).toBe(404);
    const id = newId();
    await owner.post('/catalog/vehicles', { id, parentId: make, level: 'model', name: 'Hilux' });
    const res = await owner.patch(`/catalog/vehicles/${id}`, { name: 'Hilux Vigo' });
    expect(res.statusCode).toBe(200);
    expect(res.json<Vehicle>().name).toBe('Hilux Vigo');
    // Another tenant cannot see or edit it.
    expect((await otherOwner.patch(`/catalog/vehicles/${id}`, { name: 'Y' })).statusCode).toBe(404);
  });

  it('creates brands and rejects an alias whose target does not match its fields', async () => {
    const brand = await owner.post('/catalog/brands', {
      id: newId(),
      name: 'Toyota Genuine',
      kind: 'vehicle_maker',
    });
    expect(brand.statusCode).toBe(201);
    expect((await owner.get('/catalog/brands')).json<Brand[]>().map((b) => b.name)).toEqual([
      'Toyota Genuine',
    ]);
    expect((await otherOwner.get('/catalog/brands')).json<Brand[]>()).toEqual([]);

    const bad = await owner.post('/catalog/vehicle-aliases', {
      id: newId(),
      alias: 'LC',
      target: 'category',
      vehicleId: model,
    });
    expect(bad.statusCode).toBe(400);
    const ok = await owner.post('/catalog/vehicle-aliases', {
      id: newId(),
      alias: 'LC',
      target: 'vehicle',
      vehicleId: model,
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });
});

describe('parts', () => {
  it('creates a part with numbers, rejects a case-insensitive duplicate SKU and v4 ids', async () => {
    const part = await createPart(owner, 'FLT-001', {
      nameEn: 'Oil filter',
      numbers: [{ number: '90915-YZZD4' }],
    });
    expect(part.numbers.map((n) => [n.number, n.numberNorm])).toEqual([
      ['90915-YZZD4', '90915YZZD4'],
    ]);
    const dup = await owner.post('/catalog/parts', { id: newId(), sku: 'flt-001', nameEn: 'X' });
    expect(dup.statusCode).toBe(409);
    const v4 = await owner.post('/catalog/parts', {
      id: '0b4fd1b6-7f1b-4b4f-8a4e-0e7c1d2a3b4c',
      sku: 'FLT-002',
      nameEn: 'X',
    });
    expect(v4.statusCode).toBe(400);
    expect(await auditOf(shop.tenantId, 'part.create')).toHaveLength(1);
  });

  it('lists the "needs review" queue and bulk-grades it', async () => {
    const a = await createPart(owner, 'REV-A', { nameEn: 'Review A' });
    const b = await createPart(owner, 'REV-B', { nameEn: 'Review B' });
    const ungraded = (await owner.get('/catalog/parts?needsReview=ungraded&q=review')).json<
      PartSummary[]
    >();
    expect(ungraded.map((p) => p.sku)).toEqual(['REV-A', 'REV-B']);

    const res = await owner.post('/catalog/parts/bulk-update', {
      ids: [a.id, b.id],
      set: { qualityGrade: 'good' },
    });
    expect(res.json()).toEqual({ updated: 2 });
    expect(
      (await owner.get('/catalog/parts?needsReview=ungraded&q=review')).json<PartSummary[]>(),
    ).toEqual([]);
    const noFitment = (await owner.get('/catalog/parts?needsReview=no_fitment&q=review')).json<
      PartSummary[]
    >();
    expect(noFitment).toHaveLength(2);

    const page1 = (await owner.get('/catalog/parts?q=review&limit=1')).json<PartSummary[]>();
    const page2 = (await owner.get('/catalog/parts?q=review&limit=1&after=REV-A')).json<
      PartSummary[]
    >();
    expect([page1[0]?.sku, page2[0]?.sku]).toEqual(['REV-A', 'REV-B']);
  });

  it('archives instead of deleting, and hides archived parts by default', async () => {
    const p = await createPart(owner, 'ARC-1', { nameEn: 'Archive me' });
    expect((await owner.patch(`/catalog/parts/${p.id}`, { archived: true })).statusCode).toBe(200);
    expect((await owner.get('/catalog/parts?q=archive')).json<PartSummary[]>()).toEqual([]);
    const all = (await owner.get('/catalog/parts?q=archive&includeArchived=true')).json<
      PartSummary[]
    >();
    expect(all.map((x) => x.sku)).toEqual(['ARC-1']);
  });

  it('merges interchange groups when linking parts from two groups', async () => {
    const [a, b, c, d] = await Promise.all(
      ['IX-A', 'IX-B', 'IX-C', 'IX-D'].map((sku) => createPart(owner, sku)),
    );
    if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error();
    await owner.post(`/catalog/parts/${a.id}/interchange`, { partId: b.id });
    await owner.post(`/catalog/parts/${c.id}/interchange`, { partId: d.id });
    const merged = await owner.post(`/catalog/parts/${b.id}/interchange`, { partId: c.id });
    expect(merged.json<PartDetail>().interchange.map((p) => p.sku)).toEqual([
      'IX-A',
      'IX-C',
      'IX-D',
    ]);
    const unlink = await owner.post(`/catalog/parts/${d.id}/interchange/remove`);
    expect(unlink.json<PartDetail>().interchange).toEqual([]);
    const a2 = (await owner.get(`/catalog/parts/${a.id}`)).json<PartDetail>();
    expect(a2.interchange.map((p) => p.sku)).toEqual(['IX-B', 'IX-C']);
  });

  it('supersedes a part, copies its fitments, and refuses a cycle', async () => {
    const old = await createPart(owner, 'SUP-001');
    const replacement = await createPart(owner, 'SUP-002');
    await fit(owner, old.id, gen2008);
    const res = await owner.post(`/catalog/parts/${old.id}/supersede`, {
      id: newId(),
      newPartId: replacement.id,
      reason: 'maker change',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<PartDetail>().supersededBy?.sku).toBe('SUP-002');
    const after = (await owner.get(`/catalog/parts/${replacement.id}`)).json<PartDetail>();
    expect(after.supersedes.map((p) => p.sku)).toEqual(['SUP-001']);
    expect(after.fitments.map((f) => f.path.slice(1))).toEqual([
      ['Toyota', 'Land Cruiser', 'J200'],
    ]);

    const cycle = await owner.post(`/catalog/parts/${replacement.id}/supersede`, {
      id: newId(),
      newPartId: old.id,
    });
    expect(cycle.statusCode).toBe(400);
  });
});

describe('prices', () => {
  it('appends price changes, formats them at the currency minor units, and audits them', async () => {
    const p = await createPart(owner, 'PRC-1');
    await setPrice(owner, retailList, p.id, '12.5');
    await setPrice(owner, retailList, p.id, '14.00');

    const detail = (await owner.get(`/catalog/parts/${p.id}`)).json<PartDetail>();
    expect(detail.prices).toEqual([
      { priceListId: retailList, current: { amount: '14.00', currency: 'AAA' } },
    ]);
    const history = (await owner.get(`/catalog/parts/${p.id}/prices`)).json<PriceEntry[]>();
    expect(history.map((h) => [h.price, h.source, h.recordedBy])).toEqual([
      ['14.00', 'manual', shop.ownerUserId],
      ['12.50', 'manual', shop.ownerUserId],
    ]);
    const entries = (await auditOf(shop.tenantId, 'price.set')).filter((e) => e.entity_id === p.id);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => [e.before, e.after])).toEqual(
      expect.arrayContaining([
        [{ priceListId: retailList, price: null }, expect.objectContaining({ price: '12.50' })],
        [{ priceListId: retailList, price: '12.50' }, expect.objectContaining({ price: '14.00' })],
      ]),
    );
  });

  it('rejects a price finer than the currency allows, a negative one, and back-dating', async () => {
    const p = await createPart(owner, 'PRC-2');
    const post = (body: object) =>
      owner.post(`/catalog/price-lists/${retailList}/prices`, {
        id: newId(),
        partId: p.id,
        ...body,
      });
    expect((await post({ price: '1.005' })).statusCode).toBe(400);
    expect((await post({ price: '-1.00' })).statusCode).toBe(400);
    const past = new Date(env.clock.now.getTime() - MINUTE).toISOString();
    expect((await post({ price: '1.00', effectiveAt: past })).statusCode).toBe(400);
    expect((await owner.get(`/catalog/parts/${p.id}/prices`)).json()).toEqual([]);
  });

  it('applies a scheduled price only once it takes effect', async () => {
    const p = await createPart(owner, 'PRC-3');
    await setPrice(owner, retailList, p.id, '10.00');
    const at = new Date(env.clock.now.getTime() + 10 * MINUTE).toISOString();
    const res = await owner.post(`/catalog/price-lists/${retailList}/prices`, {
      id: newId(),
      partId: p.id,
      price: '11.00',
      effectiveAt: at,
    });
    expect(res.statusCode).toBe(201);
    const current = async () =>
      (await owner.get(`/catalog/parts/${p.id}`)).json<PartDetail>().prices[0]?.current?.amount;
    expect(await current()).toBe('10.00');
    env.clock.advance(10 * MINUTE);
    expect(await current()).toBe('11.00');
  });

  it('keeps one default list per currency and takes no prices on an archived list', async () => {
    const extra = newId();
    expect(
      (await owner.post('/currencies', { id: newId(), code: 'BBB', minorUnits: 0 })).statusCode,
    ).toBe(201);
    const first = (
      await owner.post('/catalog/price-lists', {
        id: extra,
        name: 'BBB retail',
        currency: 'BBB',
        isDefault: true,
      })
    ).json<PriceList>();
    const second = (
      await owner.post('/catalog/price-lists', {
        id: newId(),
        name: 'BBB promo',
        currency: 'BBB',
        isDefault: true,
      })
    ).json<PriceList>();
    const lists = (await owner.get('/catalog/price-lists')).json<PriceList[]>();
    expect(lists.filter((l) => l.currency === 'BBB').map((l) => [l.name, l.isDefault])).toEqual([
      ['BBB promo', true],
      ['BBB retail', false],
    ]);
    expect(first.isDefault).toBe(true);

    const p = await createPart(owner, 'PRC-4');
    // Zero minor units: whole amounts only.
    expect(
      (
        await owner.post(`/catalog/price-lists/${second.id}/prices`, {
          id: newId(),
          partId: p.id,
          price: '1500.5',
        })
      ).statusCode,
    ).toBe(400);
    await setPrice(owner, second.id, p.id, '1500');
    await owner.patch(`/catalog/price-lists/${second.id}`, { archived: true });
    const res = await owner.post(`/catalog/price-lists/${second.id}/prices`, {
      id: newId(),
      partId: p.id,
      price: '1600',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('search (BRIEF scenario 1)', () => {
  let pads: PartDetail;
  let premium: PartDetail;
  let good: PartDetail;
  let economy: PartDetail;
  let ungraded: PartDetail;
  let newerOnly: PartDetail;

  beforeAll(async () => {
    const oem = [{ number: '04465-60320' }];
    pads = await createPart(owner, 'BP-OEM', {
      nameAr: 'فحمات أمامية',
      nameEn: 'Front brake pads',
      qualityGrade: 'oem',
      numbers: oem,
    });
    await fit(owner, pads.id, gen2008);
    premium = await createPart(owner, 'BP-PRM', {
      nameEn: 'Brake pad set',
      qualityGrade: 'premium',
    });
    good = await createPart(owner, 'BP-GD', {
      nameEn: 'Brake pad set',
      qualityGrade: 'good',
      numbers: oem,
    });
    economy = await createPart(owner, 'BP-ECO', {
      nameEn: 'Brake pad set',
      qualityGrade: 'economy',
    });
    ungraded = await createPart(owner, 'BP-UNG', { nameEn: 'Brake pad set', numbers: oem });
    const archived = await createPart(owner, 'BP-ARC', {
      nameEn: 'Brake pad set',
      qualityGrade: 'oem',
      numbers: oem,
    });
    await owner.patch(`/catalog/parts/${archived.id}`, { archived: true });
    newerOnly = await createPart(owner, 'BP-J300', {
      nameAr: 'فحمات امامية',
      qualityGrade: 'oem',
    });
    await fit(owner, newerOnly.id, gen2022);

    await owner.post(`/catalog/parts/${pads.id}/interchange`, { partId: premium.id });
    await owner.post(`/catalog/parts/${pads.id}/interchange`, { partId: economy.id });
    for (const [part, price] of [
      [pads, '85.00'],
      [premium, '60.00'],
      [good, '40.00'],
      [economy, '25.00'],
      [ungraded, '10.00'],
    ] as const) {
      await setPrice(owner, retailList, part.id, price);
    }
  });

  const search = async (client: Client, q: string) => {
    const res = await client.get(`/catalog/search?q=${encodeURIComponent(q)}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<SearchResult>();
  };

  it('finds front pads for a 2015 Land Cruiser, with alternatives by grade then price', async () => {
    const result = await search(owner, 'فحمات امامية لاندكروزر 2015');
    expect(result.interpretation.year).toBe(2015);
    expect(result.interpretation.vehicles.map((v) => v.id)).toEqual([model]);
    expect(result.results.map((r) => r.part.sku)).toEqual(['BP-OEM']);
    const [top] = result.results;
    expect(top?.matchedBy).toBe('text');
    expect(top?.price).toEqual({ amount: '85.00', currency: 'AAA' });
    expect(top?.alternatives.map((a) => [a.part.sku, a.relation, a.price?.amount])).toEqual([
      ['BP-PRM', 'interchange', '60.00'],
      ['BP-GD', 'shared_number', '40.00'],
      ['BP-ECO', 'interchange', '25.00'],
      ['BP-UNG', 'shared_number', '10.00'],
    ]);
  });

  it('uses the year to pick the generation and recognises a tenant alias', async () => {
    const newer = await search(owner, 'فحمات امامية لاندكروزر 2023');
    expect(newer.results.map((r) => r.part.sku)).toEqual(['BP-J300']);
    const viaAlias = await search(owner, 'lc 2015 فحمات');
    expect(viaAlias.results.map((r) => r.part.sku)).toEqual(['BP-OEM']);
  });

  it('matches part numbers in any spelling and never returns archived parts', async () => {
    const result = await search(owner, '04465 60320');
    expect(result.interpretation.partNumber).toBe('0446560320');
    expect(result.results.map((r) => r.part.sku).sort()).toEqual(['BP-GD', 'BP-OEM', 'BP-UNG']);
    expect(result.results.every((r) => r.matchedBy === 'number')).toBe(true);
    const prefix = await search(owner, '04465-6');
    expect(prefix.results.map((r) => r.part.sku).sort()).toEqual(['BP-GD', 'BP-OEM', 'BP-UNG']);
  });

  it('offers the replacement of a superseded part', async () => {
    const result = await search(owner, 'SUP-001');
    expect(result.results[0]?.alternatives.map((a) => [a.part.sku, a.relation])).toEqual([
      ['SUP-002', 'replacement'],
    ]);
  });

  it('is open to any signed-in user and sees only the caller tenant', async () => {
    const other = await search(otherOwner, 'فحمات امامية لاندكروزر 2015');
    expect(other.results).toEqual([]);
    expect((await search(otherOwner, '04465 60320')).results).toEqual([]);
  });
});

describe('tenant isolation through the API', () => {
  it('cannot read, price, fit or link another tenant part', async () => {
    const theirs = await createPart(otherOwner, 'THEIRS-1');
    const mine = await createPart(owner, 'MINE-1');
    expect((await owner.get(`/catalog/parts/${theirs.id}`)).statusCode).toBe(404);
    expect((await owner.get(`/catalog/parts/${theirs.id}/prices`)).statusCode).toBe(404);
    const price = await owner.post(`/catalog/price-lists/${retailList}/prices`, {
      id: newId(),
      partId: theirs.id,
      price: '1.00',
    });
    expect(price.statusCode).toBe(404);
    const link = await owner.post(`/catalog/parts/${mine.id}/interchange`, { partId: theirs.id });
    expect(link.statusCode).toBe(404);
    expect(errorCode(link)).toBe('resource.not_found');

    // A local vehicle of this tenant is invisible to the other tenant's fitments.
    const local = newId();
    await owner.post('/catalog/vehicles', {
      id: local,
      parentId: model,
      level: 'generation',
      name: 'Private gen',
    });
    const fitRes = await otherOwner.post(`/catalog/parts/${theirs.id}/fitments`, {
      id: newId(),
      vehicleId: local,
    });
    expect(fitRes.statusCode).toBe(404);
    expect(
      (
        await otherOwner.post(`/catalog/price-lists/${retailList}/prices`, {
          id: newId(),
          partId: theirs.id,
          price: '1.00',
        })
      ).statusCode,
    ).toBe(404);
  });
});
