import { withTenant } from '@autoparts/db';
import { newId } from '@autoparts/shared';
import type {
  Category,
  ImportBatchDetail,
  ImportMapping,
  ImportRow,
  InspectImportResult,
  PartDetail,
  PartSummary,
  PriceList,
  SearchResult,
} from '@autoparts/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { XlsxCell } from '../xlsx';
import { buildXlsx } from '../xlsx';
import type { Client, Shop } from './harness';
import { errorCode, loggedIn, provisionShop, setupEnv } from './harness';

const env = setupEnv();
let shop: Shop;
let owner: Client;
let retail: string;
let model: string;
let batteries: string;

const n = (v: string) => ({ n: v });
const HEADER: XlsxCell[] = [
  'S.N',
  'Column2',
  'P/NAME',
  'P/Name ',
  'Column1',
  'USD /JUBA',
  'Rate AR.D',
  'Qnty',
  'Total',
];
/** Synthetic rows shaped like the pilot shop's stock sheet (no real data). */
function landRows(pricePad = '17.855'): XlsxCell[][] {
  return [
    ['DEMO MOTORS CATALOG', null],
    [' LAND ', null, n('620')],
    HEADER,
    [
      n('1'),
      '33228-35030',
      'Filter , Oil',
      'مصفي زيت',
      'LC',
      n('25'),
      n('48.299999999999997'),
      n('1'),
      n('48.3'),
    ],
    [
      n('2'),
      '33228-35030',
      'Filter , Oil',
      'مصفي زيت',
      'lc',
      n('25'),
      n('48.3'),
      n('2'),
      n('96.6'),
    ],
    [
      n('3'),
      '04465-60320',
      'Pad, Front',
      'فحمات امامية',
      'LC',
      n(pricePad),
      n('40'),
      n('0'),
      n('0'),
    ],
    [n('4'), 'N70', 'Battery N70 MF', null, 'MF', n('0'), n('300'), n('3'), n('900')],
    [n('5'), 'N70', 'Battery N70 Solite', null, 'MF', n('95'), n('280'), n('1'), n('280')],
    [n('6'), null, 'Grease', 'شحم', '  ', null, n('10'), n('5'), n('50')],
    [n('7'), null, null, null, null, null, null, null, n('123456')],
    [n('8'), '90915-YZZD4', 'Filter, Oil', null, 'HILLUX 2018', n('7.5'), n('20'), n('4'), n('80')],
  ];
}
const file = (rows = landRows()) =>
  buildXlsx({
    LAND: rows,
    Private: [
      ['family', 'debts'],
      ['x', n('1')],
    ],
  }).toString('base64');

let mapping: ImportMapping;

beforeAll(async () => {
  shop = await provisionShop(env);
  owner = await loggedIn(env, shop);
  const list = await owner.post('/catalog/price-lists', {
    id: newId(),
    name: 'Retail',
    currency: 'AAA',
    isDefault: true,
  });
  retail = list.json<PriceList>().id;
  await owner.post('/currencies', { id: newId(), code: 'BBB', minorUnits: 2 });

  const platform = async (level: string, name: string, parentId: string | null) => {
    const id = newId();
    await env.ownerDb
      .transaction()
      .execute((trx) =>
        trx
          .insertInto('vehicles')
          .values({ id, tenant_id: null, parent_id: parentId, level, name })
          .execute(),
      );
    return id;
  };
  const type = await platform('type', `Car ${newId().slice(-6)}`, null);
  const make = await platform('make', 'Toyota', type);
  model = await platform('model', 'Land Cruiser', make);
  const cat = await owner.post('/catalog/categories', { id: newId(), nameEn: 'Batteries' });
  batteries = cat.json<Category>().id;

  mapping = {
    columns: {
      partNumber: 1,
      nameEn: 2,
      nameAr: 3,
      vehicleCode: 4,
      sellPrice: 5,
      cost: 6,
      quantity: 7,
    },
    numberKind: 'oem',
    priceListId: retail,
    costCurrency: 'BBB',
    skuPrefix: 'DM',
  };
});

const stage = (content = file(), m: ImportMapping = mapping) =>
  owner.post('/catalog/imports', {
    id: newId(),
    fileName: 'stock.xlsx',
    contentBase64: content,
    sheet: 'LAND',
    headerRow: 3,
    mapping: m,
  });

const rowsOf = async (client: Client, batchId: string, query = '') =>
  (await client.get(`/catalog/imports/${batchId}/rows${query}`)).json<ImportRow[]>();

describe('catalog import', () => {
  let batch: ImportBatchDetail;

  it('inspects a file without storing anything', async () => {
    const res = await owner.post('/catalog/imports/inspect', {
      fileName: 'stock.xlsx',
      contentBase64: file(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json<InspectImportResult>();
    expect(result.sheets.map((s) => [s.name, s.rowCount])).toEqual([
      ['LAND', 11],
      ['Private', 2],
    ]);
    expect(result.sheets[0]?.rows[2]).toEqual(HEADER);
    // Float artefacts are cut to Excel's 15 digits.
    expect(result.sheets[0]?.rows[3]?.[6]).toBe('48.3');
    const stored = await withTenant(env.ownerDb, shop.tenantId, (trx) =>
      trx.selectFrom('import_batches').select('id').execute(),
    );
    expect(stored).toEqual([]);
  });

  it('refuses files it cannot read and mappings that are incomplete', async () => {
    const bad = await owner.post('/catalog/imports/inspect', {
      fileName: 'stock.xls',
      contentBase64: Buffer.from('not a spreadsheet').toString('base64'),
    });
    expect(errorCode(bad)).toBe('import.unreadable_file');
    const noList = await stage(file(), { ...mapping, priceListId: null });
    expect(noList.statusCode).toBe(400);
    const missingSheet = await owner.post('/catalog/imports', {
      id: newId(),
      fileName: 'stock.xlsx',
      contentBase64: file(),
      sheet: 'Nope',
      headerRow: 3,
      mapping,
    });
    expect(errorCode(missingSheet)).toBe('import.sheet_not_found');
  });

  it('stages only the mapped columns of the chosen sheet and analyses the rows', async () => {
    const res = await stage();
    expect(res.statusCode, res.body).toBe(201);
    batch = res.json<ImportBatchDetail>();
    expect(batch.status).toBe('draft');
    expect(batch.vehicleCodes.map((c) => [c.codeNorm, c.rows, c.mapping])).toEqual([
      ['lc', 3, null],
      ['mf', 2, null],
      ['hillux 2018', 1, null],
    ]);
    expect(batch.stats?.byDecision).toEqual({ create: 6, merge: 1 });

    const raw = await withTenant(env.ownerDb, shop.tenantId, (trx) =>
      trx
        .selectFrom('import_rows')
        .select(['row_number', 'raw'])
        .where('batch_id', '=', batch.id)
        .orderBy('row_number')
        .execute(),
    );
    // Row 10 had only unmapped cells: not stored. No unmapped column is ever stored.
    expect(raw.map((r) => r.row_number)).toEqual([4, 5, 6, 7, 8, 9, 11]);
    expect(JSON.stringify(raw)).not.toContain('123456');
    expect(JSON.stringify(raw)).not.toContain('96.6');
    expect(Object.keys(raw[0]?.raw as object).sort()).toEqual(
      ['cost', 'nameAr', 'nameEn', 'partNumber', 'quantity', 'sellPrice', 'vehicleCode'].sort(),
    );

    const rows = await rowsOf(owner, batch.id);
    expect(rows.map((r) => [r.rowNumber, r.decision, r.issues])).toEqual([
      [4, 'create', ['vehicle_unmapped']],
      [5, 'merge', ['vehicle_unmapped', 'duplicate_row']],
      [6, 'create', ['price_rounded', 'vehicle_unmapped']],
      [7, 'create', ['zero_price', 'vehicle_unmapped', 'shared_number']],
      [8, 'create', ['vehicle_unmapped', 'shared_number']],
      [9, 'create', ['no_part_number', 'no_price']],
      [11, 'create', ['vehicle_unmapped']],
    ]);
    expect(rows[2]?.parsed).toMatchObject({
      sellPrice: '17.86',
      sellPriceRaw: '17.855',
      cost: '40',
    });
  });

  it('hides costs from an importer without cost.view', async () => {
    const roleId = newId();
    await owner.post('/roles', {
      id: roleId,
      code: 'importer',
      name: 'Importer',
      permissions: ['catalog.import'],
    });
    const userId = newId();
    await owner.post('/users', {
      id: userId,
      username: 'importer',
      displayName: 'Importer',
      password: 'importer passphrase',
    });
    await owner.post(`/users/${userId}/roles`, { roleId });
    const importer = await loggedIn(env, shop, 'importer', 'importer passphrase');
    const rows = await rowsOf(importer, batch.id);
    expect(rows.every((r) => !('cost' in r.parsed))).toBe(true);
    expect((await rowsOf(owner, batch.id))[0]?.parsed.cost).toBe('48.3');
  });

  it('maps vehicle codes through aliases, lets the user skip rows, then previews', async () => {
    const alias = (body: object) =>
      owner.post('/catalog/vehicle-aliases', { id: newId(), ...body });
    expect((await alias({ alias: 'LC', target: 'vehicle', vehicleId: model })).statusCode).toBe(
      201,
    );
    expect(
      (await alias({ alias: 'MF', target: 'category', categoryId: batteries })).statusCode,
    ).toBe(201);
    expect((await alias({ alias: 'HILLUX 2018', target: 'ignore' })).statusCode).toBe(201);

    const grease = (await rowsOf(owner, batch.id, '?issue=no_part_number'))[0];
    const skip = await owner.post(`/catalog/imports/${batch.id}/rows/skip`, {
      rowIds: [grease?.id],
      skipped: true,
    });
    expect(skip.statusCode, skip.body).toBe(200);

    const res = await owner.post(`/catalog/imports/${batch.id}/analyse`);
    expect(res.statusCode, res.body).toBe(200);
    const detail = res.json<ImportBatchDetail>();
    expect(detail.status).toBe('previewed');
    expect(detail.vehicleCodes.map((c) => [c.codeNorm, c.mapping?.target])).toEqual([
      ['lc', 'vehicle'],
      ['mf', 'category'],
      ['hillux 2018', 'ignore'],
    ]);
    expect(detail.stats?.byDecision).toEqual({ create: 5, merge: 1, skip: 1 });
    expect(detail.stats?.byIssue.vehicle_unmapped).toBeUndefined();
  });

  it('applies once: parts, numbers, fitments, categories, rounded prices, one audit entry', async () => {
    const res = await owner.post(`/catalog/imports/${batch.id}/apply`);
    expect(res.statusCode, res.body).toBe(200);
    const applied = res.json<ImportBatchDetail>();
    expect(applied.status).toBe('applied');
    // Five prices (a zero price is imported as 0.00); LC fitments for the filter and the pad.
    expect(applied.stats).toMatchObject({ pricesSet: 5, fitmentsAdded: 2 });

    const parts = (await owner.get('/catalog/parts?limit=50')).json<PartSummary[]>();
    expect(parts.map((p) => [p.sku, p.nameEn, p.qualityGrade])).toEqual([
      ['DM-00001', 'Filter , Oil', null],
      ['DM-00002', 'Pad, Front', null],
      ['DM-00003', 'Battery N70 MF', null],
      ['DM-00004', 'Battery N70 Solite', null],
      ['DM-00005', 'Filter, Oil', null],
    ]);
    const pad = (await owner.get(`/catalog/parts/${parts[1]?.id ?? ''}`)).json<PartDetail>();
    expect(pad.prices).toEqual([
      { priceListId: retail, current: { amount: '17.86', currency: 'AAA' } },
    ]);
    expect(pad.fitments.map((f) => f.path.slice(1))).toEqual([['Toyota', 'Land Cruiser']]);
    expect(pad.numbers.map((x) => [x.number, x.kind])).toEqual([['04465-60320', 'oem']]);
    const battery = (await owner.get(`/catalog/parts/${parts[2]?.id ?? ''}`)).json<PartDetail>();
    expect(battery.categoryId).toBe(batteries);
    // A zero price is imported as given (and was flagged in the preview).
    expect(battery.prices[0]?.current).toEqual({ amount: '0.00', currency: 'AAA' });

    const links = await rowsOf(owner, batch.id);
    expect(links[0]?.partId).toBe(parts[0]?.id);
    expect(links[1]?.partId).toBe(parts[0]?.id);
    const audits = await withTenant(env.ownerDb, shop.tenantId, (trx) =>
      trx.selectFrom('audit_log').select('after').where('action', '=', 'catalog.import').execute(),
    );
    expect(audits).toHaveLength(1);

    const search = (
      await owner.get(`/catalog/search?q=${encodeURIComponent('pad lc')}`)
    ).json<SearchResult>();
    expect(search.results.map((r) => r.part.sku)).toEqual(['DM-00002']);
    const n70 = (await owner.get('/catalog/search?q=N70%20battery')).json<SearchResult>();
    expect(n70.results[0]?.alternatives.map((a) => a.relation)).toEqual(['shared_number']);
  });

  it('is idempotent: the same file cannot be imported twice and a batch applies once', async () => {
    const again = await stage();
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('import.already_applied');
    const twice = await owner.post(`/catalog/imports/${batch.id}/apply`);
    expect(errorCode(twice)).toBe('import.not_editable');
  });

  it('updates prices of parts from earlier imports instead of duplicating them', async () => {
    const res = await stage(file(landRows('19')));
    expect(res.statusCode, res.body).toBe(201);
    const next = res.json<ImportBatchDetail>();
    expect(next.stats?.byDecision).toEqual({ update: 5, merge: 1, create: 1 });
    const rows = await rowsOf(owner, next.id, '?decision=update');
    expect(rows.every((r) => r.issues.includes('existing_part'))).toBe(true);

    const applied = (
      await owner.post(`/catalog/imports/${next.id}/apply`)
    ).json<ImportBatchDetail>();
    // Only the changed price is appended; fitments already present are not repeated.
    expect(applied.stats).toMatchObject({ pricesSet: 1, fitmentsAdded: 0 });
    const parts = (await owner.get('/catalog/parts?limit=50')).json<PartSummary[]>();
    // The skipped grease row of the first import is new this time.
    expect(parts.map((p) => p.sku)).toEqual([
      'DM-00001',
      'DM-00002',
      'DM-00003',
      'DM-00004',
      'DM-00005',
      'DM-00006',
    ]);
    const history = await owner.get(`/catalog/parts/${parts[1]?.id ?? ''}/prices`);
    expect(
      history.json<{ price: string; source: string }[]>().map((h) => [h.price, h.source]),
    ).toEqual([
      ['19.00', 'import'],
      ['17.86', 'import'],
    ]);
  });

  it('discards a staged batch, which then cannot be applied, and isolates tenants', async () => {
    const staged = (await stage(file(landRows('21')))).json<ImportBatchDetail>();
    const other = await provisionShop(env);
    const otherOwner = await loggedIn(env, other);
    expect((await otherOwner.get(`/catalog/imports/${staged.id}`)).statusCode).toBe(404);
    expect((await otherOwner.post(`/catalog/imports/${staged.id}/apply`)).statusCode).toBe(404);

    const discarded = await owner.post(`/catalog/imports/${staged.id}/discard`);
    expect(discarded.json<ImportBatchDetail>().status).toBe('discarded');
    expect(errorCode(await owner.post(`/catalog/imports/${staged.id}/apply`))).toBe(
      'import.not_editable',
    );
    const list = (await owner.get('/catalog/imports')).json<{ status: string }[]>();
    expect(list.map((b) => b.status)).toEqual(['discarded', 'applied', 'applied']);
  });

  it('reads CSV files too', async () => {
    const csv = 'number,name,price\n"04465-60320","Pad, Rear","12.5"\n';
    const res = await owner.post('/catalog/imports/inspect', {
      fileName: 'rear.csv',
      contentBase64: Buffer.from(csv).toString('base64'),
    });
    expect(res.json<InspectImportResult>().sheets).toEqual([
      {
        name: 'rear',
        rowCount: 2,
        columnCount: 3,
        tooLarge: false,
        rows: [
          ['number', 'name', 'price'],
          ['04465-60320', 'Pad, Rear', '12.5'],
        ],
      },
    ]);
  });
});
